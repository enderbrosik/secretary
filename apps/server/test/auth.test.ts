import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@secretary/db';
import { createTestApp, signup, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => t.close());

describe('authentication & sessions', () => {
  it('signs up, sets an httpOnly cookie and returns the profile', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'Ada@Example.com', password: 'a-very-long-password', displayName: 'Ada' } });
    expect(res.statusCode).toBe(201);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(res.headers['set-cookie'])).toMatch(/SameSite=Lax/i);
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: String(res.headers['set-cookie']).split(';')[0]! } });
    expect(me.json().user.email).toBe('ada@example.com');
    const [u] = await t.deps.db.select().from(schema.users).where(eq(schema.users.email, 'ada@example.com'));
    expect(u!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects duplicate emails, weak passwords and bad credentials', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'ada@example.com', password: 'a-very-long-password', displayName: 'Ada' } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'b@example.com', password: 'short', displayName: 'B' } })).statusCode).toBe(400);
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ada@example.com', password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.message).toBe('Incorrect email or password');
    const unknown = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.com', password: 'wrong-password' } });
    expect(unknown.json().error.message).toBe('Incorrect email or password');
  });

  it('requires a session for protected routes', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/tasks' })).statusCode).toBe(401);
  });

  it('enforces CSRF tokens and origin checks on cookie sessions', async () => {
    const s = await signup(t);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/tasks', headers: { cookie: s.cookie }, payload: { title: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await t.app.inject({ method: 'POST', url: '/api/tasks', headers: { ...s.headers, origin: 'https://evil.example' }, payload: { title: 'x' } });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/tasks', headers: { ...s.headers, origin: 'http://localhost:5173' }, payload: { title: 'x' } });
    expect(ok.statusCode).toBe(201);
  });

  it('desktop clients use bearer tokens (no cookie, no CSRF needed)', async () => {
    await signup(t, { email: 'desk@example.com' });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'desk@example.com', password: 'correct horse battery', client: 'desktop' } });
    expect(login.headers['set-cookie']).toBeUndefined();
    const token = login.json().token;
    expect(token).toBeTruthy();
    const res = await t.app.inject({ method: 'POST', url: '/api/tasks', headers: { authorization: `Bearer ${token}` }, payload: { title: 'From desktop' } });
    expect(res.statusCode).toBe(201);
    // Only a hash of the token is stored
    const rows = await t.deps.db.select().from(schema.sessions);
    expect(rows.some((r) => r.id === token)).toBe(false);
  });

  it('logout invalidates the session; idle sessions expire', async () => {
    const s = await signup(t);
    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: s.headers });
    expect((await t.app.inject({ method: 'GET', url: '/api/tasks', headers: s.headers })).statusCode).toBe(401);

    const s2 = await signup(t);
    const real = t.clock.now;
    t.clock.now = new Date(real.getTime() + 8 * 86400_000); // past the 7-day idle limit
    expect((await t.app.inject({ method: 'GET', url: '/api/tasks', headers: s2.headers })).statusCode).toBe(401);
    t.clock.now = real;
  });

  it('isolates tenants', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const task = (await t.app.inject({ method: 'POST', url: '/api/tasks', headers: a.headers, payload: { title: 'Private' } })).json();
    expect((await t.app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: b.headers, payload: { title: 'Hacked' } })).statusCode).toBe(404);
    const list = (await t.app.inject({ method: 'GET', url: '/api/tasks?filter=all', headers: b.headers })).json();
    expect(list.find((x: { id: string }) => x.id === task.id)).toBeUndefined();
    // B cannot make its task depend on A's task
    const dep = await t.app.inject({ method: 'POST', url: '/api/tasks', headers: b.headers, payload: { title: 'Mine', dependsOn: [task.id] } });
    expect(dep.statusCode).toBe(400);
  });

  it('sets security headers and does not cache API responses', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('validates input', async () => {
    const s = await signup(t);
    const r = await t.app.inject({ method: 'POST', url: '/api/tasks', headers: s.headers, payload: { title: '', priority: 'ultra' } });
    expect(r.statusCode).toBe(400);
    const tz = await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: s.headers, payload: { timezone: 'Mars/Olympus' } });
    expect(tz.statusCode).toBe(400);
  });
});
