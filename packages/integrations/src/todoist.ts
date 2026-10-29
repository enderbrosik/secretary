import { DateTime } from 'luxon';
import type { TaskPriority } from '@secretary/core';
import { request } from './http.js';
import type { Connector, ExternalTask, SyncContext, SyncResult } from './types.js';

const API = 'https://api.todoist.com/api/v1';

interface TdTask {
  id: string;
  content: string;
  description?: string;
  priority?: number; // 4 = p1 (urgent) … 1 = p4 (normal)
  due?: { date?: string; datetime?: string | null; timezone?: string | null } | null;
  deadline?: { date?: string } | null;
  duration?: { amount: number; unit: 'minute' | 'day' } | null;
  checked?: boolean;
  completed_at?: string | null;
  updated_at?: string;
  added_at?: string;
}

const PRI: Record<number, TaskPriority> = { 4: 'urgent', 3: 'high', 2: 'medium', 1: 'low' };

export function mapTodoistTask(t: TdTask, tz: string): ExternalTask {
  // Prefer an explicit deadline; otherwise the due date. Date-only values are all-day in the user's zone.
  const dl = t.deadline?.date;
  const dueDt = t.due?.datetime ?? null;
  const dueDate = dl ?? t.due?.date ?? null;
  let dueAt: string | null = null;
  let allDay = false;
  if (!dl && dueDt) dueAt = DateTime.fromISO(dueDt, { zone: t.due?.timezone ?? tz }).toISO();
  else if (dueDate) {
    dueAt = DateTime.fromISO(dueDate.slice(0, 10), { zone: tz }).startOf('day').toISO();
    allDay = true;
  }
  return {
    externalId: t.id,
    title: t.content,
    description: t.description ?? '',
    priority: PRI[t.priority ?? 1] ?? 'medium',
    dueAt,
    dueIsAllDay: allDay,
    estimateMinutes: t.duration ? (t.duration.unit === 'minute' ? t.duration.amount : t.duration.amount * 8 * 60) : null,
    completed: !!t.checked || !!t.completed_at,
    completedAt: t.completed_at ?? null,
    url: `https://app.todoist.com/app/task/${t.id}`,
    updatedAt: t.updated_at ?? t.added_at ?? new Date().toISOString(),
  };
}

export const todoistConnector: Connector = {
  provider: 'todoist',
  name: 'Todoist',
  supports: { calendar: false, email: false, messages: false, tasks: true },
  usesPkce: false,

  scopesFor(_f, tier) {
    return [tier === 'read' ? 'data:read' : 'data:read_write'];
  },

  describeScopes(_f, tier) {
    return tier === 'read'
      ? [{ scope: 'data:read', why: 'Read your tasks, due dates and priorities.' }]
      : [{ scope: 'data:read_write', why: 'Read your tasks and, when you mark one done here, complete it in Todoist.' }];
  },

  buildAuthUrl({ creds, state, scopes }) {
    const u = new URL('https://todoist.com/oauth/authorize');
    u.search = new URLSearchParams({ client_id: creds.clientId, scope: scopes.join(','), state }).toString();
    return u.toString();
  },

  async exchangeCode({ creds, code, redirectUri }) {
    const t = await request<{ access_token: string; token_type: string }>('Todoist', 'https://todoist.com/oauth/access_token', {
      form: { client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirectUri },
    });
    const me = await request<{ id: string; email?: string; full_name?: string }>('Todoist', `${API}/user`, { token: t.access_token });
    return {
      tokens: { accessToken: t.access_token, refreshToken: null, expiresAt: null, scopes: [], extra: {} },
      account: { externalId: String(me.id), label: me.email ?? me.full_name ?? 'Todoist', email: me.email ?? null },
    };
  },

  async revoke(tokens, creds) {
    await request('Todoist', `${API}/access_tokens`, {
      method: 'DELETE',
      query: { client_id: creds.clientId, client_secret: creds.clientSecret, access_token: tokens.accessToken },
    }).catch(() => undefined);
  },

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const tasks: ExternalTask[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const r = await request<{ results: TdTask[]; next_cursor?: string | null }>('Todoist', `${API}/tasks`, {
        token: ctx.tokens.accessToken,
        query: { limit: 200, cursor: cursor ?? undefined },
      });
      tasks.push(...r.results.map((t) => mapTodoistTask(t, ctx.timezone)));
      cursor = r.next_cursor;
    } while (cursor && ++pages < 10);

    // Recently completed tasks, so end-of-day reviews reflect work done in Todoist.
    const since = DateTime.fromJSDate(ctx.now).minus({ days: 2 }).toUTC().toISO()!;
    const until = DateTime.fromJSDate(ctx.now).plus({ minutes: 1 }).toUTC().toISO()!;
    try {
      const done = await request<{ items: TdTask[] }>('Todoist', `${API}/tasks/completed/by_completion_date`, {
        token: ctx.tokens.accessToken,
        query: { since, until, limit: 200 },
      });
      tasks.push(...(done.items ?? []).map((t) => ({ ...mapTodoistTask(t, ctx.timezone), completed: true })));
    } catch {
      // Completed-task history is optional; active tasks are still synced.
    }
    return { items: [], tasks, replaceWindows: [], syncState: { ...ctx.syncState, lastFullSync: ctx.now.toISOString() } };
  },

  async completeTask(ctx, externalId) {
    await request('Todoist', `${API}/tasks/${encodeURIComponent(externalId)}/close`, { token: ctx.tokens.accessToken, method: 'POST' });
    return { externalId, url: `https://app.todoist.com/app/task/${externalId}`, message: 'Task completed in Todoist' };
  },
};
