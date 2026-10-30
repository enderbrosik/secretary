import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signup, type Session, type TestApp } from './helpers.js';

// A desktop release: local mode with the app's built-in OAuth apps, no developer options.
let t: TestApp;
let s: Session;
beforeAll(async () => {
  t = await createTestApp({
    LOCAL_MODE: 'true',
    GOOGLE_CLIENT_ID: 'builtin.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-builtin',
    MICROSOFT_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
    SLACK_CLIENT_ID: '111.222',
    SLACK_CLIENT_SECRET: 'slacksecret',
    OAUTH_RELAY_URL: 'https://example.github.io/secretary/oauth/',
  });
  s = await signup(t);
});
afterAll(() => t.close());
const api = (method: string, url: string, payload?: object) => t.app.inject({ method: method as 'GET', url, headers: s.headers, payload });
const connect = async (p: string, features: object) => (await api('POST', `/api/integrations/${p}/connect`, { features })).json();

describe('release mode: built-in OAuth apps only', () => {
  it('never offers app registration or token pasting', async () => {
    const { providers } = (await api('GET', '/api/integrations')).json();
    for (const p of providers) expect(p).toMatchObject({ canConfigureApp: false, tokenConnect: false });
    expect(providers.find((p: { provider: string }) => p.provider === 'google')).toMatchObject({ configured: true, appSource: 'env' });
    expect(providers.find((p: { provider: string }) => p.provider === 'todoist').configured).toBe(false);
    expect((await api('PUT', '/api/integrations/google/app', { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-12345678' })).statusCode).toBe(403);
    expect((await api('POST', '/api/integrations/todoist/token', { token: 'a'.repeat(40) })).statusCode).toBe(403);
  });

  it('says plainly when a service is not available yet', async () => {
    const r = await api('POST', '/api/integrations/todoist/connect', { features: { tasks: true, calendar: false, email: false, messages: false } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/isn’t available in this version/);
  });

  it('Google and Microsoft return straight to the loopback server', async () => {
    const g = new URL((await connect('google', { calendar: true, email: true, messages: false, tasks: false })).authUrl);
    expect(g.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/integrations/callback/google');
    const m = new URL((await connect('microsoft', { calendar: true, email: true, messages: false, tasks: false })).authUrl);
    expect(m.searchParams.get('client_id')).toBe('00000000-0000-0000-0000-000000000001');
    expect(m.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('Slack goes through the HTTPS relay, with the loopback port in the state', async () => {
    const u = new URL((await connect('slack', { calendar: false, email: false, messages: true, tasks: false })).authUrl);
    expect(u.searchParams.get('redirect_uri')).toBe('https://example.github.io/secretary/oauth/');
    expect(u.searchParams.get('state')).toMatch(/^8787\.slack\.[\w-]{20,}$/);
    // The relay forwards to the regular callback, which accepts the state once.
    const cb = await t.app.inject({ method: 'GET', url: `/api/integrations/callback/slack?error=access_denied&state=${u.searchParams.get('state')}` });
    expect(cb.statusCode).toBe(302);
    expect(decodeURIComponent(cb.headers.location as string)).toMatch(/declined/);
  });
});
