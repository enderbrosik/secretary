import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';

export interface NotifyInput {
  kind: string;
  title: string;
  body?: string;
  link?: string | null;
  /** Unique per user; a repeat with the same key is silently ignored (no duplicate alerts). */
  dedupeKey: string;
}

export async function notify(deps: Deps, userId: string, n: NotifyInput): Promise<boolean> {
  const rows = await deps.db
    .insert(schema.notifications)
    .values({ userId, kind: n.kind, title: n.title.slice(0, 200), body: (n.body ?? '').slice(0, 1000), link: n.link ?? null, dedupeKey: n.dedupeKey })
    .onConflictDoNothing()
    .returning({ id: schema.notifications.id });
  return rows.length > 0;
}
