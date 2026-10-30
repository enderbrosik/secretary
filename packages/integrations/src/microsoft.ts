import { DateTime } from 'luxon';
import type { AttendeeResponse, EmailData, EventData } from '@secretary/core';
import { BULK_SENDER, expiresAtFrom, htmlToText, request, stripQuoted } from './http.js';
import type { Connector, Features, NewItem, SyncContext, SyncResult, Tier, TokenSet } from './types.js';
import { IntegrationError } from './types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const authBase = (tenant = 'common') => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;

interface MsToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function toTokenSet(t: MsToken, prev: TokenSet | null): TokenSet {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? prev?.refreshToken ?? null,
    expiresAt: expiresAtFrom(new Date(), t.expires_in),
    scopes: t.scope ? t.scope.split(' ') : prev?.scopes ?? [],
    extra: prev?.extra ?? {},
  };
}

/** Public clients (desktop apps) have no secret and rely on PKCE. */
const secret = (creds: { clientSecret: string }): Record<string, string> => (creds.clientSecret ? { client_secret: creds.clientSecret } : {});

export const microsoftConnector: Connector = {
  provider: 'microsoft',
  name: 'Microsoft 365 (Outlook & Calendar)',
  supports: { calendar: true, email: true, messages: false, tasks: false },
  usesPkce: true,

  scopesFor(f: Features, tier: Tier) {
    const s = ['openid', 'email', 'offline_access', 'User.Read'];
    if (f.calendar) s.push(tier === 'write' ? 'Calendars.ReadWrite' : 'Calendars.Read');
    if (f.email) {
      s.push('Mail.Read');
      if (tier !== 'read') s.push('Mail.ReadWrite'); // create drafts
      if (tier === 'write') s.push('Mail.Send');
    }
    return s;
  },

  describeScopes(f, tier) {
    const out = [
      { scope: 'User.Read', why: 'Identify which Microsoft account you connected.' },
      { scope: 'offline_access', why: 'Keep syncing in the background without asking you to sign in again.' },
    ];
    if (f.calendar)
      out.push(
        tier === 'write'
          ? { scope: 'Calendars.ReadWrite', why: 'Read events and, only after you approve, create events or focus blocks.' }
          : { scope: 'Calendars.Read', why: 'Read your calendar to plan your day and prepare meetings.' },
      );
    if (f.email) {
      out.push({ scope: 'Mail.Read', why: 'Read recent inbox messages to find what needs your attention.' });
      if (tier !== 'read') out.push({ scope: 'Mail.ReadWrite', why: 'Save reply drafts you approve in your Drafts folder.' });
      if (tier === 'write') out.push({ scope: 'Mail.Send', why: 'Send emails — only after your explicit approval of each one.' });
    }
    return out;
  },

  buildAuthUrl({ creds, redirectUri, state, codeChallenge, scopes }) {
    const u = new URL(`${authBase(creds.tenant)}/authorize`);
    u.search = new URLSearchParams({
      client_id: creds.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return u.toString();
  },

  async exchangeCode({ creds, code, codeVerifier, redirectUri }) {
    const t = await request<MsToken>('Microsoft', `${authBase(creds.tenant)}/token`, {
      form: { client_id: creds.clientId, ...secret(creds), code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier },
    });
    const tokens = toTokenSet(t, null);
    const me = await request<{ id: string; mail?: string | null; userPrincipalName?: string; displayName?: string }>('Microsoft', `${GRAPH}/me`, {
      token: tokens.accessToken,
      query: { $select: 'id,mail,userPrincipalName,displayName' },
    });
    const email = (me.mail ?? me.userPrincipalName ?? '').toLowerCase() || null;
    return { tokens, account: { externalId: me.id, label: email ?? me.displayName ?? 'Microsoft account', email } };
  },

  async refresh(tokens, creds) {
    if (!tokens.refreshToken) throw new IntegrationError('auth_expired', 'Microsoft refresh token missing; reconnect the account');
    const t = await request<MsToken>('Microsoft', `${authBase(creds.tenant)}/token`, {
      form: { client_id: creds.clientId, ...secret(creds), refresh_token: tokens.refreshToken, grant_type: 'refresh_token' },
    }).catch((e) => {
      if (e instanceof IntegrationError && e.code === 'bad_response') throw new IntegrationError('auth_expired', 'Microsoft access was revoked; reconnect the account');
      throw e;
    });
    return toTokenSet(t, tokens);
  },

  // Microsoft identity platform has no token revocation endpoint for this flow; tokens are deleted
  // locally and the user can remove the app at https://myapps.microsoft.com (documented).

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const items: NewItem[] = [];
    const replaceWindows: SyncResult['replaceWindows'] = [];
    if (ctx.features.calendar) {
      const from = DateTime.fromJSDate(ctx.now).setZone(ctx.timezone).startOf('day').minus({ days: 1 });
      const to = from.plus({ days: 9 });
      items.push(...(await syncCalendar(ctx, from.toUTC().toISO()!, to.toUTC().toISO()!)));
      replaceWindows.push({ kind: 'event', from: from.toISO()!, to: to.toISO()! });
    }
    if (ctx.features.email) items.push(...(await syncMail(ctx)));
    return { items, tasks: [], replaceWindows, syncState: { ...ctx.syncState, lastFullSync: ctx.now.toISOString() } };
  },

  async createDraft(ctx, input) {
    const msg = {
      subject: input.subject,
      body: { contentType: 'Text', content: input.body },
      toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: (input.cc ?? []).map((address) => ({ emailAddress: { address } })),
    };
    let draft: { id: string; webLink?: string; conversationId?: string };
    if (input.replyToExternalId) {
      // replyToExternalId is the conversation; reply to its latest message.
      const latest = await request<{ value: { id: string }[] }>('Outlook', `${GRAPH}/me/messages`, {
        token: ctx.tokens.accessToken,
        query: { $filter: `conversationId eq '${input.replyToExternalId.replace(/'/g, "''")}'`, $top: 1, $select: 'id' },
      });
      const id = latest.value[0]?.id;
      if (!id) throw new IntegrationError('bad_response', 'Original message not found');
      draft = await request('Outlook', `${GRAPH}/me/messages/${encodeURIComponent(id)}/createReply`, { token: ctx.tokens.accessToken, json: { message: msg } });
    } else {
      draft = await request('Outlook', `${GRAPH}/me/messages`, { token: ctx.tokens.accessToken, json: msg });
    }
    return { draftId: draft.id, externalId: draft.conversationId ?? null, url: draft.webLink ?? null, message: 'Draft saved in Outlook' };
  },

  async sendDraft(ctx, draftId) {
    await request('Outlook', `${GRAPH}/me/messages/${encodeURIComponent(draftId)}/send`, { token: ctx.tokens.accessToken, method: 'POST' });
    return { externalId: draftId, url: null, message: 'Email sent from Outlook' };
  },

  async createEvent(ctx, input) {
    const ev = await request<{ id: string; webLink?: string }>('Outlook Calendar', `${GRAPH}/me/events`, {
      token: ctx.tokens.accessToken,
      json: {
        subject: input.title,
        body: { contentType: 'Text', content: input.description ?? '' },
        start: { dateTime: DateTime.fromISO(input.start).setZone(input.timezone).toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone: input.timezone },
        end: { dateTime: DateTime.fromISO(input.end).setZone(input.timezone).toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone: input.timezone },
        showAs: 'busy',
        attendees: (input.attendees ?? []).map((address) => ({ emailAddress: { address }, type: 'required' })),
      },
    });
    return { externalId: ev.id, url: ev.webLink ?? null, message: 'Event created in Outlook Calendar' };
  },
};

interface MsEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  location?: { displayName?: string };
  webLink?: string;
  lastModifiedDateTime?: string;
  onlineMeeting?: { joinUrl?: string } | null;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  isOrganizer?: boolean;
  responseStatus?: { response?: string };
  attendees?: { type?: string; emailAddress?: { name?: string; address?: string }; status?: { response?: string } }[];
}

