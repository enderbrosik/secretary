import { describe, expect, it } from 'vitest';
import { atLocalTime, dailyJobDue, dayBounds, localDate, minutesBetween } from '../src/index.js';

describe('timezone handling', () => {
  it('computes local date across the date line', () => {
    const now = new Date('2026-10-29T23:30:00Z');
    expect(localDate(now, 'America/Los_Angeles')).toBe('2026-10-29');
    expect(localDate(now, 'Asia/Tokyo')).toBe('2026-10-30');
  });

  it('handles 25-hour fall-back day (US) and 23-hour spring-forward day', () => {
    const fall = dayBounds('2026-11-01', 'America/New_York');
    expect(minutesBetween(fall.start, fall.end)).toBe(25 * 60);
    const spring = dayBounds('2026-03-08', 'America/New_York');
    expect(minutesBetween(spring.start, spring.end)).toBe(23 * 60);
  });

  it('shifts nonexistent spring-forward local times forward', () => {
    const dt = atLocalTime('2026-03-08', '02:30', 'America/New_York');
    expect(dt.toUTC().toISO()).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
  });

  it('schedules daily jobs at the same local wall-clock time across DST', () => {
    const before = dailyJobDue('07:30', 'Europe/Berlin', new Date('2026-10-24T05:31:00Z')); // CEST, 07:31 local
    expect(before.due).toBe(true);
    const after = dailyJobDue('07:30', 'Europe/Berlin', new Date('2026-10-26T06:29:00Z')); // CET, 07:29 local
    expect(after.due).toBe(false);
    expect(after.scheduledFor.toUTC().toISO()).toBe('2026-10-26T06:30:00.000Z');
  });

  it('a job is due once per local date and catches up later the same day', () => {
    const late = dailyJobDue('07:30', 'America/New_York', new Date('2026-10-29T20:00:00Z'));
    expect(late).toMatchObject({ due: true, localDate: '2026-10-29' });
  });
});
