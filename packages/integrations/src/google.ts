import { DateTime } from 'luxon';
import type { AttendeeResponse, EmailData, EventData } from '@secretary/core';
import { BULK_SENDER, expiresAtFrom, htmlToText, mapLimit, parseAddress, parseAddressList, request, stripQuoted } from './http.js';
import type { ActionResult, Connector, CreateEventInput, DraftEmailInput, Features, NewItem, SyncContext, SyncResult, Tier, TokenSet } from './types.js';
import { IntegrationError } from './types.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CAL = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

const S = {
  calRead: 'https://www.googleapis.com/auth/calendar.readonly',
  calEvents: 'https://www.googleapis.com/auth/calendar.events',
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  gmailCompose: 'https://www.googleapis.com/auth/gmail.compose',
};

interface GToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function toTokenSet(t: GToken, prev: TokenSet | null, now: Date): TokenSet {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? prev?.refreshToken ?? null,
    expiresAt: expiresAtFrom(now, t.expires_in),
    scopes: t.scope ? t.scope.split(' ') : prev?.scopes ?? [],
    extra: prev?.extra ?? {},
  };
}

export const googleConnector: Connector = {
  provider: 'google',
  name: 'Google (Gmail & Calendar)',
  supports: { calendar: true, email: true, messages: false, tasks: false },
  usesPkce: true,

  scopesFor(f: Features, tier: Tier) {
    const s = ['openid', 'email', 'profile'];
    if (f.calendar) s.push(tier === 'write' ? S.calEvents : S.calRead);
    if (f.email) {
      s.push(S.gmailRead);
      // Google has no drafts-only scope: gmail.compose covers creating drafts and sending.
      // The app still enforces the selected tier before any send.
      if (tier !== 'read') s.push(S.gmailCompose);
    }
    return s;
  },

  describeScopes(f, tier) {
    const out = [{ scope: 'openid email profile', why: 'Identify which Google account you connected.' }];
    if (f.calendar)
      out.push(
        tier === 'write'
          ? { scope: 'calendar.events', why: 'Read your events and, only after you approve, create focus blocks or events.' }
          : { scope: 'calendar.readonly', why: 'Read your calendar to plan your day and prepare meetings.' },
      );
    if (f.email) {
      out.push({ scope: 'gmail.readonly', why: 'Read recent inbox threads to find what needs your attention.' });
      if (tier !== 'read')
        out.push({
          scope: 'gmail.compose',
          why:
            tier === 'draft'
              ? 'Create reply drafts you approve. Google bundles sending into this scope; the app will never send while you are on the “Drafts” permission level.'
              : 'Create drafts and send emails — each send requires your explicit approval.',
        });
    }
    return out;
  },

  buildAuthUrl({ creds, redirectUri, state, codeChallenge, scopes }) {
    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    }).toString();
    return u.toString();
  },

  async exchangeCode({ creds, code, codeVerifier, redirectUri }) {
    const now = new Date();
    const t = await request<GToken>('Google', TOKEN_URL, {
      form: { code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier },
    });
    const tokens = toTokenSet(t, null, now);
    const me = await request<{ sub: string; email?: string; name?: string }>('Google', USERINFO_URL, { token: tokens.accessToken });
    return { tokens, account: { externalId: me.sub, label: me.email ?? me.name ?? 'Google account', email: me.email ?? null } };
  },

  async refresh(tokens, creds) {
    if (!tokens.refreshToken) throw new IntegrationError('auth_expired', 'Google refresh token missing; reconnect the account');
    const t = await request<GToken>('Google', TOKEN_URL, {
      form: { client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: tokens.refreshToken, grant_type: 'refresh_token' },
    }).catch((e) => {
      // invalid_grant comes back as 400: the user revoked access or the token expired.
      if (e instanceof IntegrationError && e.code === 'bad_response') throw new IntegrationError('auth_expired', 'Google access was revoked; reconnect the account');
      throw e;
    });
    return toTokenSet(t, tokens, new Date());
  },

  async revoke(tokens) {
    await request('Google', REVOKE_URL, { form: { token: tokens.refreshToken ?? tokens.accessToken } }).catch(() => undefined);
  },

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const items: NewItem[] = [];
    const replaceWindows: SyncResult['replaceWindows'] = [];
    if (ctx.features.calendar) {
      const from = DateTime.fromJSDate(ctx.now).setZone(ctx.timezone).startOf('day').minus({ days: 1 });
      const to = from.plus({ days: 9 });
      items.push(...(await syncCalendar(ctx, from.toISO()!, to.toISO()!)));
      replaceWindows.push({ kind: 'event', from: from.toISO()!, to: to.toISO()! });
    }
    if (ctx.features.email) items.push(...(await syncGmail(ctx)));
    return { items, tasks: [], replaceWindows, syncState: { ...ctx.syncState, lastFullSync: ctx.now.toISOString() } };
  },

  async createDraft(ctx, input) {
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    if (input.replyToExternalId) {
      threadId = input.replyToExternalId;
      const th = await request<GThread>('Gmail', `${GMAIL}/threads/${encodeURIComponent(threadId)}`, {
        token: ctx.tokens.accessToken,
        query: { format: 'metadata', metadataHeaders: 'Message-ID' },
      });
      const last = th.messages?.[th.messages.length - 1];
      inReplyTo = header(last, 'Message-ID') ?? undefined;
    }
    const raw = buildRfc822(ctx.account.email ?? '', input, inReplyTo);
    const d = await request<{ id: string; message: { id: string; threadId: string } }>('Gmail', `${GMAIL}/drafts`, {
      token: ctx.tokens.accessToken,
      json: { message: { raw, threadId } },
    });
    return { draftId: d.id, externalId: d.message.threadId, url: gmailUrl(ctx.account.email, d.message.threadId), message: 'Draft saved in Gmail' };
  },

  async sendDraft(ctx, draftId) {
    const r = await request<{ id: string; threadId: string }>('Gmail', `${GMAIL}/drafts/send`, { token: ctx.tokens.accessToken, json: { id: draftId } });
    return { externalId: r.threadId, url: gmailUrl(ctx.account.email, r.threadId), message: 'Email sent from Gmail' };
  },

  async createEvent(ctx, input: CreateEventInput): Promise<ActionResult> {
    const ev = await request<{ id: string; htmlLink: string }>('Google Calendar', `${CAL}/calendars/primary/events`, {
      token: ctx.tokens.accessToken,
      json: {
        summary: input.title,
        description: input.description,
        start: { dateTime: input.start, timeZone: input.timezone },
        end: { dateTime: input.end, timeZone: input.timezone },
        attendees: input.attendees?.map((email) => ({ email })),
        transparency: 'opaque',
      },
    });
    return { externalId: ev.id, url: ev.htmlLink, message: 'Event created in Google Calendar' };
  },
};

