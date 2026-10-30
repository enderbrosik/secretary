import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dailyJobDue, localDate } from '@secretary/core';
import { schema } from '@secretary/db';
import { getConnector } from '@secretary/integrations';
import { getOAuthCredentials } from '../services/oauth-apps.js';
import type { Deps } from '../lib/context.js';
import { requireUser, revokeSessions, SESSION_COOKIE } from '../lib/auth.js';
import { verifyPassword } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { tokenPurpose } from '../services/sync.js';

export async function systemRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/health', async () => {
    await deps.db.execute(sql`select 1`);
    return { ok: true, time: deps.now().toISOString(), localMode: deps.config.LOCAL_MODE };
  });

  /** Automation status, including the next scheduled run of each daily job. */
  app.get('/api/automations', async (req) => {
    const user = requireUser(req);
    const s = await getSettings(deps, user.id);
    const now = deps.now();
    const b = dailyJobDue(s.briefingTime, s.timezone, now);
    const r = dailyJobDue(s.reviewTime, s.timezone, now);
    const [lb] = await deps.db.select().from(schema.jobs).where(and(eq(schema.jobs.userId, user.id), eq(schema.jobs.type, 'briefing'))).orderBy(desc(schema.jobs.createdAt)).limit(1);
    const [lr] = await deps.db.select().from(schema.jobs).where(and(eq(schema.jobs.userId, user.id), eq(schema.jobs.type, 'review'))).orderBy(desc(schema.jobs.createdAt)).limit(1);
    return {
      jobsEnabled: deps.config.JOBS_ENABLED,
      paused: s.automations.paused,
      automations: s.automations,
      nextBriefing: b.due ? b.scheduledFor.plus({ days: 1 }).toISO() : b.scheduledFor.toISO(),
      nextReview: r.due ? r.scheduledFor.plus({ days: 1 }).toISO() : r.scheduledFor.toISO(),
      lastBriefingJob: lb ? { status: lb.status, at: lb.finishedAt ?? lb.createdAt, error: lb.lastError } : null,
      lastReviewJob: lr ? { status: lr.status, at: lr.finishedAt ?? lr.createdAt, error: lr.lastError } : null,
      today: localDate(now, s.timezone),
    };
  });

  app.get('/api/jobs/runs', async (req) => {
    const user = requireUser(req);
    return deps.db.select().from(schema.jobRuns).where(eq(schema.jobRuns.userId, user.id)).orderBy(desc(schema.jobRuns.createdAt)).limit(100);
  });

  app.get('/api/audit', async (req) => {
    const user = requireUser(req);
    return deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, user.id)).orderBy(desc(schema.auditLog.createdAt)).limit(200);
  });

  /** Data the selected AI provider receives, so users can make an informed choice. */
  app.get('/api/privacy/ai-data', async () => ({
    sent: [
      'Titles, times and attendee names of calendar events in a short window around today, and event descriptions (truncated).',
      'Sender, subject and the newest message text of recent inbox threads that look important (truncated; full bodies can be turned off in Settings → AI).',
      'Text of Slack direct messages and messages that mention you from the last two days.',
      'Your confirmed tasks with priority, due date and status.',
      'Your name, timezone and assistant preferences.',
    ],
    neverSent: ['Passwords, API keys or OAuth tokens', 'Attachments', 'Messages outside the sync window', 'Data from integrations you disconnected'],
    note: 'Data is sent directly from this server to the provider you chose, under that provider’s API terms and data-retention policy. API usage is billed by the provider to your account.',
  }));

  /** Full export of the user's data (no secrets). */
  app.get('/api/data/export', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    const by = <T extends { userId: unknown }>(t: T) => t;
    void by;
    const [settings, tasks, projects, items, briefings, reviews, chats, actions, connections, audits] = await Promise.all([
      getSettings(deps, user.id),
      deps.db.select().from(schema.tasks).where(eq(schema.tasks.userId, user.id)),
      deps.db.select().from(schema.projects).where(eq(schema.projects.userId, user.id)),
      deps.db.select().from(schema.items).where(eq(schema.items.userId, user.id)),
      deps.db.select().from(schema.briefings).where(eq(schema.briefings.userId, user.id)),
      deps.db.select().from(schema.reviews).where(eq(schema.reviews.userId, user.id)),
      deps.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.userId, user.id)),
      deps.db.select().from(schema.pendingActions).where(eq(schema.pendingActions.userId, user.id)),
      deps.db.select({ provider: schema.connections.provider, accountLabel: schema.connections.accountLabel, scopes: schema.connections.scopes, tier: schema.connections.tier, createdAt: schema.connections.createdAt }).from(schema.connections).where(eq(schema.connections.userId, user.id)),
      deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, user.id)),
    ]);
    await audit(deps, user.id, 'data.exported', { ip: req.ip });
    reply.header('content-disposition', `attachment; filename="secretary-export-${localDate(deps.now(), settings.timezone)}.json"`);
    return { exportedAt: deps.now().toISOString(), user: { email: user.email, displayName: user.displayName }, settings, tasks, projects, items: items.map(({ searchText: _s, ...rest }) => rest), briefings, reviews, chats, actions, connections, audit: audits };
  });

  /** Deletes all synced data (emails, events, messages) while keeping the account and connections. */
  app.delete('/api/data/synced', async (req) => {
    const user = requireUser(req);
    await deps.db.delete(schema.items).where(eq(schema.items.userId, user.id));
    await deps.db.delete(schema.briefings).where(eq(schema.briefings.userId, user.id));
    await deps.db.delete(schema.chatMessages).where(eq(schema.chatMessages.userId, user.id));
    await audit(deps, user.id, 'data.synced_deleted', { ip: req.ip });
    return { ok: true };
  });

  /** Permanently deletes the account: revokes integrations, then removes every row (cascades). */
  app.delete('/api/account', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ password: z.string().min(1), confirm: z.literal('DELETE') }), req.body);
    const [u] = await deps.db.select().from(schema.users).where(eq(schema.users.id, user.id));
    if (!u || !(await verifyPassword(body.password, u.passwordHash))) throw new AppError(400, 'wrong_password', 'Password is incorrect');
    const conns = await deps.db.select().from(schema.connections).where(eq(schema.connections.userId, user.id));
    for (const c of conns) {
      const connector = getConnector(c.provider);
      if (c.encryptedTokens && connector?.revoke) {
        await connector.revoke(JSON.parse(deps.keys.decrypt(user, tokenPurpose(c), c.encryptedTokens)), (await getOAuthCredentials(deps, c.provider)) ?? { clientId: '', clientSecret: '' }).catch(() => undefined);
      }
    }
    await revokeSessions(deps, user.id);
    await deps.db.delete(schema.users).where(eq(schema.users.id, user.id));
    await deps.db.delete(schema.auditLog).where(eq(schema.auditLog.userId, user.id));
    deps.keys.forget(user.id);
    deps.log.info({ userId: user.id }, 'account deleted');
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
