import { and, eq, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { schema } from '@secretary/db';
import type { AuthedUser, Deps } from './context.js';
import { randomToken, safeEqual, sha256 } from './crypto.js';
import { forbidden, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'sid';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthedUser | null;
    sessionId: string | null;
    authVia: 'cookie' | 'bearer' | null;
  }
}

export async function createSession(deps: Deps, userId: string, client: 'web' | 'desktop', req: FastifyRequest) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(deps.now().getTime() + deps.config.SESSION_TTL_DAYS * 86400_000).toISOString();
  await deps.db.insert(schema.sessions).values({
    id: sha256(token),
    userId,
    client,
    csrfToken,
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
    ip: req.ip,
    lastSeenAt: deps.now().toISOString(),
    expiresAt,
  });
  // Opportunistic cleanup of expired sessions for this user.
  await deps.db.delete(schema.sessions).where(and(eq(schema.sessions.userId, userId), lt(schema.sessions.expiresAt, deps.now().toISOString())));
  return { token, csrfToken, expiresAt };
}

export function setSessionCookie(deps: Deps, reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.config.COOKIE_SECURE,
    path: '/',
    maxAge: deps.config.SESSION_TTL_DAYS * 86400,
  });
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Resolves the session from the cookie (web) or bearer token (desktop) and enforces CSRF for cookie sessions. */
export async function authenticate(deps: Deps, req: FastifyRequest): Promise<void> {
  req.user = null;
  req.sessionId = null;
  req.authVia = null;
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const cookie = req.cookies?.[SESSION_COOKIE];
  const token = bearer || cookie;
  if (!token) return;
  const id = sha256(token);
  const now = deps.now();
  const [row] = await deps.db
    .select({ s: schema.sessions, u: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.id, id));
  if (!row) return;
  const idleCutoff = now.getTime() - deps.config.SESSION_IDLE_DAYS * 86400_000;
  if (Date.parse(row.s.expiresAt) <= now.getTime() || Date.parse(row.s.lastSeenAt) < idleCutoff) {
    await deps.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    return;
  }
  const via = bearer ? 'bearer' : 'cookie';
  if (via === 'cookie' && MUTATING.has(req.method)) {
    const sent = req.headers['x-csrf-token'];
    if (typeof sent !== 'string' || !safeEqual(sent, row.s.csrfToken)) throw forbidden('Missing or invalid CSRF token');
    const origin = req.headers.origin;
    if (origin && !deps.config.webOrigins.includes(origin) && origin !== new URL(deps.config.APP_URL).origin && origin !== new URL(deps.config.PUBLIC_URL).origin) {
      throw forbidden('Cross-origin request rejected');
    }
  }
  if (now.getTime() - Date.parse(row.s.lastSeenAt) > 5 * 60_000) {
    await deps.db.update(schema.sessions).set({ lastSeenAt: now.toISOString() }).where(eq(schema.sessions.id, id));
  }
  req.user = { id: row.u.id, email: row.u.email, displayName: row.u.displayName, wrappedDataKey: row.u.wrappedDataKey };
  req.sessionId = id;
  req.authVia = via;
}

export function requireUser(req: FastifyRequest): AuthedUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export async function revokeSessions(deps: Deps, userId: string, exceptId?: string) {
  const all = await deps.db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, userId));
  for (const s of all) if (s.id !== exceptId) await deps.db.delete(schema.sessions).where(eq(schema.sessions.id, s.id));
}

