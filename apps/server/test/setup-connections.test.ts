import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { schema } from '@secretary/db';
import { createTestApp, signup, type Session, type TestApp } from './helpers.js';

const mock = setupServer();
let t: TestApp;
let s: Session;
beforeAll(async () => {
  mock.listen({ onUnhandledRequest: 'bypass' });
  t = await createTestApp({ LOCAL_MODE: 'true' });
  s = await signup(t);
});
afterEach(() => mock.resetHandlers());
afterAll(async () => { mock.close(); await t.close(); });
const api = (method: string, url: string, payload?: object) => t.app.inject({ method: method as 'GET', url, headers: s.headers, payload });
const provider = async (p: string) => (await api('GET', '/api/integrations')).json().providers.find((x: { provider: string }) => x.provider === p);

describe('local mode: register your own OAuth app in Settings', () => {
  it('saves Google credentials encrypted, then OAuth becomes available', async () => {
    expect(await provider('google')).toMatchObject({ configured: false, canConfigureApp: true, tokenConnect: false });
    const bad = await api('PUT', '/api/integrations/google/app', { clientId: 'has spaces in it', clientSecret: 'x' });
    expect(bad.statusCode).toBe(400);
    const ok = await api('PUT', '/api/integrations/google/app', { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-supersecretvalue' });
    expect(ok.statusCode).toBe(200);
    const [row] = await t.deps.db.select().from(schema.oauthApps);
    expect(row!.encryptedSecret).not.toContain('supersecret');
    expect(await provider('google')).toMatchObject({ configured: true, appSource: 'app' });
    const c = (await api('POST', '/api/integrations/google/connect', { features: { calendar: true, email: true, messages: false, tasks: false } })).json();
    expect(new URL(c.authUrl).searchParams.get('client_id')).toBe('1234-abc.apps.googleusercontent.com');
    expect(new URL(c.authUrl).searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/integrations/callback/google');
    expect((await api('DELETE', '/api/integrations/google/app')).statusCode).toBe(200);
    expect((await provider('google')).configured).toBe(false);
  });

  it('is refused on hosted (non-local) servers', async () => {
    const hosted = await createTestApp();
    const h = await signup(hosted);
    const r = await hosted.app.inject({ method: 'PUT', url: '/api/integrations/google/app', headers: h.headers, payload: { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-x12345678' } });
    expect(r.statusCode).toBe(403);
    await hosted.close();
  });
});

describe('connect with a token (no app registration)', () => {
  it('Todoist: verifies the personal token and syncs tasks', async () => {
    mock.use(
      http.get('https://api.todoist.com/api/v1/user', ({ request }) => request.headers.get('authorization') === `Bearer ${'a'.repeat(40)}` ? HttpResponse.json({ id: 77, email: 'aaron@example.com' }) : new HttpResponse(null, { status: 401 })),
      http.get('https://api.todoist.com/api/v1/tasks', () => HttpResponse.json({ results: [{ id: '1', content: 'Buy milk', priority: 1 }], next_cursor: null })),
      http.get('https://api.todoist.com/api/v1/tasks/completed/by_completion_date', () => HttpResponse.json({ items: [] })),
    );
    expect((await api('POST', '/api/integrations/todoist/token', { token: 'not-a-token-really' })).json().error.message).toMatch(/40 letters/);
    expect((await api('POST', '/api/integrations/todoist/token', { token: 'b'.repeat(40) })).json().error.message).toMatch(/rejected/);
    const r = (await api('POST', '/api/integrations/todoist/token', { token: 'a'.repeat(40), tier: 'write' })).json();
    expect(r).toMatchObject({ connected: true, accountLabel: 'aaron@example.com' });
    await api('POST', `/api/integrations/${r.connectionId}/sync`);
    const tasks = (await api('GET', '/api/tasks?filter=open')).json();
    expect(tasks.map((x: { title: string }) => x.title)).toContain('Buy milk');
    const [conn] = await t.deps.db.select().from(schema.connections);
    expect(conn!.encryptedTokens).not.toContain('aaaaaaaa');
  });

  it('Slack: requires a user token with the right scopes', async () => {
    expect((await api('POST', '/api/integrations/slack/token', { token: 'xoxb-123-bot-token' })).json().error.message).toMatch(/bot token/);
    mock.use(http.get('https://slack.com/api/auth.test', () => HttpResponse.json({ ok: true, user_id: 'U1', user: 'aaron', team: 'Acme', team_id: 'T1', url: 'https://acme.slack.com/' }, { headers: { 'x-oauth-scopes': 'channels:history,users:read' } })));
    const missing = (await api('POST', '/api/integrations/slack/token', { token: 'xoxp-1-2-3-abc' })).json();
    expect(missing.error.message).toMatch(/missing these User Token Scopes/);
    const all = 'channels:history,groups:history,im:history,mpim:history,channels:read,groups:read,im:read,mpim:read,users:read';
    mock.use(
      http.get('https://slack.com/api/auth.test', () => HttpResponse.json({ ok: true, user_id: 'U1', user: 'aaron', team: 'Acme', team_id: 'T1', url: 'https://acme.slack.com/' }, { headers: { 'x-oauth-scopes': all } })),
      http.get('https://slack.com/api/users.conversations', () => HttpResponse.json({ ok: true, channels: [] })),
    );
    const ok = (await api('POST', '/api/integrations/slack/token', { token: 'xoxp-1-2-3-abc', tier: 'write' })).json();
    expect(ok).toMatchObject({ connected: true, accountLabel: 'Acme (aaron)' });
    const list = (await api('GET', '/api/integrations')).json();
    expect(list.connections.find((c: { provider: string }) => c.provider === 'slack').tier).toBe('read'); // Slack is always read-only
  });
});
