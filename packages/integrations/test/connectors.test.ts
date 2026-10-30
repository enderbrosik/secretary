import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  buildRfc822,
  demoConnector,
  generateDemoData,
  googleConnector,
  IntegrationError,
  mapTodoistTask,
  microsoftConnector,
  slackConnector,
  todoistConnector,
  type SyncContext,
} from '../src/index.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const now = new Date('2026-10-29T13:00:00Z');
const ctx = (over: Partial<SyncContext> = {}): SyncContext => ({
  tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: null, scopes: [], extra: {} },
  account: { externalId: 'u1', label: 'me@example.com', email: 'me@example.com' },
  features: { calendar: true, email: true, messages: true, tasks: true },
  now,
  timezone: 'America/New_York',
  syncState: {},
  includeBodies: true,
  ...over,
});
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('Google', () => {
  it('requests minimal scopes per tier', () => {
    const f = { calendar: true, email: true, messages: false, tasks: false };
    expect(googleConnector.scopesFor(f, 'read')).toEqual(['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/gmail.readonly']);
    expect(googleConnector.scopesFor(f, 'draft')).toContain('https://www.googleapis.com/auth/gmail.compose');
    expect(googleConnector.scopesFor(f, 'draft')).not.toContain('https://www.googleapis.com/auth/calendar.events');
    expect(googleConnector.scopesFor({ ...f, email: false }, 'write')).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it('builds a PKCE authorization URL with offline access', () => {
    const u = new URL(googleConnector.buildAuthUrl({ creds: { clientId: 'cid', clientSecret: 's' }, redirectUri: 'https://app/cb', state: 'st', codeChallenge: 'cc', scopes: ['a', 'b'] }));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('scope')).toBe('a b');
  });

  it('exchanges the code and identifies the account', async () => {
    let form: URLSearchParams | undefined;
    server.use(
      http.post('https://oauth2.googleapis.com/token', async ({ request }) => {
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'openid email' });
      }),
      http.get('https://openidconnect.googleapis.com/v1/userinfo', () => HttpResponse.json({ sub: '123', email: 'me@example.com' })),
    );
    const r = await googleConnector.exchangeCode({ creds: { clientId: 'cid', clientSecret: 'sec' }, code: 'C', codeVerifier: 'V', redirectUri: 'https://app/cb' });
    expect(form!.get('code_verifier')).toBe('V');
    expect(r.tokens.refreshToken).toBe('RT');
    expect(r.account).toEqual({ externalId: '123', label: 'me@example.com', email: 'me@example.com' });
  });

  it('maps revoked refresh tokens to auth_expired', async () => {
    server.use(http.post('https://oauth2.googleapis.com/token', () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 })));
    const err = await googleConnector.refresh!(ctx().tokens, { clientId: 'c', clientSecret: 's' }).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err.code).toBe('auth_expired');
  });

  it('normalizes calendar events and gmail threads', async () => {
    server.use(
      http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
        HttpResponse.json({
          summary: 'me@example.com',
          items: [
            { id: 'e1', summary: 'Budget review', status: 'confirmed', htmlLink: 'https://cal/e1', start: { dateTime: '2026-10-29T10:00:00-04:00' }, end: { dateTime: '2026-10-29T11:00:00-04:00' },
              attendees: [{ email: 'me@example.com', self: true, responseStatus: 'accepted' }, { email: 'Dana@x.com', displayName: 'Dana', responseStatus: 'needsAction', organizer: true }, { email: 'room@x.com', resource: true }],
              description: '<b>Agenda</b><br>1. Numbers' },
            { id: 'e2', summary: 'Offsite', start: { date: '2026-10-30' }, end: { date: '2026-10-31' } },
          ],
        }),
      ),
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/threads', () => HttpResponse.json({ threads: [{ id: 't1' }, { id: 't2' }] })),
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/threads/:id', ({ params }) => {
        if (params.id === 't1')
          return HttpResponse.json({ id: 't1', messages: [
            { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'], snippet: 'Can you approve?', internalDate: String(Date.parse('2026-10-29T11:00:00Z')),
              payload: { headers: [{ name: 'From', value: 'Dana <dana@x.com>' }, { name: 'To', value: 'Me <me@example.com>' }, { name: 'Subject', value: 'Budget' }],
                mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Can you approve?\n\nOn Mon, Bob wrote:\n> old') } }] } },
          ] });
        return HttpResponse.json({ id: 't2', messages: [
          { id: 'm2', threadId: 't2', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], snippet: 'Sale', internalDate: String(Date.parse('2026-10-29T09:00:00Z')), payload: { headers: [{ name: 'From', value: 'Shop <deals@shop.com>' }, { name: 'Subject', value: 'Sale' }, { name: 'List-Unsubscribe', value: '<x>' }] } },
          { id: 'm3', threadId: 't2', labelIds: ['SENT'], internalDate: String(Date.parse('2026-10-29T10:00:00Z')), payload: { headers: [{ name: 'From', value: 'me@example.com' }, { name: 'Subject', value: 'Re: Sale' }] } },
        ] });
      }),
    );
    const r = await googleConnector.sync(ctx());
    const events = r.items.filter((i) => i.kind === 'event');
    const emails = r.items.filter((i) => i.kind === 'email');
    expect(events).toHaveLength(2);
    const e1 = events[0]! as any;
    expect(e1.data.attendees).toHaveLength(2);
    expect(e1.data.description).toBe('Agenda\n1. Numbers');
    expect(e1.data.selfResponse).toBe('accepted');
    expect((events[1] as any).data.allDay).toBe(true);
    const t1 = emails.find((e) => e.externalId === 't1')! as any;
    expect(t1.data).toMatchObject({ isImportant: true, isUnread: true, directToMe: true, lastMessageFromMe: false, bodyText: 'Can you approve?' });
    expect(t1.url).toContain('#all/t1');
    const t2 = emails.find((e) => e.externalId === 't2')! as any;
    expect(t2.data.isBulk).toBe(true);
    expect(t2.data.lastMessageFromMe).toBe(true);
    expect(r.replaceWindows[0]!.kind).toBe('event');
  });

  it('tells rate limits and disabled APIs apart from missing permissions', async () => {
    const cal = http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', () => HttpResponse.json({ items: [] }));
    const gmail403 = (reason: string) =>
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/threads', () => HttpResponse.json({ error: { code: 403, errors: [{ reason }], message: reason } }, { status: 403 }));
    const codeFor = async (reason: string) => {
      server.use(cal, gmail403(reason));
      return ((await googleConnector.sync(ctx()).catch((e) => e)) as IntegrationError).code;
    };
    expect(await codeFor('userRateLimitExceeded')).toBe('rate_limited');
    expect(await codeFor('accessNotConfigured')).toBe('config_missing');
    expect(await codeFor('insufficientPermissions')).toBe('insufficient_scope');
  });

  it('explains when Gmail access was unticked on the consent screen', async () => {
    const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly'];
    const err = (await googleConnector.sync(ctx({ tokens: { ...ctx().tokens, scopes } })).catch((e) => e)) as IntegrationError;
    expect(err.code).toBe('insufficient_scope');
    expect(err.message).toMatch(/Gmail/);
    expect(err.message).not.toMatch(/Calendar/);
  });

  it('skips a thread that disappears mid-sync', async () => {
    server.use(
      http.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', () => HttpResponse.json({ items: [] })),
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/threads', () => HttpResponse.json({ threads: [{ id: 'gone' }] })),
      http.get('https://gmail.googleapis.com/gmail/v1/users/me/threads/gone', () => HttpResponse.json({ error: { code: 404 } }, { status: 404 })),
    );
    const r = await googleConnector.sync(ctx());
    expect(r.items.filter((i) => i.kind === 'email')).toHaveLength(0);
  });

  it('builds RFC 822 messages without header injection', () => {
    const raw = buildRfc822('me@example.com', { to: ['a@x.com\r\nBcc: evil@x.com'], subject: 'Hi\r\nBcc: evil@x.com', body: 'Body' });
    const text = Buffer.from(raw, 'base64url').toString();
    expect(text.split('\r\n').filter((l) => l.startsWith('Bcc:'))).toHaveLength(0);
  });
});

