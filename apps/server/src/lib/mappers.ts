import type { Item, Task } from '@secretary/core';
import type { schema } from '@secretary/db';

type ItemRow = typeof schema.items.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;

export function toItem(r: ItemRow): Item {
  return {
    id: r.id,
    kind: r.kind,
    source: r.source as Item['source'],
    connectionId: r.connectionId,
    externalId: r.externalId,
    title: r.title,
    url: r.url,
    occurredAt: new Date(r.occurredAt).toISOString(),
    updatedAt: new Date(r.sourceUpdatedAt).toISOString(),
    data: r.data,
  } as Item;
}

const iso = (s: string | null) => (s ? new Date(s).toISOString() : null);

export function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    dueAt: iso(r.dueAt),
    dueIsAllDay: r.dueIsAllDay,
    estimateMinutes: r.estimateMinutes,
    status: r.status,
    source: r.source as Task['source'],
    sourceUrl: r.sourceUrl,
    sourceItemId: r.sourceItemId,
    externalId: r.externalId,
    projectId: r.projectId,
    dependsOn: r.dependsOn,
    waitingOn: r.waitingOn,
    nextAction: r.nextAction,
    notes: r.notes,
    origin: r.origin,
    confirmed: r.confirmed,
    postponeCount: r.postponeCount,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    completedAt: iso(r.completedAt),
    startedAt: iso(r.startedAt),
  };
}

/** Public task shape for the API (adds connection + suggestion info). */
export function taskDto(r: TaskRow) {
  return { ...toTask(r), connectionId: r.connectionId, suggestionReason: r.suggestionReason };
}
