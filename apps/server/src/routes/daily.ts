import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  buildBriefingContext,
  EMAIL_CATEGORIES,
  emailSignals,
  findConflicts,
  localDate,
  messageSignals,
  type Briefing,
  type EmailItem,
  type EventItem,
  type MessageItem,
  type Review,
} from '@secretary/core';
import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';
import { requireUser } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { toItem } from '../lib/mappers.js';
import { parse } from '../lib/validate.js';
import { approveAction, createAction, listActions, rejectAction } from '../services/actions.js';
import { draftReply, listThreads, streamAssistant, threadMessages } from '../services/assistant.js';
import { audit } from '../services/audit.js';
import { generateBriefing, latestBriefing } from '../services/briefing.js';
import { generateReview, listReviews } from '../services/review.js';
import { getSettings, toPreferences } from '../services/settings.js';
import { loadWorkspace } from '../services/workspace.js';

const dateParam = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const heavy = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export async function dailyRoutes(app: FastifyInstance, deps: Deps) {
  // ---- briefings ------------------------------------------------------------
  app.get('/api/briefings/today', async (req) => {
    const user = requireUser(req);
    const s = await getSettings(deps, user.id);
    const row = await latestBriefing(deps, user.id, localDate(deps.now(), s.timezone));
    return { briefing: (row?.content as Briefing) ?? null, updatedAt: row?.updatedAt ?? null };
  });
  app.get('/api/briefings', async (req) => {
    const user = requireUser(req);
    const rows = await deps.db.select({ date: schema.briefings.date, mode: schema.briefings.mode, updatedAt: schema.briefings.updatedAt }).from(schema.briefings).where(eq(schema.briefings.userId, user.id)).orderBy(desc(schema.briefings.date)).limit(60);
    return rows;
  });
  app.get('/api/briefings/:date', async (req) => {
    const user = requireUser(req);
    const { date } = dateParam.parse(req.params);
    const row = await latestBriefing(deps, user.id, date);
    if (!row) throw notFound('Briefing');
    return { briefing: row.content as Briefing, updatedAt: row.updatedAt };
  });
  app.post('/api/briefings/generate', { config: heavy }, async (req) => {
    const user = requireUser(req);
    const trigger = parse(z.object({ trigger: z.enum(['manual', 'onboarding']).default('manual') }), req.body ?? {}).trigger;
    return { briefing: await generateBriefing(deps, user.id, trigger) };
  });

  // ---- reviews --------------------------------------------------------------
  app.get('/api/reviews', async (req) => {
    const user = requireUser(req);
    const rows = await listReviews(deps, user.id);
    return rows.map((r) => {
      const c = r.content as Review;
      return { date: r.date, mode: r.mode, summary: c.summary, completed: c.accomplishments.completedTasks.length, carryOver: c.unfinished.carryOver.length, corrections: (r.corrections as unknown[]).length };
    });
  });
  app.get('/api/reviews/:date', async (req) => {
    const user = requireUser(req);
    const { date } = dateParam.parse(req.params);
    const [r] = await deps.db.select().from(schema.reviews).where(and(eq(schema.reviews.userId, user.id), eq(schema.reviews.date, date)));
    if (!r) throw notFound('Review');
    return { review: r.content as Review, corrections: r.corrections, updatedAt: r.updatedAt };
  });
  app.post('/api/reviews/generate', { config: heavy }, async (req) => ({ review: await generateReview(deps, requireUser(req).id) }));

  /** User corrections: update the real task, and record the correction against the review. */
  app.post('/api/reviews/:date/corrections', async (req) => {
    const user = requireUser(req);
    const { date } = dateParam.parse(req.params);
    const body = parse(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('task'), taskId: z.string().uuid(), status: z.enum(['done', 'postponed', 'blocked', 'canceled', 'todo']), postponeTo: z.string().datetime({ offset: true }).optional(), note: z.string().max(500).optional() }),
        z.object({ kind: z.literal('meeting'), itemId: z.string().uuid(), attendance: z.enum(['attended', 'missed', 'partial']), note: z.string().max(500).optional() }),
        z.object({ kind: z.literal('note'), note: z.string().min(1).max(2000) }),
      ]),
      req.body,
    );
    const [r] = await deps.db.select().from(schema.reviews).where(and(eq(schema.reviews.userId, user.id), eq(schema.reviews.date, date)));
    if (!r) throw notFound('Review');
    const now = deps.now().toISOString();
    if (body.kind === 'task') {
      const [t] = await deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.id, body.taskId), eq(schema.tasks.userId, user.id)));
      if (!t) throw notFound('Task');
      if (body.status === 'postponed') {
        const s = await getSettings(deps, user.id);
        const to = body.postponeTo ?? DateTime.fromJSDate(deps.now()).setZone(s.timezone).plus({ days: 1 }).startOf('day').toISO()!;
        await deps.db.update(schema.tasks).set({ dueAt: to, dueIsAllDay: !body.postponeTo, postponeCount: t.postponeCount + 1, status: t.status === 'done' ? 'todo' : t.status, updatedAt: now }).where(eq(schema.tasks.id, t.id));
        await deps.db.insert(schema.taskEvents).values({ userId: user.id, taskId: t.id, type: 'postponed', fromValue: t.dueAt, toValue: to });
      } else {
        await deps.db.update(schema.tasks).set({ status: body.status, completedAt: body.status === 'done' ? t.completedAt ?? now : null, updatedAt: now }).where(eq(schema.tasks.id, t.id));
        await deps.db.insert(schema.taskEvents).values({ userId: user.id, taskId: t.id, type: 'status', fromValue: t.status, toValue: body.status });
      }
    }
    const corrections = [...(r.corrections as unknown[]), { ...body, at: now }];
    await deps.db.update(schema.reviews).set({ corrections, updatedAt: now }).where(eq(schema.reviews.id, r.id));
    await audit(deps, user.id, 'review.corrected', { target: date, detail: { kind: body.kind } });
    return { corrections };
  });

  // ---- plan -----------------------------------------------------------------
  app.get('/api/plan', async (req) => {
    const user = requireUser(req);
    const s = await getSettings(deps, user.id);
    const ws = await loadWorkspace(deps, user.id, s.timezone);
    const ctx = buildBriefingContext({ now: deps.now(), prefs: toPreferences(s, user.email), ...ws });
    const writable = await deps.db
      .select({ id: schema.connections.id, provider: schema.connections.provider, accountLabel: schema.connections.accountLabel, tier: schema.connections.tier, features: schema.connections.features })
      .from(schema.connections)
      .where(eq(schema.connections.userId, user.id));
    return {
      date: ctx.date,
      blocks: ctx.plan,
      calendars: writable.filter((c) => c.features.calendar && c.provider !== 'demo').map((c) => ({ ...c, canWrite: c.tier === 'write' })),
    };
  });

  // ---- inbox & calendar -----------------------------------------------------
  app.get('/api/inbox', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ category: z.enum([...EMAIL_CATEGORIES, 'all']).default('all'), kind: z.enum(['all', 'email', 'message']).default('all') }), req.query);
    const s = await getSettings(deps, user.id);
    const since = DateTime.fromJSDate(deps.now()).minus({ days: 7 }).toUTC().toISO()!;
    const rows = await deps.db.select().from(schema.items).where(and(eq(schema.items.userId, user.id), inArray(schema.items.kind, q.kind === 'all' ? ['email', 'message'] : [q.kind]), gte(schema.items.sourceUpdatedAt, since))).orderBy(desc(schema.items.occurredAt)).limit(300);
    const b = await latestBriefing(deps, user.id, localDate(deps.now(), s.timezone));
    const briefing = b?.content as Briefing | undefined;
    const aiById = new Map((briefing?.emails ?? []).filter((e) => e.aiCategorized).map((e) => [e.itemId, e]));
    const msgById = new Map((briefing?.messages ?? []).map((m) => [m.itemId, m]));
    const out = rows.map((r) => {
      const it = toItem(r);
      if (it.kind === 'email') {
        const sig = emailSignals(it as EmailItem, deps.now());
        const ai = aiById.get(it.id);
        return { item: it, category: ai?.category ?? sig.category, reasons: sig.reasons, score: sig.score, summary: ai?.summary ?? null, whyItMatters: ai?.whyItMatters ?? null, aiCategorized: !!ai, unansweredDays: sig.unansweredDays };
      }
      const sig = messageSignals(it as MessageItem);
      const m = msgById.get(it.id);
      return { item: it, category: sig.important ? (sig.looksLikeRequest ? 'needs_reply' : 'informational') : 'can_wait', reasons: sig.reasons, score: sig.score, summary: m?.summary ?? null, whyItMatters: m?.actionItem ?? null, aiCategorized: !!m, unansweredDays: null };
    });
    return out.filter((x) => q.category === 'all' || x.category === q.category).sort((a, b) => b.score - a.score || b.item.occurredAt.localeCompare(a.item.occurredAt));
  });

  app.get('/api/calendar', async (req) => {
    const user = requireUser(req);
    const s = await getSettings(deps, user.id);
    const q = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), days: z.coerce.number().int().min(1).max(31).default(7) }), req.query);
    const from = DateTime.fromISO(q.from ?? localDate(deps.now(), s.timezone), { zone: s.timezone }).startOf('day');
    const to = from.plus({ days: q.days });
    const rows = await deps.db.select().from(schema.items).where(and(eq(schema.items.userId, user.id), eq(schema.items.kind, 'event'), gte(schema.items.occurredAt, from.minus({ days: 1 }).toUTC().toISO()!), lt(schema.items.occurredAt, to.toUTC().toISO()!))).orderBy(schema.items.occurredAt);
    const events = rows.map(toItem) as EventItem[];
    const visible = events.filter((e) => Date.parse(e.data.end) > from.toMillis());
    return { from: from.toISODate(), days: q.days, timezone: s.timezone, events: visible, conflicts: findConflicts(visible) };
  });

  app.get('/api/items/:id', async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const [r] = await deps.db.select().from(schema.items).where(and(eq(schema.items.id, id), eq(schema.items.userId, user.id)));
    if (!r) throw notFound('Item');
    const [c] = await deps.db.select({ tier: schema.connections.tier, provider: schema.connections.provider }).from(schema.connections).where(eq(schema.connections.id, r.connectionId));
    return { item: toItem(r), connection: c ?? null };
  });

  // ---- approvals ------------------------------------------------------------
  app.get('/api/actions', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ status: z.enum(['pending', 'done', 'failed', 'rejected', 'executing']).optional() }), req.query);
    return listActions(deps, user.id, q.status);
  });
  app.post('/api/actions', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ type: z.string(), connectionId: z.string().uuid(), payload: z.unknown(), origin: z.enum(['user', 'assistant', 'plan']).default('user') }), req.body);
    return reply.code(201).send(await createAction(deps, user, body));
  });
  app.post('/api/actions/:id/approve', { config: heavy }, async (req) => {
    const user = requireUser(req);
    return approveAction(deps, user, z.string().uuid().parse((req.params as { id: string }).id), req.ip);
  });
  app.post('/api/actions/:id/reject', async (req) => {
    const user = requireUser(req);
    return rejectAction(deps, user, z.string().uuid().parse((req.params as { id: string }).id));
  });

  // ---- assistant ------------------------------------------------------------
  /** Streams NDJSON events: start, delta…, done (with citations) or error. */
  app.post('/api/assistant/chat', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ threadId: z.string().uuid().nullable().optional(), message: z.string().trim().min(1).max(4000) }), req.body);
    const ac = new AbortController();
    req.raw.on('close', () => {
      if (!reply.raw.writableEnded) ac.abort();
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...corsHeaders(deps, req.headers.origin),
    });
    try {
      await streamAssistant(deps, user, body, (e) => reply.raw.write(`${JSON.stringify(e)}\n`), ac.signal);
    } catch (e) {
      deps.log.error({ err: e }, 'assistant failed');
      reply.raw.write(`${JSON.stringify({ type: 'error', code: 'internal', message: 'Something went wrong.' })}\n`);
    }
    reply.raw.end();
  });
  app.get('/api/assistant/threads', async (req) => listThreads(deps, requireUser(req).id));
  app.get('/api/assistant/threads/:id', async (req) => threadMessages(deps, requireUser(req).id, z.string().uuid().parse((req.params as { id: string }).id)));
  app.post('/api/assistant/draft-reply', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ itemId: z.string().uuid(), instructions: z.string().max(1000).default('') }), req.body);
    return draftReply(deps, user, body.itemId, body.instructions);
  });

  // ---- notifications --------------------------------------------------------
  app.get('/api/notifications', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ since: z.string().datetime({ offset: true }).optional() }), req.query);
    const s = await getSettings(deps, user.id);
    const conds = [eq(schema.notifications.userId, user.id)];
    if (q.since) conds.push(gte(schema.notifications.createdAt, q.since));
    const rows = await deps.db.select().from(schema.notifications).where(and(...conds)).orderBy(desc(schema.notifications.createdAt)).limit(50);
    return { notifications: rows, showPreviews: s.notifications.showPreviews, desktop: s.notifications.desktop && !s.automations.paused };
  });
  app.post('/api/notifications/:id/read', async (req) => {
    const user = requireUser(req);
    await deps.db.update(schema.notifications).set({ readAt: deps.now().toISOString() }).where(and(eq(schema.notifications.id, z.string().uuid().parse((req.params as { id: string }).id)), eq(schema.notifications.userId, user.id)));
    return { ok: true };
  });
  app.post('/api/notifications/read-all', async (req) => {
    const user = requireUser(req);
    await deps.db.update(schema.notifications).set({ readAt: deps.now().toISOString() }).where(eq(schema.notifications.userId, user.id));
    return { ok: true };
  });

  void badRequest;
}

export function corsHeaders(deps: Deps, origin: string | undefined): Record<string, string> {
  if (!origin || !deps.config.webOrigins.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
}