describe('Microsoft Graph', () => {
  it('detects replied conversations via Sent Items', async () => {
    server.use(
      http.get('https://graph.microsoft.com/v1.0/me/calendarView', () => HttpResponse.json({ value: [
        { id: 'ev', subject: 'Sync', start: { dateTime: '2026-10-29T15:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-29T15:30:00.0000000', timeZone: 'UTC' }, isOrganizer: true, webLink: 'https://outlook/ev' },
      ] })),
      http.get('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages', () => HttpResponse.json({ value: [
        { id: 'a', conversationId: 'c1', subject: 'Contract', bodyPreview: 'Please sign', receivedDateTime: '2026-10-29T10:00:00Z', isRead: false, importance: 'high', inferenceClassification: 'focused', from: { emailAddress: { name: 'Lee', address: 'lee@x.com' } }, toRecipients: [{ emailAddress: { address: 'me@example.com' } }], webLink: 'https://outlook/a' },
        { id: 'b', conversationId: 'c2', subject: 'Digest', bodyPreview: 'news', receivedDateTime: '2026-10-29T09:00:00Z', isRead: true, inferenceClassification: 'other', from: { emailAddress: { address: 'news@x.com' } }, toRecipients: [] },
      ] })),
      http.get('https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages', () => HttpResponse.json({ value: [{ id: 's', conversationId: 'c1', sentDateTime: '2026-10-29T11:00:00Z' }] })),
    );
    const r = await microsoftConnector.sync(ctx());
    const ev = r.items.find((i) => i.kind === 'event')! as any;
    expect(ev.data.start).toBe('2026-10-29T15:00:00Z');
    expect(ev.data.attendees.some((a: any) => a.self)).toBe(true);
    const c1 = r.items.find((i) => i.externalId === 'c1')! as any;
    expect(c1.data.lastMessageFromMe).toBe(true);
    expect(c1.data.isImportant).toBe(true);
    expect((r.items.find((i) => i.externalId === 'c2') as any).data.isBulk).toBe(true);
  });

  it('requests Mail.Send only on the write tier', () => {
    const f = { calendar: false, email: true, messages: false, tasks: false };
    expect(microsoftConnector.scopesFor(f, 'draft')).not.toContain('Mail.Send');
    expect(microsoftConnector.scopesFor(f, 'write')).toContain('Mail.Send');
  });
});

