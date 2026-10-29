import { describe, expect, it } from 'vitest';
import { buildReviewContext, composeReview } from '../src/index.js';
import { email, event, prefs, task } from './fixtures.js';

const now = new Date('2026-10-29T21:45:00Z'); // 5:45 PM New York

describe('end-of-day review', () => {
  it('separates confirmed completions, unverified attendance and inferred progress', () => {
    const done = task('Ship release notes', { status: 'done', completedAt: '2026-10-29T18:00:00Z', startedAt: '2026-10-29T14:00:00Z', estimateMinutes: 60 });
    const wip = task('Draft proposal', { status: 'in_progress', updatedAt: '2026-10-29T19:00:00Z' });
    const planned = task('Call vendor', { dueAt: '2026-10-29T20:00:00Z' });
    const postponed = task('Clean up backlog', { postponeCount: 3 });
    const tomorrow = task('Prepare demo', { dueAt: '2026-10-30T16:00:00Z', priority: 'high' });
    const ev = event('Customer call', '2026-10-29T15:00:00Z', '2026-10-29T16:00:00Z');
    const replied = email('Re: Contract', '2026-10-28T15:00:00Z', { lastMessageFromMe: true });
    replied.updatedAt = '2026-10-29T17:00:00Z';
    const waiting = email('Can you confirm the venue?', '2026-10-29T13:00:00Z');

    const ctx = buildReviewContext({
      now,
      prefs,
      tasks: [done, wip, planned, postponed, tomorrow],
      events: [ev, event('Demo prep with Sam', '2026-10-30T15:00:00Z', '2026-10-30T16:00:00Z')],
      emails: [replied, waiting],
      messages: [],
      plannedTaskIds: [done.id, planned.id],
      freshness: [],
      projects: [],
    });
    const r = composeReview(ctx, null, { model: null, aiError: null, now });
    expect(r.accomplishments.completedTasks.map((t) => t.title)).toEqual(['Ship release notes']);
    expect(r.accomplishments.meetings[0]!.attendance).toBe('accepted_unverified');
    expect(r.accomplishments.inferredProgress.map((t) => t.title)).toEqual(['Draft proposal']);
    expect(r.accomplishments.emailsHandled).toHaveLength(1);
    expect(r.unfinished.plannedNotDone.map((t) => t.title)).toEqual(['Call vendor']);
    expect(r.unfinished.awaitingReply.map((a) => a.title)).toContain('Can you confirm the venue?');
    expect(r.insights.find((i) => i.id === 'planned-completion')!.title).toBe('Completed 1 of 2 planned tasks');
    expect(r.insights.find((i) => i.id === 'postponed')).toBeTruthy();
    expect(r.insights.find((i) => i.id === 'underestimated')).toBeTruthy();
    expect(r.insights.every((i) => i.methodology.length > 0)).toBe(true);
    expect(r.tomorrow.firstTask?.title).toBe('Prepare demo');
    expect(r.tomorrow.meetingsNeedingPrep).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes('cannot be verified'))).toBe(true);
  });

  it('ignores AI insights without evidence and unknown task refs', () => {
    const t = task('Prepare demo', { dueAt: '2026-10-30T16:00:00Z' });
    const ctx = buildReviewContext({ now, prefs, tasks: [t], events: [], emails: [], messages: [], plannedTaskIds: [], freshness: [], projects: [] });
    const r = composeReview(
      ctx,
      { summary: 'Calm day.', insights: [{ title: 'You are amazing', detail: '', basisRefs: [] }], firstTaskRef: 'T77', firstTaskReason: 'x', beforeSignOff: [] },
      { model: 'm', aiError: null, now },
    );
    expect(r.summary).toBe('Calm day.');
    expect(r.insights.some((i) => i.title === 'You are amazing')).toBe(false);
    expect(r.tomorrow.firstTask?.taskId).toBe(t.id);
  });
});
