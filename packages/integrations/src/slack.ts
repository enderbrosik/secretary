import type { MessageData } from '@secretary/core';
import { expiresAtFrom, mapLimit, request } from './http.js';
import type { Connector, NewItem, SyncContext, SyncResult, TokenSet } from './types.js';
import { IntegrationError } from './types.js';

const API = 'https://slack.com/api';

/** Read-only user scopes: the assistant only sees conversations the user is already a member of. */
const USER_SCOPES = [
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
];

interface SlackResp {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

async function slack<T extends SlackResp>(method: string, token: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const r = await request<T>('Slack', `${API}/${method}`, { token, query });
  if (!r.ok) {
    if (r.error === 'invalid_auth' || r.error === 'token_revoked' || r.error === 'account_inactive' || r.error === 'token_expired')
      throw new IntegrationError('auth_expired', 'Slack authorization expired or was revoked');
    if (r.error === 'missing_scope') throw new IntegrationError('insufficient_scope', 'Slack token is missing a required permission');
    if (r.error === 'ratelimited') throw new IntegrationError('rate_limited', 'Slack rate limit reached', 60);
    throw new IntegrationError('bad_response', `Slack API error (${r.error ?? 'unknown'})`);
  }
  return r;
}

interface OAuthV2 extends SlackResp {
  team?: { id: string; name?: string };
  authed_user?: { id: string; access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
}

export const slackConnector: Connector = {
  provider: 'slack',
  name: 'Slack',
  supports: { calendar: false, email: false, messages: true, tasks: false },
  usesPkce: false,

  scopesFor() {
    return USER_SCOPES;
  },

  describeScopes() {
    return [
      { scope: 'channels:history, groups:history', why: 'Read recent messages in channels you are a member of, to find mentions and requests.' },
      { scope: 'im:history, mpim:history', why: 'Read your direct and group messages to find questions waiting for you.' },
      { scope: '*:read, users:read', why: 'List your conversations and show people’s names instead of IDs.' },
      { scope: '(no write scopes)', why: 'The assistant cannot post, react or change anything in Slack.' },
    ];
  },

  buildAuthUrl({ creds, redirectUri, state, scopes }) {
    const u = new URL('https://slack.com/oauth/v2/authorize');
    u.search = new URLSearchParams({ client_id: creds.clientId, user_scope: scopes.join(','), redirect_uri: redirectUri, state }).toString();
    return u.toString();
  },

  async exchangeCode({ creds, code, redirectUri }) {
    const r = await request<OAuthV2>('Slack', `${API}/oauth.v2.access`, {
      form: { client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirectUri },
    });
    if (!r.ok || !r.authed_user?.access_token) throw new IntegrationError('bad_response', `Slack authorization failed (${r.error ?? 'no user token'})`);
    const token = r.authed_user.access_token;
    const auth = await slack<SlackResp & { url?: string; user?: string; team?: string }>('auth.test', token);
    const tokens: TokenSet = {
      accessToken: token,
      refreshToken: r.authed_user.refresh_token ?? null,
      expiresAt: expiresAtFrom(new Date(), r.authed_user.expires_in),
      scopes: (r.authed_user.scope ?? '').split(',').filter(Boolean),
      extra: { userId: r.authed_user.id, teamId: r.team?.id ?? '', teamUrl: auth.url ?? '' },
    };
    return {
      tokens,
      account: { externalId: `${r.team?.id}:${r.authed_user.id}`, label: `${r.team?.name ?? auth.team ?? 'Slack'} (${auth.user ?? 'you'})`, email: null },
    };
  },

  /** A user token (xoxp-…) from an app the user installed in their own workspace. */
  async connectWithToken(token) {
    if (token.startsWith('xoxb-')) throw new IntegrationError('bad_response', 'That’s a bot token (xoxb-). Copy the “User OAuth Token” (starts with xoxp-) instead — bot tokens can’t see your direct messages.');
    if (!token.startsWith('xoxp-')) throw new IntegrationError('bad_response', 'Slack user tokens start with “xoxp-”. Copy the “User OAuth Token” from your Slack app’s OAuth & Permissions page.');
    let res: Response;
    try {
      res = await fetch(`${API}/auth.test`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new IntegrationError('unavailable', 'Slack could not be reached');
    }
    const auth = (await res.json().catch(() => ({ ok: false }))) as SlackResp & { url?: string; user?: string; user_id?: string; team?: string; team_id?: string };
    if (!auth.ok || !auth.user_id) throw new IntegrationError('auth_expired', 'Slack rejected that token. Check you copied the whole User OAuth Token.');
    const granted = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const missing = USER_SCOPES.filter((sc) => granted.length && !granted.includes(sc));
    if (missing.length) throw new IntegrationError('insufficient_scope', `The Slack app is missing these User Token Scopes: ${missing.join(', ')}. Add them, reinstall the app, then copy the new token.`);
    return {
      tokens: { accessToken: token, refreshToken: null, expiresAt: null, scopes: granted.length ? granted : USER_SCOPES, extra: { userId: auth.user_id, teamId: auth.team_id ?? '', teamUrl: auth.url ?? '' } },
      account: { externalId: `${auth.team_id}:${auth.user_id}`, label: `${auth.team ?? 'Slack'} (${auth.user ?? 'you'})`, email: null },
    };
  },

  async refresh(tokens, creds) {
    // Only applies when token rotation is enabled on the Slack app.
    if (!tokens.refreshToken) return tokens;
    const r = await request<OAuthV2 & { access_token?: string; refresh_token?: string; expires_in?: number }>('Slack', `${API}/oauth.v2.access`, {
      form: { client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
    });
    const at = r.authed_user?.access_token ?? r.access_token;
    if (!r.ok || !at) throw new IntegrationError('auth_expired', 'Slack token refresh failed; reconnect Slack');
    return { ...tokens, accessToken: at, refreshToken: r.authed_user?.refresh_token ?? r.refresh_token ?? tokens.refreshToken, expiresAt: expiresAtFrom(new Date(), r.authed_user?.expires_in ?? r.expires_in) };
  },

  async revoke(tokens) {
    await slack('auth.revoke', tokens.accessToken).catch(() => undefined);
  },

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const token = ctx.tokens.accessToken;
    const me = ctx.tokens.extra.userId ?? '';
    const teamUrl = (ctx.tokens.extra.teamUrl ?? '').replace(/\/$/, '');
    const oldest = (ctx.now.getTime() / 1000 - 2 * 86400).toFixed(6);

    const convs: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; user?: string; updated?: number }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await slack<SlackResp & { channels: typeof convs }>('users.conversations', token, {
        types: 'im,mpim,public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      convs.push(...r.channels);
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor && ++pages < 5);

    // Bound the work: all DMs/group DMs plus the most recently active channels.
    const dms = convs.filter((c) => c.is_im || c.is_mpim).slice(0, 40);
    const channels = convs
      .filter((c) => !c.is_im && !c.is_mpim)
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .slice(0, 25);

    const names = new Map<string, string | null>();
    const userName = async (id: string) => {
      if (!names.has(id)) {
        try {
          const u = await slack<SlackResp & { user: { real_name?: string; name?: string; profile?: { display_name?: string } } }>('users.info', token, { user: id });
          names.set(id, u.user.profile?.display_name || u.user.real_name || u.user.name || null);
        } catch {
          names.set(id, null);
        }
      }
      return names.get(id) ?? null;
    };

    const items: NewItem[] = [];
    await mapLimit([...dms, ...channels], 3, async (c) => {
      let hist: SlackResp & { messages: { ts: string; user?: string; text?: string; thread_ts?: string; subtype?: string; reply_users?: string[] }[] };
      try {
        hist = await slack('conversations.history', token, { channel: c.id, oldest, limit: 50 });
      } catch (e) {
        if (e instanceof IntegrationError && e.code === 'bad_response') return; // e.g. not_in_channel
        throw e;
      }
      const msgs = hist.messages.filter((m) => !m.subtype && m.user).sort((a, b) => Number(a.ts) - Number(b.ts));
      const isDm = !!(c.is_im || c.is_mpim);
      const lastTs = msgs[msgs.length - 1]?.ts;
      for (const m of msgs) {
        const text = m.text ?? '';
        const mentionsMe = !!me && text.includes(`<@${me}>`);
        const fromMe = m.user === me;
        if (!isDm && !mentionsMe) continue; // channels: only what is addressed to the user
        const repliedInThread = (m.reply_users ?? []).includes(me);
        const awaitingReply = !fromMe && !repliedInThread && (isDm ? m.ts === lastTs : true);
        const data: MessageData = {
          channelId: c.id,
          channelName: isDm ? null : c.name ?? null,
          channelType: c.is_im ? 'dm' : c.is_mpim ? 'group_dm' : c.is_private ? 'private_channel' : 'channel',
          author: { id: m.user!, name: await userName(m.user!) },
          text: await resolveMentions(text, userName),
          threadTs: m.thread_ts ?? null,
          mentionsMe,
          fromMe,
          awaitingReply,
        };
        const at = new Date(Number(m.ts) * 1000).toISOString();
        items.push({
          kind: 'message',
          source: 'slack',
          externalId: `${c.id}:${m.ts}`,
          title: data.text.replace(/\s+/g, ' ').slice(0, 80) || '(message)',
          url: teamUrl ? `${teamUrl}/archives/${c.id}/p${m.ts.replace('.', '')}` : null,
          occurredAt: at,
          updatedAt: at,
          data,
        });
      }
    });
    return { items, tasks: [], replaceWindows: [], syncState: { ...ctx.syncState, lastFullSync: ctx.now.toISOString() } };
  },
};

async function resolveMentions(text: string, name: (id: string) => Promise<string | null>): Promise<string> {
  const ids = Array.from(new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]!)));
  let out = text;
  for (const id of ids.slice(0, 10)) out = out.replaceAll(`<@${id}>`, `@${(await name(id)) ?? id}`);
  return out.replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/<(https?:[^>]+)>/g, '$1');
}