describe('Slack', () => {
  it('keeps DMs and mentions only, with permalinks and resolved names', async () => {
    server.use(
      http.get('https://slack.com/api/users.conversations', () => HttpResponse.json({ ok: true, channels: [{ id: 'D1', is_im: true }, { id: 'C1', name: 'general', updated: 5 }] })),
      http.get('https://slack.com/api/conversations.history', ({ request }) => {
        const ch = new URL(request.url).searchParams.get('channel');
        if (ch === 'D1') return HttpResponse.json({ ok: true, messages: [{ ts: '1761740000.000100', user: 'U2', text: 'Can you review?' }] });
        return HttpResponse.json({ ok: true, messages: [
          { ts: '1761740100.000200', user: 'U3', text: 'hey <@UME> please check' },
          { ts: '1761740200.000300', user: 'U3', text: 'random chatter' },
          { ts: '1761740300.000400', user: 'U3', subtype: 'channel_join', text: 'joined' },
        ] });
      }),
      http.get('https://slack.com/api/users.info', ({ request }) => {
        const u = new URL(request.url).searchParams.get('user');
        return HttpResponse.json({ ok: true, user: { real_name: u === 'UME' ? 'Me' : u === 'U2' ? 'Priya' : 'Marcus' } });
      }),
    );
    const r = await slackConnector.sync(ctx({ tokens: { accessToken: 'xoxp', refreshToken: null, expiresAt: null, scopes: [], extra: { userId: 'UME', teamUrl: 'https://acme.slack.com/' } } }));
    expect(r.items).toHaveLength(2);
    const dm = r.items.find((i) => i.externalId.startsWith('D1'))! as any;
    expect(dm.data).toMatchObject({ channelType: 'dm', awaitingReply: true });
    expect(dm.url).toBe('https://acme.slack.com/archives/D1/p1761740000000100');
    const mention = r.items.find((i) => i.externalId.startsWith('C1'))! as any;
    expect(mention.data.mentionsMe).toBe(true);
    expect(mention.data.text).toBe('hey @Me please check');
  });

  it('maps invalid_auth to auth_expired', async () => {
    server.use(http.get('https://slack.com/api/users.conversations', () => HttpResponse.json({ ok: false, error: 'invalid_auth' })));
    const err = await slackConnector.sync(ctx()).catch((e) => e);
    expect(err.code).toBe('auth_expired');
  });
});

describe('Todoist', () => {
  it('maps priorities, all-day and timed due dates', () => {
    const a = mapTodoistTask({ id: '1', content: 'A', priority: 4, due: { date: '2026-10-30' } }, 'America/New_York');
    expect(a).toMatchObject({ priority: 'urgent', dueIsAllDay: true, dueAt: '2026-10-30T00:00:00.000-04:00' });
    const b = mapTodoistTask({ id: '2', content: 'B', priority: 1, due: { date: '2026-10-30', datetime: '2026-10-30T15:00:00Z' }, duration: { amount: 45, unit: 'minute' } }, 'America/New_York');
    expect(b).toMatchObject({ priority: 'low', dueIsAllDay: false, estimateMinutes: 45 });
  });

  it('syncs active and recently completed tasks', async () => {
    server.use(
      http.get('https://api.todoist.com/api/v1/tasks', () => HttpResponse.json({ results: [{ id: '1', content: 'Active', priority: 2 }], next_cursor: null })),
      http.get('https://api.todoist.com/api/v1/tasks/completed/by_completion_date', () => HttpResponse.json({ items: [{ id: '9', content: 'Done', completed_at: '2026-10-29T12:00:00Z' }] })),
    );
    const r = await todoistConnector.sync(ctx());
    expect(r.tasks.map((t) => [t.title, t.completed])).toEqual([['Active', false], ['Done', true]]);
  });
});

describe('Demo data', () => {
  it('is clearly sourced as demo, has no external links and includes realistic scenarios', () => {
    const d = generateDemoData(now, 'America/New_York', 'me@example.com');
    expect(d.items.every((i) => i.source === 'demo' && i.url === null)).toBe(true);
    expect(d.items.filter((i) => i.kind === 'event').length).toBeGreaterThan(5);
    expect(d.tasks.length).toBeGreaterThan(4);
  });

  it('refuses OAuth flows', () => {
    expect(() => demoConnector.buildAuthUrl({ creds: { clientId: '', clientSecret: '' }, redirectUri: '', state: '', codeChallenge: '', scopes: [] })).toThrow(IntegrationError);
  });
});