// ---------------------------------------------------------------------------

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  updated?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; organizer?: boolean; self?: boolean; resource?: boolean }[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  eventType?: string;
}

const RESP: Record<string, AttendeeResponse> = { accepted: 'accepted', declined: 'declined', tentative: 'tentative', needsAction: 'needsAction' };

async function syncCalendar(ctx: SyncContext, timeMin: string, timeMax: string): Promise<NewItem[]> {
  const out: NewItem[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const r = await request<{ items?: GEvent[]; nextPageToken?: string; summary?: string }>('Google Calendar', `${CAL}/calendars/primary/events`, {
      token: ctx.tokens.accessToken,
      query: { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 250, pageToken },
    });
    for (const e of r.items ?? []) {
      if (e.eventType === 'workingLocation') continue;
      const allDay = !e.start?.dateTime;
      const start = e.start?.dateTime ?? DateTime.fromISO(e.start?.date ?? timeMin, { zone: ctx.timezone }).toISO()!;
      const end = e.end?.dateTime ?? DateTime.fromISO(e.end?.date ?? timeMin, { zone: ctx.timezone }).toISO()!;
      const attendees = (e.attendees ?? [])
        .filter((a) => !a.resource)
        .map((a) => ({
          name: a.displayName ?? null,
          email: a.email?.toLowerCase() ?? null,
          response: RESP[a.responseStatus ?? ''] ?? 'unknown',
          organizer: !!a.organizer,
          self: !!a.self,
        }));
      const self = attendees.find((a) => a.self);
      const data: EventData = {
        start,
        end,
        allDay,
        location: e.location ?? null,
        description: htmlToText(e.description ?? '').slice(0, 4000),
        attendees,
        organizer: e.organizer ? { name: e.organizer.displayName ?? null, email: e.organizer.email ?? null } : null,
        conferenceUrl: e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null,
        status: e.status === 'cancelled' ? 'cancelled' : e.status === 'tentative' ? 'tentative' : 'confirmed',
        // Events you organize without an attendee list are implicitly accepted.
        selfResponse: self?.response ?? (e.organizer?.self || attendees.length === 0 ? 'accepted' : 'unknown'),
        calendarName: r.summary ?? null,
      };
      out.push({
        kind: 'event',
        source: 'google',
        externalId: e.id,
        title: e.summary ?? '(No title)',
        url: e.htmlLink ?? null,
        occurredAt: start,
        updatedAt: e.updated ?? start,
        data,
      });
    }
    pageToken = r.nextPageToken;
  } while (pageToken && ++pages < 5);
  return out;
}

