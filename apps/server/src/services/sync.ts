import { and, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { fingerprint, formatTime, localDate } from '@secretary/core';
import { schema } from '@secretary/db';
import { getConnector, IntegrationError, type ExternalTask, type NewItem, type SyncContext, type TokenSet } from '@secretary/integrations';
import { oauthCredentials } from '../config.js';
import type { AuthedUser, Deps } from '../lib/context.js';
import { AppError, notFound } from '../lib/errors.js';
import { getSettings } from './settings.js';
import { notify } from './notifications.js';

type ConnRow = typeof schema.connections.$inferSelect;

export const tokenPurpose = (c: Pick<ConnRow, 'provider' | 'externalAccountId'>) => `conn:${c.provider}:${c.externalAccountId}`;

export async function loadUser(deps: Deps, userId: string): Promise<AuthedUser> {
  const [u] = await deps.db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u) throw notFound('User');
  return { id: u.id, email: u.email, displayName: u.displayName, wrappedDataKey: u.wrappedDataKey };
}

export async function getConnection(deps: Deps, userId: string, id: string): Promise<ConnRow> {
  const [c] = await deps.db.select().from(schema.connections).where(and(eq(schema.connections.id, id), eq(schema.connections.userId, userId)));
  if (!c) throw notFound('Connection');
  return c;
}

/** Decrypts tokens and refreshes them when close to expiry, persisting the new set. */
export async function connectionContext(deps: Deps, user: AuthedUser, conn: ConnRow): Promise<SyncContext> {
  const settings = await getSettings(deps, user.id);
  let tokens: TokenSet = conn.encryptedTokens
    ? JSON.parse(deps.keys.decrypt(user, tokenPurpose(conn), conn.encryptedTokens))
    : { accessToken: '', refreshToken: null, expiresAt: null, scopes: [], extra: {} };
  const connector = getConnector(conn.provider)!;
  if (tokens.expiresAt && Date.parse(tokens.expiresAt) - deps.now().getTime() < 120_000 && connector.refresh) {
    const creds = oauthCredentials(deps.config, conn.provider);
    if (!creds) throw new IntegrationError('config_missing', `${connector.name} is not configured on this server`);
    tokens = await connector.refresh(tokens, creds);
    await deps.db
      .update(schema.connections)
      .set({ encryptedTokens: deps.keys.encrypt(user, tokenPurpose(conn), JSON.stringify(tokens)), tokenExpiresAt: tokens.expiresAt })
      .where(eq(schema.connections.id, conn.id));
  }
  const [ai] = await deps.db.select({ send: schema.aiProviders.sendEmailBodies }).from(schema.aiProviders).where(and(eq(schema.aiProviders.userId, user.id), eq(schema.aiProviders.active, true)));
  return {
    tokens,
    account: { externalId: conn.externalAccountId, label: conn.accountLabel, email: conn.provider === 'demo' ? user.email : accountEmail(conn) },
    features: conn.features,
    now: deps.now(),
    timezone: settings.timezone,
    syncState: (conn.syncState as Record<string, unknown>) ?? {},
    includeBodies: ai?.send ?? true,
  };
}

function accountEmail(c: ConnRow): string | null {
  return c.accountLabel.includes('@') ? c.accountLabel : null;
}

export interface SyncSummary {
  items: number;
  tasks: number;
  removed: number;
  changes: string[];
}

