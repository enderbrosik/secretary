import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidTimezone, loginSchema, signupSchema } from '@secretary/core';
import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';
import { createSession, requireUser, revokeSessions, SESSION_COOKIE, setSessionCookie } from '../lib/auth.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { AppError, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { defaultSettings, getSettings, updateSettings } from '../services/settings.js';

const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

// Precomputed hash so failed logins for unknown emails take as long as real ones.
let dummyHash: Promise<string> | null = null;

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/api/auth/signup', { config: authLimit }, async (req, reply) => {
    const body = parse(signupSchema.extend({ client: z.enum(['web', 'desktop']).default('web') }), req.body);
    if (!deps.config.ALLOW_SIGNUP) throw forbidden('Sign-up is disabled on this server');
    const [existing] = await deps.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, body.email));
    if (existing) throw conflict('An account with this email already exists');
    const id = crypto.randomUUID();
    const [user] = await deps.db
      .insert(schema.users)
      .values({ id, email: body.email, passwordHash: await hashPassword(body.password), displayName: body.displayName, wrappedDataKey: deps.keys.newWrappedDataKey(id) })
      .returning();
    const tz = body.timezone && isValidTimezone(body.timezone) ? body.timezone : 'UTC';
    await deps.db.insert(schema.userSettings).values({ userId: user!.id, settings: defaultSettings(body.displayName, tz) });
    const s = await createSession(deps, user!.id, body.client, req);
    if (body.client === 'web') setSessionCookie(deps, reply, s.token);
    await audit(deps, user!.id, 'auth.signup', { ip: req.ip });
    return reply.code(201).send({ user: publicUser(user!), csrfToken: s.csrfToken, token: body.client === 'desktop' ? s.token : undefined });
  });

  app.post('/api/auth/login', { config: authLimit }, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.email, body.email));
    dummyHash ??= hashPassword('not-a-real-password-placeholder');
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : (await verifyPassword(body.password, await dummyHash), false);
    if (!user || !ok) {
      await audit(deps, user?.id ?? null, 'auth.login_failed', { ip: req.ip, detail: { email: body.email } });
      throw unauthorized('Incorrect email or password');
    }
    const s = await createSession(deps, user.id, body.client, req);
    if (body.client === 'web') setSessionCookie(deps, reply, s.token);
    await audit(deps, user.id, 'auth.login', { ip: req.ip, detail: { client: body.client } });
    return { user: publicUser(user), csrfToken: s.csrfToken, token: body.client === 'desktop' ? s.token : undefined };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionId) await deps.db.delete(schema.sessions).where(eq(schema.sessions.id, req.sessionId));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/logout-all', async (req, reply) => {
    const user = requireUser(req);
    await revokeSessions(deps, user.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await audit(deps, user.id, 'auth.logout_all', { ip: req.ip });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.user || !req.sessionId) return { user: null, localMode: deps.config.LOCAL_MODE, signupAllowed: deps.config.ALLOW_SIGNUP };
    const [s] = await deps.db.select().from(schema.sessions).where(eq(schema.sessions.id, req.sessionId));
    const settings = await getSettings(deps, req.user.id);
    const [demo] = await deps.db.select({ id: schema.connections.id }).from(schema.connections).where(and(eq(schema.connections.userId, req.user.id), eq(schema.connections.provider, 'demo')));
    return {
      user: { id: req.user.id, email: req.user.email, displayName: req.user.displayName },
      csrfToken: s?.csrfToken,
      settings,
      demoMode: !!demo,
      localMode: deps.config.LOCAL_MODE,
    };
  });

  app.get('/api/auth/sessions', async (req) => {
    const user = requireUser(req);
    const rows = await deps.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    return rows.map((r) => ({ id: r.id.slice(0, 12), client: r.client, userAgent: r.userAgent, ip: r.ip, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: r.id === req.sessionId }));
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req) => {
    const user = requireUser(req);
    const prefix = z.string().regex(/^[a-f0-9]{12}$/).parse(req.params.id);
    const rows = await deps.db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, user.id));
    const hit = rows.find((r) => r.id.startsWith(prefix));
    if (hit) await deps.db.delete(schema.sessions).where(eq(schema.sessions.id, hit.id));
    await audit(deps, user.id, 'auth.session_revoked', { ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/password', { config: authLimit }, async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(200) }), req.body);
    const [u] = await deps.db.select().from(schema.users).where(eq(schema.users.id, user.id));
    if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) throw new AppError(400, 'wrong_password', 'Current password is incorrect');
    await deps.db.update(schema.users).set({ passwordHash: await hashPassword(body.newPassword), updatedAt: deps.now().toISOString() }).where(eq(schema.users.id, user.id));
    await revokeSessions(deps, user.id, req.sessionId ?? undefined);
    await audit(deps, user.id, 'auth.password_changed', { ip: req.ip });
    return { ok: true };
  });

  // Settings live here because they are part of the account.
  app.get('/api/settings', async (req) => getSettings(deps, requireUser(req).id));
  app.patch('/api/settings', async (req) => {
    const user = requireUser(req);
    const { settingsPatchSchema } = await import('@secretary/core');
    const patch = parse(settingsPatchSchema, req.body);
    const s = await updateSettings(deps, user.id, patch);
    await audit(deps, user.id, 'settings.updated', { detail: { keys: Object.keys(patch) } });
    return s;
  });
}

function publicUser(u: typeof schema.users.$inferSelect) {
  return { id: u.id, email: u.email, displayName: u.displayName };
}
