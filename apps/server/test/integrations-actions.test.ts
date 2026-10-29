import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { eq } from 'drizzle-orm';
import { schema } from '@secretary/db';
import { createTestApp, signup, type Session, type TestApp } from './helpers.js';

const mock = setupServer();
let t: TestApp;
let s: Session;
let revoked = 0;
let draftsCreated = 0;
let sent = 0;

beforeAll(async () => {
  mock.listen({ onUnhandledRequest: 'bypass' });
  t = await createTestApp({ GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' });
  s = await signup(t);
});
afterEach(() => mock.resetHandlers());
afterAll(async () => { mock.close(); await t.close(); });

const api = (method: string, url: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, headers: s.headers, payload: payload as object });

function googleHandlers() {
  return [
    http.post('https://oauth2.googleapis.com/token', () => HttpResponse.json({ access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose' })),
    http.get('https://openidconnect.googleapis.com/v1/userinfo', () => HttpResponse.json({ sub: 'g-123', email: 'alex@gmail.example' })),
    http.get('https://gmail.googleapis.com/gmail/v1/users/me/threads', () => HttpResponse.json({ threads: [{ id: 'th1' }] })),
    http.get('https://gmail.googleapis.com/gmail/v1/users/me/threads/th1', () =>
      HttpResponse.json({ id: 'th1', messages: [{ id: 'm1', threadId: 'th1', labelIds: ['INBOX', 'UNREAD'], snippet: 'Can you send the deck?', internalDate: String(Date.parse('2026-10-29T10:00:00Z')),
        payload: { headers: [{ name: 'From', value: 'Kim <kim@client.example>' }, { name: 'To', value: 'alex@gmail.example' }, { name: 'Subject', value: 'Deck' }, { name: 'Message-ID', value: '<abc@x>' }] } }] }),
    ),
    http.post('https://gmail.googleapis.com/gmail/v1/users/me/drafts', async () => { draftsCreated++; return HttpResponse.json({ id: 'd1', message: { id: 'm2', threadId: 'th1' } }); }),
    http.post('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', () => { sent++; return HttpResponse.json({ id: 'm3', threadId: 'th1' }); }),
    http.post('https://oauth2.googleapis.com/revoke', () => { revoked++; return new HttpResponse(null, { status: 200 }); }),
  ];
}

async function connectGoogle(tier: 'read' | 'draft' | 'write') {
  mock.use(...googleHandlers());
  const r = (await api('POST', '/api/integrations/google/connect', { features: { calendar: false, email: true, messages: false, tasks: false }, tier })).json();
  const u = new URL(r.authUrl);
  expect(u.origin).toBe('https://accounts.google.com');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  const state = u.searchParams.get('state')!;
  const cb = await t.app.inject({ method: 'GET', url: `/api/integrations/callback/google?state=${state}&code=CODE` });
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toContain('connected=google');
  // replaying the same state must fail (single use)
  const replay = await t.app.inject({ method: 'GET', url: `/api/integrations/callback/google?state=${state}&code=CODE` });
  expect(replay.body).toContain('expired or is invalid');
  const list = (await api('GET', '/api/integrations')).json();
  return list.connections.find((c: { provider: string }) => c.provider === 'google');
}

describe('OAuth connection lifecycle', () => {
  it('reports unconfigured providers honestly', async () => {
    const r = await api('POST', '/api/integrations/slack/connect', { features: { calendar: false, email: false, messages: true, tasks: false } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('integration_not_configured');
    const list = (await api('GET', '/api/integrations')).json();
    expect(list.providers.find((p: { provider: string }) => p.provider === 'slack').configured).toBe(false);
    expect(list.providers.find((p: { provider: string }) => p.provider === 'google').configured).toBe(true);
  });

  it('connects with PKCE, encrypts tokens, syncs and links to sources', async () => {
    const conn = await connectGoogle('read');
    expect(conn).toMatchObject({ tier: 'read', accountLabel: 'alex@gmail.example' });
    const [row] = await t.deps.db.select().from(schema.connections).where(eq(schema.connections.id, conn.id));
    expect(row!.encryptedTokens).not.toContain('AT-1');
    expect(row!.encryptedTokens).not.toContain('RT-1');
    await api('POST', `/api/integrations/${conn.id}/sync`);
    const inbox = (await api('GET', '/api/inbox')).json();
    expect(inbox[0].item.url).toContain('mail.google.com');
  });

  it('rejects an invalid or missing state', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/integrations/callback/google?state=forged&code=x' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Connection failed');
  });
});

describe('permission model & approvals', () => {
  it('read tier cannot create drafts; raising the tier requires re-consent when scopes are missing', async () => {
    const list = (await api('GET', '/api/integrations')).json();
    const conn = list.connections.find((c: { provider: string }) => c.provider === 'google');
    const item = (await api('GET', '/api/inbox')).json()[0].item;
    const r = await api('POST', '/api/actions', { type: 'create_draft', connectionId: conn.id, payload: { itemId: item.id, to: ['kim@client.example'], subject: 'Re: Deck', body: 'Attached.' } });
    expect(r.statusCode).toBe(403);
    // compose scope was granted by the mock token response, so drafts can be enabled without re-consent
    const up = (await api('PATCH', `/api/integrations/${conn.id}`, { tier: 'draft' })).json();
    expect(up.requiresReconsent).toBe(false);
  });

  it('draft tier: creates a pending action, executes only on approval, exactly once', async () => {
    const conn = (await api('GET', '/api/integrations')).json().connections.find((c: { provider: string }) => c.provider === 'google');
    mock.use(...googleHandlers());
    const item = (await api('GET', '/api/inbox')).json()[0].item;
    const a = await api('POST', '/api/actions', { type: 'create_draft', connectionId: conn.id, payload: { itemId: item.id, to: ['kim@client.example'], subject: 'Re: Deck', body: 'Attached.' } });
    expect(a.statusCode).toBe(201);
    expect(a.json().status).toBe('pending');
    expect(draftsCreated).toBe(0);
    const ok = await api('POST', `/api/actions/${a.json().id}/approve`);
    expect(ok.json().status).toBe('done');
    expect(draftsCreated).toBe(1);
    const again = await api('POST', `/api/actions/${a.json().id}/approve`);
    expect(again.statusCode).toBe(404);
    expect(draftsCreated).toBe(1);
    // Sending still needs the write tier
    const send = await api('POST', '/api/actions', { type: 'send_email', connectionId: conn.id, payload: { itemId: item.id, to: ['kim@client.example'], subject: 'Re: Deck', body: 'x' } });
    expect(send.statusCode).toBe(403);
    expect(sent).toBe(0);
    const audit = (await api('GET', '/api/audit')).json().map((x: { action: string }) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['action.requested', 'action.approved', 'action.executed', 'integration.connected']));
  });

  it('rejected actions never execute; demo connections can never write', async () => {
    const conn = (await api('GET', '/api/integrations')).json().connections.find((c: { provider: string }) => c.provider === 'google');
    const a = (await api('POST', '/api/actions', { type: 'create_draft', connectionId: conn.id, payload: { to: ['kim@client.example'], subject: 'S', body: 'B' } })).json();
    await api('POST', `/api/actions/${a.id}/reject`);
    expect((await api('POST', `/api/actions/${a.id}/approve`)).statusCode).toBe(404);
    expect(draftsCreated).toBe(1);

    await api('POST', '/api/integrations/demo/connect', { features: { calendar: true, email: true, messages: true, tasks: true } });
    const demo = (await api('GET', '/api/integrations')).json().connections.find((c: { provider: string }) => c.provider === 'demo');
    const d = await api('POST', '/api/actions', { type: 'create_draft', connectionId: demo.id, payload: { to: ['a@b.example'], subject: 'S', body: 'B' } });
    expect(d.statusCode).toBe(403);
    expect(d.json().error.message).toMatch(/demo workspace/i);
  });

  it('disconnect revokes at the provider and deletes synced data', async () => {
    mock.use(...googleHandlers());
    const conn = (await api('GET', '/api/integrations')).json().connections.find((c: { provider: string }) => c.provider === 'google');
    const r = (await api('DELETE', `/api/integrations/${conn.id}`)).json();
    expect(r.revokedAtProvider).toBe(true);
    expect(revoked).toBe(1);
    const left = await t.deps.db.select().from(schema.items).where(eq(schema.items.connectionId, conn.id));
    expect(left).toHaveLength(0);
  });

  it('marks connections as needing re-auth when the token is revoked', async () => {
    const conn = await connectGoogle('read');
    mock.use(http.get('https://gmail.googleapis.com/gmail/v1/users/me/threads', () => new HttpResponse(null, { status: 401 })));
    const r = await api('POST', `/api/integrations/${conn.id}/sync`);
    expect(r.statusCode).toBe(502);
    const after = (await api('GET', '/api/integrations')).json().connections.find((c: { id: string }) => c.id === conn.id);
    expect(after.status).toBe('reauth_required');
    const notes = (await api('GET', '/api/notifications')).json().notifications;
    expect(notes.some((n: { kind: string }) => n.kind === 'integration')).toBe(true);
  });
});

describe('account deletion', () => {
  it('requires the password and removes everything', async () => {
    const other = await signup(t);
    await t.app.inject({ method: 'POST', url: '/api/tasks', headers: other.headers, payload: { title: 'Gone soon' } });
    const bad = await t.app.inject({ method: 'DELETE', url: '/api/account', headers: other.headers, payload: { password: 'nope', confirm: 'DELETE' } });
    expect(bad.statusCode).toBe(400);
    const ok = await t.app.inject({ method: 'DELETE', url: '/api/account', headers: other.headers, payload: { password: 'correct horse battery', confirm: 'DELETE' } });
    expect(ok.statusCode).toBe(200);
    expect(await t.deps.db.select().from(schema.users).where(eq(schema.users.id, other.userId))).toHaveLength(0);
    expect(await t.deps.db.select().from(schema.tasks).where(eq(schema.tasks.userId, other.userId))).toHaveLength(0);
    expect((await t.app.inject({ method: 'GET', url: '/api/tasks', headers: other.headers })).statusCode).toBe(401);
  });
});
