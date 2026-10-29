import { DateTime, IANAZone, Interval } from 'luxon';

/** All date math is deterministic and timezone-aware (IANA zones, DST-safe via Luxon). */

export function isValidTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export function assertTimezone(tz: string): string {
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
  return tz;
}

export function toZoned(iso: string | Date, tz: string): DateTime {
  const dt = typeof iso === 'string' ? DateTime.fromISO(iso, { setZone: true }) : DateTime.fromJSDate(iso);
  return dt.setZone(tz);
}

/** "YYYY-MM-DD" for the instant `now` as seen in `tz`. */
export function localDate(now: Date, tz: string): string {
  return DateTime.fromJSDate(now).setZone(tz).toISODate()!;
}

export function parseHHMM(hhmm: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time of day: ${hhmm}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Start/end of a local calendar day as UTC instants. Handles 23h / 25h DST days. */
export function dayBounds(date: string, tz: string): { start: DateTime; end: DateTime } {
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day');
  if (!start.isValid) throw new Error(`Invalid date ${date}`);
  const end = start.plus({ days: 1 }).startOf('day');
  return { start, end };
}

/**
 * The instant at which local wall-clock `hhmm` occurs on local `date` in `tz`.
 * Nonexistent times (spring-forward gap) are shifted forward by Luxon, ambiguous
 * times (fall-back overlap) resolve to the first occurrence.
 */
export function atLocalTime(date: string, hhmm: string, tz: string): DateTime {
  const { hour, minute } = parseHHMM(hhmm);
  return DateTime.fromISO(date, { zone: tz }).set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * Whether a daily job scheduled at `hhmm` local time is due at `now`, and the
 * local date it is due for. A job is due once per local date, from its scheduled
 * time until the end of that local day (so missed runs catch up after restarts).
 */
export function dailyJobDue(
  hhmm: string,
  tz: string,
  now: Date,
): { due: boolean; localDate: string; scheduledFor: DateTime } {
  const date = localDate(now, tz);
  const scheduledFor = atLocalTime(date, hhmm, tz);
  return { due: DateTime.fromJSDate(now) >= scheduledFor, localDate: date, scheduledFor };
}

export function isWorkday(date: string, tz: string, days: number[]): boolean {
  return days.includes(DateTime.fromISO(date, { zone: tz }).weekday);
}

export function addDays(date: string, n: number, tz: string): string {
  return DateTime.fromISO(date, { zone: tz }).plus({ days: n }).toISODate()!;
}

export function minutesBetween(a: string | DateTime, b: string | DateTime): number {
  const da = typeof a === 'string' ? DateTime.fromISO(a) : a;
  const db = typeof b === 'string' ? DateTime.fromISO(b) : b;
  return Math.round(db.diff(da, 'minutes').minutes);
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const a = Interval.fromDateTimes(DateTime.fromISO(aStart), DateTime.fromISO(aEnd));
  const b = Interval.fromDateTimes(DateTime.fromISO(bStart), DateTime.fromISO(bEnd));
  return a.isValid && b.isValid && a.overlaps(b);
}

/** Human-friendly local time like "9:30 AM". */
export function formatTime(iso: string, tz: string): string {
  return toZoned(iso, tz).toFormat('h:mm a');
}

export function formatDateLong(date: string, tz: string): string {
  return DateTime.fromISO(date, { zone: tz }).toFormat('cccc, LLLL d, yyyy');
}

export { DateTime };

/** Chronological comparison of ISO timestamps that may carry different offsets. */
export function cmpIso(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}