export async function syncConnection(deps: Deps, userId: string, connectionId: string): Promise<SyncSummary> {
  const user = await loadUser(deps, userId);
  const conn = await getConnection(deps, userId, connectionId);
  const connector = getConnector(conn.provider);
  if (!connector) throw new AppError(400, 'unknown_provider', 'Unknown provider');
  try {
    const ctx = await connectionContext(deps, user, conn);
    const result = await connector.sync(ctx);
    const settings = await getSettings(deps, userId);

    const changes = await detectScheduleChanges(deps, conn, result.items, settings.timezone, !!conn.lastSyncAt);
    const n = await upsertItems(deps, userId, conn.id, result.items);
    let removed = 0;
    for (const w of result.replaceWindows) {
      const keep = result.items.filter((i) => i.kind === w.kind).map((i) => i.externalId);
      const conds = [
        eq(schema.items.userId, userId),
        eq(schema.items.connectionId, conn.id),
        eq(schema.items.kind, w.kind),
        gte(schema.items.occurredAt, w.from),
        lt(schema.items.occurredAt, w.to),
      ];
      if (keep.length) conds.push(notInArray(schema.items.externalId, keep));
      const del = await deps.db.delete(schema.items).where(and(...conds)).returning({ id: schema.items.id });
      removed += del.length;
    }
    const t = connector.supports.tasks && conn.features.tasks ? await upsertExternalTasks(deps, userId, conn, result.tasks) : 0;

    await deps.db
      .update(schema.connections)
      .set({ lastSyncAt: deps.now().toISOString(), lastSyncError: null, status: 'active', syncState: result.syncState })
      .where(eq(schema.connections.id, conn.id));

    if (changes.length && settings.automations.scheduleChangeAlerts && !settings.automations.paused) {
      for (const c of changes.slice(0, 5)) {
        await notify(deps, userId, { kind: 'schedule_change', title: 'Schedule changed', body: c, link: '/calendar', dedupeKey: `sched:${fingerprint(c)}` });
      }
    }
    return { items: n, tasks: t, removed, changes };
  } catch (e) {
    const msg = e instanceof IntegrationError || e instanceof AppError ? e.message : 'Sync failed';
    const reauth = e instanceof IntegrationError && (e.code === 'auth_expired' || e.code === 'insufficient_scope');
    await deps.db
      .update(schema.connections)
      .set({ lastSyncError: msg, status: reauth ? 'reauth_required' : 'error' })
      .where(eq(schema.connections.id, conn.id));
    if (reauth) {
      await notify(deps, userId, {
        kind: 'integration',
        title: `Reconnect ${connector.name}`,
        body: msg,
        link: '/settings/integrations',
        dedupeKey: `reauth:${conn.id}:${localDate(deps.now(), 'UTC')}`,
      });
    }
    throw e;
  }
}

