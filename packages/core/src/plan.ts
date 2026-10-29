import { DateTime } from 'luxon';
import { blockingEvents, eventsOnDay, freeWorkSlots, workWindow } from './calendar.js';
import { cmpIso, minutesBetween } from './time.js';
import type { EventItem, Task, WorkHours } from './types.js';
import type { PriorityScore } from './priority.js';

export type PlanBlockKind = 'meeting' | 'focus' | 'break' | 'buffer';

export interface PlanBlock {
  id: string;
  kind: PlanBlockKind;
  start: string;
  end: string;
  title: string;
  taskId: string | null;
  itemId: string | null;
  /** Meetings already exist on the calendar; everything else is a proposal. */
  existing: boolean;
}

export interface PlanOptions {
  date: string;
  tz: string;
  hours: WorkHours;
  now?: Date;
  defaultEstimate?: number;
  maxFocusBlock?: number;
  breakAfterMinutes?: number;
  breakMinutes?: number;
}

/**
 * Deterministic daily plan: keeps existing meetings fixed, then fills free
 * work time with the highest-ranked tasks (splitting long tasks), inserting
 * short breaks after sustained work. Nothing is written to a calendar until
 * the user reviews and approves the plan.
 */
export function buildDailyPlan(
  events: EventItem[],
  tasks: Task[],
  ranking: PriorityScore[],
  opts: PlanOptions,
): PlanBlock[] {
  const {
    date,
    tz,
    hours,
    now,
    defaultEstimate = 30,
    maxFocusBlock = 90,
    breakAfterMinutes = 90,
    breakMinutes = 10,
  } = opts;
  const dayEvents = blockingEvents(eventsOnDay(events, date, tz));
  const blocks: PlanBlock[] = dayEvents.map((e) => ({
    id: `m-${e.id}`,
    kind: 'meeting',
    start: e.data.start,
    end: e.data.end,
    title: e.title,
    taskId: null,
    itemId: e.id,
    existing: true,
  }));

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const queue = ranking
    .filter((r) => r.blockedBy.length === 0)
    .map((r) => byId.get(r.taskId))
    .filter((t): t is Task => !!t && t.status !== 'waiting' && t.status !== 'blocked')
    .map((t) => ({ task: t, remaining: t.estimateMinutes ?? defaultEstimate }));

  const slots = freeWorkSlots(events, date, tz, hours, now, 20);
  let sinceBreak = 0;
  let lastEnd: DateTime | null = null;
  let n = 0;

  for (const slot of slots) {
    let cursor = DateTime.fromISO(slot.start).setZone(tz);
    const slotEnd = DateTime.fromISO(slot.end).setZone(tz);
    // Contiguous work across a meeting counts toward the break timer.
    if (lastEnd && minutesBetween(lastEnd, cursor) > 15) sinceBreak = 0;

    while (queue.length && minutesBetween(cursor, slotEnd) >= 20) {
      if (sinceBreak >= breakAfterMinutes && minutesBetween(cursor, slotEnd) >= breakMinutes + 20) {
        const bEnd = cursor.plus({ minutes: breakMinutes });
        blocks.push(mk(`b-${n++}`, 'break', cursor, bEnd, 'Short break', null));
        cursor = bEnd;
        sinceBreak = 0;
        continue;
      }
      const item = queue[0]!;
      const len = Math.min(item.remaining, maxFocusBlock, minutesBetween(cursor, slotEnd));
      if (len < 20 && item.remaining > len) break;
      const end = cursor.plus({ minutes: len });
      blocks.push(mk(`f-${n++}`, 'focus', cursor, end, item.task.title, item.task.id));
      item.remaining -= len;
      sinceBreak += len;
      cursor = end;
      if (item.remaining <= 0) queue.shift();
    }
    lastEnd = cursor;
  }

  // Keep the plan inside the work window and chronological.
  const w = workWindow(date, tz, hours);
  return blocks
    .filter((b) => b.existing || (DateTime.fromISO(b.start) >= w.start && DateTime.fromISO(b.end) <= w.end))
    .sort((a, b) => cmpIso(a.start, b.start));
}

function mk(id: string, kind: PlanBlockKind, s: DateTime, e: DateTime, title: string, taskId: string | null): PlanBlock {
  return { id, kind, start: s.toISO()!, end: e.toISO()!, title, taskId, itemId: null, existing: false };
}
