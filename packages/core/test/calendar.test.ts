import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { backToBackRuns, findConflicts, freeSlots, freeWorkSlots, lowPrepMeetings } from '../src/index.js';
import { event, prefs } from './fixtures.js';

describe('calendar analysis', () => {
  it('detects overlaps even when offsets differ', () => {
    const a = event('Budget review', '2026-10-29T14:00:00Z', '2026-10-29T15:00:00Z');
    const b = event('Client call', '2026-10-29T10:30:00-04:00', '2026-10-29T11:30:00-04:00');
    const c = event('Later', '2026-10-29T17:00:00Z', '2026-10-29T17:30:00Z');
    expect(findConflicts([a, b, c])).toEqual([{ a: a.id, b: b.id, overlapMinutes: 30 }]);
  });

  it('ignores declined and cancelled meetings', () => {
    const a = event('A', '2026-10-29T14:00:00Z', '2026-10-29T15:00:00Z');
    const b = event('B', '2026-10-29T14:00:00Z', '2026-10-29T15:00:00Z', { selfResponse: 'declined' });
    const c = event('C', '2026-10-29T14:00:00Z', '2026-10-29T15:00:00Z', { status: 'cancelled' });
    expect(findConflicts([a, b, c])).toEqual([]);
  });

  it('computes free slots between merged busy blocks', () => {
    const from = DateTime.fromISO('2026-10-29T13:00:00Z');
    const to = DateTime.fromISO('2026-10-29T21:00:00Z');
    const evs = [
      event('1', '2026-10-29T14:00:00Z', '2026-10-29T15:00:00Z'),
      event('2', '2026-10-29T14:30:00Z', '2026-10-29T16:00:00Z'),
      event('3', '2026-10-29T18:00:00Z', '2026-10-29T18:10:00Z'),
    ];
    expect(freeSlots(evs, from, to).map((s) => s.minutes)).toEqual([60, 120, 170]);
  });

  it('limits free work slots to work hours and the current time', () => {
    const slots = freeWorkSlots([], '2026-10-29', prefs.timezone, prefs.workHours, new Date('2026-10-29T19:00:00Z'));
    expect(slots).toHaveLength(1);
    expect(slots[0]!.minutes).toBe(60 * 2); // 3pm–5pm EDT
  });

  it('finds back-to-back runs and low-prep meetings', () => {
    const evs = [
      event('Design review', '2026-10-29T17:00:00Z', '2026-10-29T17:30:00Z'),
      event('Partner sync', '2026-10-29T17:30:00Z', '2026-10-29T18:00:00Z'),
      event('Hiring panel', '2026-10-29T18:05:00Z', '2026-10-29T19:00:00Z'),
    ];
    expect(backToBackRuns(evs)).toHaveLength(1);
    const low = lowPrepMeetings(evs, '2026-10-29', prefs.timezone, prefs.workHours);
    expect(low).toEqual([evs[1]!.id, evs[2]!.id]);
  });
});