async function upsertItems(deps: Deps, userId: string, connectionId: string, items: NewItem[]): Promise<number> {
  if (!items.length) return 0;
  // De-duplicate within the batch (providers can return the same record twice across pages).
  const map = new Map<string, NewItem>();
  for (const i of items) map.set(`${i.kind}:${i.externalId}`, i);
  const rows = [...map.values()].map((i) => ({
    userId,
    connectionId,
    source: i.source,
    kind: i.kind,
    externalId: i.externalId,
    title: i.title.slice(0, 1000),
    url: i.url,
    occurredAt: i.occurredAt,
    sourceUpdatedAt: i.updatedAt,
    data: i.data,
    contentHash: fingerprint(i.title, i.url, i.occurredAt, JSON.stringify(i.data)),
    syncedAt: deps.now().toISOString(),
  }));
  for (let k = 0; k < rows.length; k += 200) {
    await deps.db
      .insert(schema.items)
      .values(rows.slice(k, k + 200))
      .onConflictDoUpdate({
        target: [schema.items.userId, schema.items.connectionId, schema.items.kind, schema.items.externalId],
        set: {
          title: sql`excluded.title`,
          url: sql`excluded.url`,
          occurredAt: sql`excluded.occurred_at`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          data: sql`excluded.data`,
          contentHash: sql`excluded.content_hash`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }
  return rows.length;
}

async function detectScheduleChanges(deps: Deps, conn: ConnRow, items: NewItem[], tz: string, hadPrevious: boolean): Promise<string[]> {
  if (!hadPrevious) return [];
  const today = localDate(deps.now(), tz);
  const isToday = (iso: string) => DateTime.fromISO(iso).setZone(tz).toISODate() === today;
  const events = items.filter((i): i is Extract<NewItem, { kind: 'event' }> => i.kind === 'event' && isToday(i.data.start) && Date.parse(i.data.end) > deps.now().getTime());
  if (!events.length) return [];
  const existing = await deps.db
    .select({ externalId: schema.items.externalId, data: schema.items.data, title: schema.items.title })
    .from(schema.items)
    .where(and(eq(schema.items.connectionId, conn.id), eq(schema.items.kind, 'event'), inArray(schema.items.externalId, events.map((e) => e.externalId))));
  const prev = new Map(existing.map((e) => [e.externalId, e]));
  const out: string[] = [];
  for (const e of events) {
    const p = prev.get(e.externalId);
    if (!p) out.push(`New today: “${e.title}” at ${formatTime(e.data.start, tz)}`);
    else {
      const pd = p.data as { start: string; status: string };
      if (Date.parse(pd.start) !== Date.parse(e.data.start)) out.push(`“${e.title}” moved from ${formatTime(pd.start, tz)} to ${formatTime(e.data.start, tz)}`);
      else if (pd.status !== 'cancelled' && e.data.status === 'cancelled') out.push(`“${e.title}” at ${formatTime(e.data.start, tz)} was cancelled`);
    }
  }
  return out;
}

async function upsertExternalTasks(deps: Deps, userId: string, conn: ConnRow, list: ExternalTask[]): Promise<number> {
  const now = deps.now().toISOString();
  const seen = new Set<string>();
  const byId = new Map<string, ExternalTask>();
  for (const t of list) byId.set(t.externalId, t.completed ? t : byId.get(t.externalId)?.completed ? byId.get(t.externalId)! : t);
  const existing = await deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.userId, userId), eq(schema.tasks.connectionId, conn.id)));
  const ex = new Map(existing.map((r) => [r.externalId!, r]));
  for (const t of byId.values()) {
    seen.add(t.externalId);
    const cur = ex.get(t.externalId);
    const extStatus = t.completed ? 'done' : 'todo';
    if (!cur) {
      await deps.db
        .insert(schema.tasks)
        .values({
          userId,
          connectionId: conn.id,
          externalId: t.externalId,
          title: t.title.slice(0, 300),
          description: t.description,
          priority: t.priority,
          dueAt: t.dueAt,
          dueIsAllDay: t.dueIsAllDay,
          estimateMinutes: t.estimateMinutes,
          status: extStatus,
          completedAt: t.completed ? t.completedAt ?? now : null,
          source: conn.provider,
          sourceUrl: t.url,
          origin: 'integration',
          confirmed: true,
        })
        .onConflictDoNothing();
      continue;
    }
    // Local edits win when they are newer than the source (e.g. completed here on a read-only connection).
    const localNewer = Date.parse(cur.updatedAt) > Date.parse(t.updatedAt);
    let status = cur.status;
    if (t.completed) status = 'done';
    else if (cur.status === 'done' || cur.status === 'canceled') status = localNewer ? cur.status : 'todo';
    const postponed = cur.dueAt && t.dueAt && Date.parse(t.dueAt) > Date.parse(cur.dueAt) ? 1 : 0;
    await deps.db
      .update(schema.tasks)
      .set({
        title: t.title.slice(0, 300),
        description: t.description,
        priority: t.priority,
        dueAt: t.dueAt,
        dueIsAllDay: t.dueIsAllDay,
        estimateMinutes: t.estimateMinutes ?? cur.estimateMinutes,
        status,
        completedAt: status === 'done' ? cur.completedAt ?? t.completedAt ?? now : null,
        sourceUrl: t.url,
        postponeCount: cur.postponeCount + postponed,
      })
      .where(eq(schema.tasks.id, cur.id));
  }
  // Tasks that disappeared from the source (deleted there) are marked canceled, not silently kept open.
  const gone = existing.filter((r) => r.externalId && !seen.has(r.externalId) && r.status !== 'done' && r.status !== 'canceled');
  if (gone.length) {
    await deps.db
      .update(schema.tasks)
      .set({ status: 'canceled', notes: sql`${schema.tasks.notes} || ${'\n[No longer present in the source system]'}` })
      .where(inArray(schema.tasks.id, gone.map((g) => g.id)));
  }
  return byId.size;
}
