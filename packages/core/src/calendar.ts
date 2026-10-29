import { DateTime } from 'luxon';
import { atLocalTime, cmpIso, dayBounds, minutesBetween } from './time.js';
import type { EventItem, WorkHours } from './types.js';

export interface Conflict {
  a: string; // item id
  b: string;
  overlapMinutes: number;
}

export interface TimeSlot {
  start: string;
  end: string;
  minutes: number;
}

/** Events the user is actually expected to spend time in (not declined / cancelled / all-day). */
export function blockingEvents(events: EventItem[]): EventItem[] {
  return events
    .filter((e) => !e.data.allDay && e.data.status !== 'cancelled' && e.data.selfResponse !== 'declined')
    .sort((x, y) => cmpIso(x.data.start, y.data.start) || cmpIso(x.data.end, y.data.end));
}

export function eventsOnDay(events: EventItem[], date: string, tz: string): EventItem[] {
  const { start, end } = dayBounds(date, tz);
  return events.filter((e) => {
    const s = DateTime.fromISO(e.data.start);
    const en = DateTime.fromISO(e.data.end);
    return s < end && en > start;
  });
}

export function findConflicts(events: EventItem[]): Conflict[] {
  const list = blockingEvents(events);
  const out: Conflict[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (cmpIso(b.data.start, a.data.end) >= 0) break; // sorted by start: no later event can overlap a
      const s = DateTime.max(DateTime.fromISO(a.data.start), DateTime.fromISO(b.data.start));
      const e = DateTime.min(DateTime.fromISO(a.data.end), DateTime.fromISO(b.data.end));
      const m = minutesBetween(s, e);
      if (m > 0) out.push({ a: a.id, b: b.id, overlapMinutes: m });
    }
  }
  return out;
}

/** Merge busy intervals and return free gaps within [from, to]. */
export function freeSlots(
  events: EventItem[],
  from: DateTime,
  to: DateTime,
  minMinutes = 15,
): TimeSlot[] {
  const busy = blockingEvents(events)
    .map((e) => ({ s: DateTime.fromISO(e.data.start), e: DateTime.fromISO(e.data.end) }))
    .filter((b) => b.e > from && b.s < to)
    .sort((x, y) => x.s.toMillis() - y.s.toMillis());

  const slots: TimeSlot[] = [];
  let cursor = from;
  for (const b of busy) {
    if (b.s > cursor) pushSlot(slots, cursor, DateTime.min(b.s, to), minMinutes);
    if (b.e > cursor) cursor = b.e;
    if (cursor >= to) break;
  }
  if (cursor < to) pushSlot(slots, cursor, to, minMinutes);
  return slots;
}

function pushSlot(slots: TimeSlot[], s: DateTime, e: DateTime, min: number) {
  const minutes = minutesBetween(s, e);
  if (minutes >= min) slots.push({ start: s.toISO()!, end: e.toISO()!, minutes });
}

export function workWindow(date: string, tz: string, hours: WorkHours): { start: DateTime; end: DateTime } {
  return { start: atLocalTime(date, hours.start, tz), end: atLocalTime(date, hours.end, tz) };
}

/** Free time inside work hours on a day, optionally only after `notBefore` (e.g. now). */
export function freeWorkSlots(
  events: EventItem[],
  date: string,
  tz: string,
  hours: WorkHours,
  notBefore?: Date,
  minMinutes = 15,
): TimeSlot[] {
  const w = workWindow(date, tz, hours);
  let start = w.start;
  if (notBefore) start = DateTime.max(start, DateTime.fromJSDate(notBefore).setZone(tz));
  if (start >= w.end) return [];
  return freeSlots(eventsOnDay(events, date, tz), start, w.end, minMinutes);
}

/** Runs of >= `minCount` meetings with gaps of at most `maxGapMinutes` between them. */
export function backToBackRuns(events: EventItem[], minCount = 3, maxGapMinutes = 10): EventItem[][] {
  const list = blockingEvents(events);
  const runs: EventItem[][] = [];
  let run: EventItem[] = [];
  for (const e of list) {
    const prev = run[run.length - 1];
    if (prev && minutesBetween(prev.data.end, e.data.start) <= maxGapMinutes) run.push(e);
    else {
      if (run.length >= minCount) runs.push(run);
      run = [e];
    }
  }
  if (run.length >= minCount) runs.push(run);
  return runs;
}

/**
 * Meetings with less than `minPrepMinutes` of free time immediately before them
 * (measured from the previous meeting's end, or from the start of the work day).
 */
export function lowPrepMeetings(
  events: EventItem[],
  date: string,
  tz: string,
  hours: WorkHours,
  minPrepMinutes = 15,
): string[] {
  const list = blockingEvents(eventsOnDay(events, date, tz));
  const out: string[] = [];
  const dayStart = workWindow(date, tz, hours).start;
  let prevEnd: DateTime = dayStart;
  for (const e of list) {
    const s = DateTime.fromISO(e.data.start);
    const gap = minutesBetween(prevEnd, s);
    if (gap < minPrepMinutes && needsPreparation(e)) out.push(e.id);
    const en = DateTime.fromISO(e.data.end);
    if (en > prevEnd) prevEnd = en;
  }
  return out;
}

/** Heuristic: meetings with other people that are not routine standups. */
export function needsPreparation(e: EventItem): boolean {
  const others = e.data.attendees.filter((a) => !a.self);
  if (others.length === 0) return false;
  const routine = /\b(stand-?up|daily sync|lunch|1:1 check-?in|office hours)\b/i.test(e.title);
  return !routine || others.length > 3;
}

export function meetingMinutes(events: EventItem[]): number {
  return blockingEvents(events).reduce((sum, e) => sum + minutesBetween(e.data.start, e.data.end), 0);
}