interface GHeader {
  name: string;
  value: string;
}
interface GPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GPart[];
  headers?: GHeader[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GPart;
}
interface GThread {
  id: string;
  messages?: GMessage[];
}

function header(m: GMessage | undefined, name: string): string | null {
  return m?.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function decodeB64Url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function extractText(p: GPart | undefined): string {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body?.data) return decodeB64Url(p.body.data);
  if (p.parts) {
    const plain = p.parts.map(extractText).find((t) => t.trim());
    if (plain) return plain;
  }
  if (p.mimeType === 'text/html' && p.body?.data) return htmlToText(decodeB64Url(p.body.data));
  return '';
}

function gmailUrl(email: string | null, threadId: string) {
  return `https://mail.google.com/mail/u/${encodeURIComponent(email ?? '0')}/#all/${threadId}`;
}

async function syncGmail(ctx: SyncContext): Promise<NewItem[]> {
  const me = (ctx.account.email ?? '').toLowerCase();
  const list = await request<{ threads?: { id: string }[] }>('Gmail', `${GMAIL}/threads`, {
    token: ctx.tokens.accessToken,
    query: { q: 'in:inbox newer_than:7d -in:chats', maxResults: 40 },
  });
  const ids = (list.threads ?? []).map((t) => t.id);
  const threads = await mapLimit(ids, 5, (id) =>
    request<GThread>('Gmail', `${GMAIL}/threads/${id}`, {
      token: ctx.tokens.accessToken,
      query: ctx.includeBodies ? { format: 'full' } : { format: 'metadata' },
    }),
  );
  const out: NewItem[] = [];
  for (const th of threads) {
    const msgs = th.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (!last) continue;
    const lastInbound = [...msgs].reverse().find((m) => !(m.labelIds ?? []).includes('SENT')) ?? last;
    const labels = Array.from(new Set(msgs.flatMap((m) => m.labelIds ?? [])));
    const from = parseAddress(header(lastInbound, 'From') ?? '');
    const to = parseAddressList(header(lastInbound, 'To') ?? undefined);
    const cc = parseAddressList(header(lastInbound, 'Cc') ?? undefined);
    const lastFromMe = (last.labelIds ?? []).includes('SENT') || parseAddress(header(last, 'From') ?? '').email === me;
    const isBulk =
      !!header(lastInbound, 'List-Unsubscribe') ||
      labels.some((l) => ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'].includes(l)) ||
      BULK_SENDER.test(from.email ?? '');
    const body = ctx.includeBodies ? stripQuoted(extractText(lastInbound.payload)).slice(0, 4000) : '';
    const occurredAt = new Date(Number(lastInbound.internalDate ?? Date.now())).toISOString();
    const updatedAt = new Date(Number(last.internalDate ?? Date.now())).toISOString();
    const data: EmailData = {
      threadId: th.id,
      from,
      to,
      cc,
      snippet: decodeEntities(lastInbound.snippet ?? ''),
      bodyText: body,
      labels,
      isUnread: labels.includes('UNREAD'),
      isImportant: labels.includes('IMPORTANT') || labels.includes('STARRED'),
      lastMessageFromMe: lastFromMe,
      messageCount: msgs.length,
      isBulk,
      directToMe: to.some((a) => a.email === me),
    };
    out.push({
      kind: 'email',
      source: 'google',
      externalId: th.id,
      title: header(lastInbound, 'Subject') ?? '(No subject)',
      url: gmailUrl(ctx.account.email, th.id),
      occurredAt,
      updatedAt,
      data,
    });
  }
  return out;
}

function decodeEntities(s: string) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** RFC 822 message, base64url-encoded, with header-injection-safe fields. */
export function buildRfc822(from: string, input: DraftEmailInput, inReplyTo?: string): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const encSubject = /^[\x20-\x7e]*$/.test(input.subject) ? clean(input.subject) : `=?UTF-8?B?${Buffer.from(clean(input.subject)).toString('base64')}?=`;
  const lines = [
    from ? `From: ${clean(from)}` : null,
    `To: ${input.to.map(clean).join(', ')}`,
    input.cc?.length ? `Cc: ${input.cc.map(clean).join(', ')}` : null,
    `Subject: ${encSubject}`,
    inReplyTo ? `In-Reply-To: ${clean(inReplyTo)}` : null,
    inReplyTo ? `References: ${clean(inReplyTo)}` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.body.replace(/\r?\n/g, '\r\n'),
  ].filter((l): l is string => l !== null);
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}
