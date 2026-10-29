import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@secretary/db';
import { drainJobs, enqueue, handlers, recoverStaleJobs, schedulerTick } from '../src/services/jobs.js';
import { completeOnboarding, createTestApp, signup, type Session, type TestApp } from './helpers.js';

let t: TestApp;
let s: Session;
beforeAll(async () => {
  t = await createTestApp({}, new Date('2026-10-29T11:00:00Z')); // 07:00 New York (Thursday)
  s = await signup(t);
  await completeOnboarding(t, s);
  await t.app.inject({ method: 'POST', url: '/api/integrations/demo/connect', headers: s.headers, payload: { features: { calendar: true, email: true, messages: true, tasks: true } } });
});
afterAll(async () => t.close());

const jobsOf = async (type: string) => (await t.deps.db.select().from(schema.jobs).where(eq(schema.jobs.userId, s.userId))).filter((j) => j.type === type);

describe('scheduler', () => {
  it('does not enqueue the briefing before its local time', async () => {
    await schedulerTick(t.deps);
    expect(await jobsOf('briefing')).toHaveLength(0);
  });

  it('enqueues exactly one briefing per local day, even across ticks and restarts', async () => {
    t.clock.now = new Date('2026-10-29T11:31:00Z'); // 07:31
    await schedulerTick(t.deps);
    await schedulerTick(t.deps);
    expect(await jobsOf('briefing')).toHaveLength(1);
    await drainJobs(t.deps);
    const [job] = await jobsOf('briefing');
    expect(job!.status).toBe('succeeded');
    t.clock.now = new Date('2026-10-29T14:00:00Z'); // restart later that day
    await schedulerTick(t.deps);
    expect(await jobsOf('briefing')).toHaveLength(1);
    const notes = await t.deps.db.select().from(schema.notifications).where(eq(schema.notifications.userId, s.userId));
    expect(notes.filter((n) => n.kind === 'briefing')).toHaveLength(1);
    const runs = (await t.app.inject({ method: 'GET', url: '/api/jobs/runs', headers: s.headers })).json();
    expect(runs.some((r: { type: string; status: string }) => r.type === 'briefing' && r.status === 'succeeded')).toBe(true);
  });

  it('honours pause and weekends', async () => {
    await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: s.headers, payload: { automations: { paused: true } } });
    t.clock.now = new Date('2026-10-30T11:31:00Z');
    await schedulerTick(t.deps);
    expect(await jobsOf('briefing')).toHaveLength(1);
    await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: s.headers, payload: { automations: { paused: false } } });
    t.clock.now = new Date('2026-10-31T11:31:00Z'); // Saturday
    await schedulerTick(t.deps);
    expect((await jobsOf('briefing')).length).toBe(1);
  });

  it('retries failed jobs with backoff, then marks them dead', async () => {
    const original = handlers.retention;
    let calls = 0;
    handlers.retention = async (_d, job) => {
      if (!job.dedupeKey.startsWith('test-retry')) return;
      calls++;
      throw new Error('boom');
    };
    await enqueue(t.deps, 'retention', `test-retry:${Date.now()}`, { userId: s.userId, maxAttempts: 2 });
    await drainJobs(t.deps);
    expect(calls).toBe(1);
    await drainJobs(t.deps); // not yet due (backoff)
    expect(calls).toBe(1);
    t.clock.now = new Date(t.clock.now.getTime() + 31_000);
    await drainJobs(t.deps);
    expect(calls).toBe(2);
    const dead = (await jobsOf('retention')).find((j) => j.dedupeKey.startsWith('test-retry'));
    expect(dead!.status).toBe('dead');
    handlers.retention = original;
  });

  it('recovers jobs abandoned by a crashed worker', async () => {
    await enqueue(t.deps, 'retention', 'stale-1', { userId: s.userId });
    await t.deps.db.update(schema.jobs).set({ status: 'running', lockedAt: new Date(t.clock.now.getTime() - 20 * 60_000).toISOString() }).where(eq(schema.jobs.dedupeKey, 'stale-1'));
    await recoverStaleJobs(t.deps);
    const [j] = await t.deps.db.select().from(schema.jobs).where(eq(schema.jobs.dedupeKey, 'stale-1'));
    expect(j!.status).toBe('queued');
  });

  it('deadline reminders are deduplicated', async () => {
    t.clock.now = new Date('2026-11-02T14:00:00Z'); // Monday 09:00 EST
    await t.app.inject({ method: 'POST', url: '/api/tasks', headers: s.headers, payload: { title: 'Send contract', dueAt: '2026-11-02T14:30:00Z' } });
    await handlers.reminders(t.deps, { userId: s.userId } as never);
    await handlers.reminders(t.deps, { userId: s.userId } as never);
    const notes = await t.deps.db.select().from(schema.notifications).where(eq(schema.notifications.userId, s.userId));
    const dl = notes.filter((n) => n.kind === 'deadline');
    expect(dl).toHaveLength(1);
    // previews are off by default: the OS-facing title does not reveal the task
    expect(dl[0]!.title).toBe('A task is due within the hour');
  });
});
