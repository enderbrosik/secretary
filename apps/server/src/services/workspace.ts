import { and, desc, eq, gte, inArray, lt, ne, or } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { EmailItem, EventItem, FreshnessInfo, MessageItem, Task } from '@secretary/core';
import { schema } from '@secretary/db';
import { getConnector } from '@secretary/integrations';
import type { Deps } from '../lib/context.js';
import { toItem, toTask } from '../lib/mappers.js';

export interface Workspace {
  events: EventItem[];
  emails: EmailItem[];
  messages: MessageItem[];
  tasks: Task[];
  freshness: FreshnessInfo[];
  projects: { id: string; name: string }[];
  demo: boolean;
}

const STALE_MINUTES = 90;

/**
 * Loads only the authorized, relevant records for briefing / review / chat:
 * events in a short window, recent emails and messages, and open or recently
 * completed tasks. Everything is already normalized and de-duplicated.
 */
export async function loadWorkspace(deps: Deps, userId: string, tz: string): Promise<Workspace> {
  const now = deps.now();
  const day = DateTime.fromJSDate(now).setZone(tz).startOf('day');
  const conns = await deps.db.select().from(schema.connections).where(eq(schema.connections.userId, userId));
  const connIds = conns.map((c) => c.id);

  const [events, emails, messages] = connIds.length
    ? await Promise.all([
        deps.db
          .select()
          .from(schema.items)
          .where(and(eq(schema.items.userId, userId), eq(schema.items.kind, 'event'), gte(schema.items.occurredAt, day.minus({ days: 1 }).toUTC().toISO()!), lt(schema.items.occurredAt, day.plus({ days: 8 }).toUTC().toISO()!)))
          .orderBy(schema.items.occurredAt)
          .limit(400),
        deps.db
          .select()
          .from(schema.items)
          .where(and(eq(schema.items.userId, userId), eq(schema.items.kind, 'email'), gte(schema.items.sourceUpdatedAt, day.minus({ days: 7 }).toUTC().toISO()!)))
          .orderBy(desc(schema.items.occurredAt))
          .limit(150),
        deps.db
          .select()
          .from(schema.items)
          .where(and(eq(schema.items.userId, userId), eq(schema.items.kind, 'message'), gte(schema.items.occurredAt, day.minus({ days: 3 }).toUTC().toISO()!)))
          .orderBy(desc(schema.items.occurredAt))
          .limit(150),
      ])
    : [[], [], []];

  const taskRows = await deps.db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.userId, userId),
        or(
          and(ne(schema.tasks.status, 'done'), ne(schema.tasks.status, 'canceled')),
          gte(schema.tasks.completedAt, day.minus({ days: 2 }).toUTC().toISO()!),
        ),
      ),
    )
    .limit(800);

  const projects = await deps.db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.userId, userId));

  const freshness: FreshnessInfo[] = conns.map((c) => {
    const last = c.lastSyncAt ? new Date(c.lastSyncAt) : null;
    const stale = !last || now.getTime() - last.getTime() > STALE_MINUTES * 60_000;
    return {
      connectionId: c.id,
      provider: c.provider,
      label: `${getConnector(c.provider)?.name ?? c.provider}${c.provider === 'demo' ? '' : ` (${c.accountLabel})`}`,
      lastSyncedAt: last?.toISOString() ?? null,
      stale: c.provider === 'demo' ? false : stale,
      status: c.status !== 'active' ? 'error' : last ? 'ok' : 'never_synced',
      error: c.lastSyncError,
    };
  });

  return {
    events: events.map(toItem) as EventItem[],
    emails: emails.map(toItem) as EmailItem[],
    messages: messages.map(toItem) as MessageItem[],
    tasks: taskRows.map(toTask),
    freshness,
    projects,
    demo: conns.some((c) => c.provider === 'demo'),
  };
}

export async function itemsByIds(deps: Deps, userId: string, ids: string[]) {
  if (!ids.length) return [];
  return (await deps.db.select().from(schema.items).where(and(eq(schema.items.userId, userId), inArray(schema.items.id, ids)))).map(toItem);
}