const MS_RESP: Record<string, AttendeeResponse> = {
  accepted: 'accepted',
  organizer: 'accepted',
  declined: 'declined',
  tentativelyAccepted: 'tentative',
  notResponded: 'needsAction',
  none: 'unknown',
};

/** Graph returns naive date-times when Prefer: outlook.timezone="UTC" is set. */
const utc = (s: string) => (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s.replace(/\.\d+$/, '')}Z`);

async function syncCalendar(ctx: SyncContext, from: string, to: string): Promise<NewItem[]> {
  const me = (ctx.account.email ?? '').toLowerCase();
  const out: NewItem[] = [];
  let url: string | undefined = `${GRAPH}/me/calendarView`;
  let query: Record<string, string | number> | undefined = {
    startDateTime: from,
    endDateTime: to,
    $top: 100,
    $select: 'id,subject,bodyPreview,body,start,end,isAllDay,isCancelled,showAs,location,webLink,lastModifiedDateTime,onlineMeeting,organizer,isOrganizer,responseStatus,attendees',
  };
  let pages = 0;
  while (url && pages++ < 5) {
    const r: { value: MsEvent[]; '@odata.nextLink'?: string } = await request('Outlook Calendar', url, {
      token: ctx.tokens.accessToken,
      query,
      headers: { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' },
    });
    for (const e of r.value) {
      const start = utc(e.start.dateTime);
      const end = utc(e.end.dateTime);
      const selfResponse = e.isOrganizer ? 'accepted' : MS_RESP[e.responseStatus?.response ?? 'none'] ?? 'unknown';
      const attendees = (e.attendees ?? [])
        .filter((a) => a.type !== 'resource')
        .map((a) => ({
          name: a.emailAddress?.name ?? null,
          email: a.emailAddress?.address?.toLowerCase() ?? null,
          response: MS_RESP[a.status?.response ?? 'none'] ?? 'unknown',
          organizer: a.emailAddress?.address?.toLowerCase() === e.organizer?.emailAddress?.address?.toLowerCase(),
          self: a.emailAddress?.address?.toLowerCase() === me,
        }));
      if (!attendees.some((a) => a.self)) attendees.push({ name: null, email: me || null, response: selfResponse, organizer: !!e.isOrganizer, self: true });
      const data: EventData = {
        start,
        end,
        allDay: !!e.isAllDay,
        location: e.location?.displayName || null,
        description: (e.body?.contentType === 'html' ? htmlToText(e.body.content ?? '') : e.body?.content ?? e.bodyPreview ?? '').slice(0, 4000),
        attendees,
        organizer: e.organizer?.emailAddress ? { name: e.organizer.emailAddress.name ?? null, email: e.organizer.emailAddress.address?.toLowerCase() ?? null } : null,
        conferenceUrl: e.onlineMeeting?.joinUrl ?? null,
        status: e.isCancelled ? 'cancelled' : e.showAs === 'tentative' ? 'tentative' : 'confirmed',
        selfResponse,
        calendarName: 'Calendar',
      };
      out.push({ kind: 'event', source: 'microsoft', externalId: e.id, title: e.subject || '(No title)', url: e.webLink ?? null, occurredAt: start, updatedAt: e.lastModifiedDateTime ?? start, data });
    }
    url = r['@odata.nextLink'];
    query = undefined; // nextLink already contains the query
  }
  return out;
}

interface MsMessage {
  id: string;
  conversationId: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  importance?: string;
  inferenceClassification?: string;
  flag?: { flagStatus?: string };
  webLink?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
}

const addr = (a?: { emailAddress?: { name?: string; address?: string } }) => ({ name: a?.emailAddress?.name ?? null, email: a?.emailAddress?.address?.toLowerCase() ?? null });

async function syncMail(ctx: SyncContext): Promise<NewItem[]> {
  const me = (ctx.account.email ?? '').toLowerCase();
  const since = DateTime.fromJSDate(ctx.now).minus({ days: 7 }).toUTC().toISO()!;
  const select = `id,conversationId,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,importance,inferenceClassification,flag,webLink,from,toRecipients,ccRecipients${ctx.includeBodies ? ',body' : ''}`;
  const [inbox, sent] = await Promise.all([
    request<{ value: MsMessage[] }>('Outlook', `${GRAPH}/me/mailFolders/inbox/messages`, {
      token: ctx.tokens.accessToken,
      query: { $filter: `receivedDateTime ge ${since}`, $orderby: 'receivedDateTime desc', $top: 50, $select: select },
      headers: { Prefer: 'outlook.body-content-type="text"' },
    }),
    request<{ value: MsMessage[] }>('Outlook', `${GRAPH}/me/mailFolders/sentitems/messages`, {
      token: ctx.tokens.accessToken,
      query: { $filter: `sentDateTime ge ${since}`, $orderby: 'sentDateTime desc', $top: 50, $select: 'id,conversationId,sentDateTime' },
    }),
  ]);
  const lastSent = new Map<string, string>();
  for (const s of sent.value) if (s.sentDateTime && (!lastSent.has(s.conversationId) || lastSent.get(s.conversationId)! < s.sentDateTime)) lastSent.set(s.conversationId, s.sentDateTime);

  const byConv = new Map<string, MsMessage[]>();
  for (const m of inbox.value) {
    if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
    byConv.get(m.conversationId)!.push(m);
  }
  const out: NewItem[] = [];
  for (const [conv, msgs] of byConv) {
    msgs.sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''));
    const latest = msgs[msgs.length - 1]!;
    const received = latest.receivedDateTime ?? ctx.now.toISOString();
    const sentAt = lastSent.get(conv);
    const lastFromMe = !!sentAt && sentAt > received;
    const from = addr(latest.from);
    const to = (latest.toRecipients ?? []).map(addr);
    const body = ctx.includeBodies ? stripQuoted(latest.body?.contentType === 'html' ? htmlToText(latest.body.content ?? '') : latest.body?.content ?? '').slice(0, 4000) : '';
    const data: EmailData = {
      threadId: conv,
      from,
      to,
      cc: (latest.ccRecipients ?? []).map(addr),
      snippet: latest.bodyPreview ?? '',
      bodyText: body,
      labels: [latest.inferenceClassification ?? 'focused'],
      isUnread: msgs.some((m) => !m.isRead),
      isImportant: latest.importance === 'high' || latest.flag?.flagStatus === 'flagged',
      lastMessageFromMe: lastFromMe,
      messageCount: msgs.length + (sentAt ? 1 : 0),
      isBulk: latest.inferenceClassification === 'other' || BULK_SENDER.test(from.email ?? ''),
      directToMe: to.some((a) => a.email === me),
    };
    out.push({
      kind: 'email',
      source: 'microsoft',
      externalId: conv,
      title: latest.subject || '(No subject)',
      url: latest.webLink ?? null,
      occurredAt: received,
      updatedAt: sentAt && sentAt > received ? sentAt : received,
      data,
    });
  }
  return out;
}
