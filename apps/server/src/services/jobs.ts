import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, lt, lte, ne, or, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { dailyJobDue, emailSignals, formatTime, isWorkday, localDate, type EmailItem, type Settings } from '@secretary/core';
import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';
import { toItem } from '../lib/mappers.js';
import { generateBriefing } from './briefing.js';
import { notify } from './notifications.js';
import { generateReview } from './review.js';
import { getSettings } from './settings.js';
import { syncConnection } from './sync.js';

export type JobType = 'briefing' | 'review' | 'sync' | 'reminders' | 'retention';

/** Enqueue is idempotent: a job with the same dedupe key is never created twice. */
export async function enqueue(deps: Deps, type: JobType, dedupeKey: string, opts: { userId?: string; payload?: Record<string, unknown>; runAt?: Date; maxAttempts?: number } = {}): Promise<boolean> {
  const rows = await deps.db
    .insert(schema.jobs)
    .values({
      type,
      dedupeKey,
      userId: opts.userId ?? null,
      payload: opts.payload ?? {},
      runAt: (opts.runAt ?? deps.now()).toISOString(),
      maxAttempts: opts.maxAttempts ?? 4,
    })
    .onConflictDoNothing()
    .returning({ id: schema.jobs.id });
  return rows.length > 0;
}

function inQuietHours(s: Settings, now: Date): boolean {
  const q = s.notifications.quietHours;
  if (!q.enabled) return false;
  const t = DateTime.fromJSDate(now).setZone(s.timezone).toFormat('HH:mm');
  return q.start <= q.end ? t >= q.start && t < q.end : t >= q.start || t < q.end;
}

/**
 * Scheduler tick: decides which jobs are due. Safe to run on any number of
 * instances concurrently because every job is keyed for idempotency.
 */
export async function schedulerTick(deps: Deps): Promise<number> {
  const now = deps.now();
  let created = 0;
  const all = await deps.db.select({ userId: schema.userSettings.userId }).from(schema.userSettings);
  for (const { userId } of all) {
    const s = await getSettings(deps, userId);
    if (!s.onboardingCompleted || s.automations.paused) continue;
    const today = localDate(now, s.timezone);
    const workday = isWorkday(today, s.timezone, s.workHours.days);

    if (s.automations.morningBriefing && workday) {
      const due = dailyJobDue(s.briefingTime, s.timezone, now);
      // Only within the same local day, and not after the review time (avoids a stale "morning" briefing at night).
      const reviewAt = dailyJobDue(s.reviewTime, s.timezone, now);
      if (due.due && !reviewAt.due) created += +(await enqueue(deps, 'briefing', `briefing:${userId}:${due.localDate}`, { userId, payload: { date: due.localDate } }));
    }
    if (s.automations.endOfDayReview && workday) {
      const due = dailyJobDue(s.reviewTime, s.timezone, now);
      if (due.due) created += +(await enqueue(deps, 'review', `review:${userId}:${due.localDate}`, { userId, payload: { date: due.localDate } }));
    }
    if (s.automations.deadlineReminders || s.automations.meetingPrep || s.automations.followUps) {
      const slot = Math.floor(now.getTime() / (5 * 60_000));
      created += +(await enqueue(deps, 'reminders', `reminders:${userId}:${slot}`, { userId, maxAttempts: 1 }));
    }
    if (s.automations.backgroundSync) {
      const slot = Math.floor(now.getTime() / (deps.config.SYNC_INTERVAL_MINUTES * 60_000));
      const conns = await deps.db.select({ id: schema.connections.id }).from(schema.connections).where(and(eq(schema.connections.userId, userId), ne(schema.connections.status, 'reauth_required')));
      for (const c of conns) created += +(await enqueue(deps, 'sync', `sync:${c.id}:${slot}`, { userId, payload: { connectionId: c.id }, maxAttempts: 3 }));
    }
    created += +(await enqueue(deps, 'retention', `retention:${userId}:${today}`, { userId, maxAttempts: 2 }));
  }
  return created;
}

type JobRow = typeof schema.jobs.$inferSelect;

/** Claims one due job using SKIP LOCKED so multiple workers never run the same job. */
export async function claimJob(deps: Deps, workerId: string): Promise<JobRow | null> {
  const now = deps.now().toISOString();
  const res = await deps.db.execute(sql`
    update jobs set status = 'running', locked_at = ${now}, locked_by = ${workerId}, attempts = attempts + 1
    where id = (
      select id from jobs where status = 'queued' and run_at <= ${now}
      order by run_at limit 1 for update skip locked
    )
    returning id`);
  const id = (res as unknown as { rows: { id: string }[] }).rows[0]?.id;
  if (!id) return null;
  const [row] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
  return row ?? null;
}

/** Jobs left "running" by a crashed process are re-queued. */
export async function recoverStaleJobs(deps: Deps, staleMinutes = 10): Promise<void> {
  const cutoff = new Date(deps.now().getTime() - staleMinutes * 60_000).toISOString();
  await deps.db.update(schema.jobs).set({ status: 'queued', lockedAt: null, lockedBy: null }).where(and(eq(schema.jobs.status, 'running'), lt(schema.jobs.lockedAt, cutoff)));
}

export const handlers: Record<JobType, (deps: Deps, job: JobRow) => Promise<void>> = {
  async briefing(deps, job) {
    const userId = job.userId!;
    const s = await getSettings(deps, userId);
    // Fresh data first; a failing source is reported in the briefing rather than blocking it.
    const conns = await deps.db.select({ id: schema.connections.id }).from(schema.connections).where(eq(schema.connections.userId, userId));
    for (const c of conns) await syncConnection(deps, userId, c.id).catch(() => undefined);
    const b = await generateBriefing(deps, userId, 'scheduled');
    if (!inQuietHours(s, deps.now())) {
      await notify(deps, userId, {
        kind: 'briefing',
        title: 'Your morning briefing is ready',
        body: `${b.overview.meetingsCount} meetings · ${b.priorities.length} priorities`,
        link: '/',
        dedupeKey: `briefing:${b.date}`,
      });
    }
  },
  async review(deps, job) {
    const userId = job.userId!;
    const conns = await deps.db.select({ id: schema.connections.id }).from(schema.connections).where(eq(schema.connections.userId, userId));
    for (const c of conns) await syncConnection(deps, userId, c.id).catch(() => undefined);
    const r = await generateReview(deps, userId);
    await notify(deps, userId, { kind: 'review', title: 'Your end-of-day review is ready', body: `${r.accomplishments.completedTasks.length} tasks completed`, link: `/reviews/${r.date}`, dedupeKey: `review:${r.date}` });
  },
  async sync(deps, job) {
    await syncConnection(deps, job.userId!, (job.payload as { connectionId: string }).connectionId);
  },
  async reminders(deps, job) {
    await runReminders(deps, job.userId!);
  },
  async retention(deps, job) {
    await applyRetention(deps, job.userId!);
  },
};

export async function runJob(deps: Deps, job: JobRow): Promise<void> {
  const started = Date.now();
  try {
    await handlers[job.type as JobType](deps, job);
    await deps.db.update(schema.jobs).set({ status: 'succeeded', finishedAt: deps.now().toISOString(), lastError: null, lockedAt: null }).where(eq(schema.jobs.id, job.id));
    await deps.db.insert(schema.jobRuns).values({ jobId: job.id, userId: job.userId, type: job.type, attempt: job.attempts, status: 'succeeded', durationMs: Date.now() - started });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 500) : 'Job failed';
    const retryAfter = (e as { retryAfterSeconds?: number }).retryAfterSeconds;
    const dead = job.attempts >= job.maxAttempts;
    // Exponential backoff: 30s, 60s, 120s, … (or the provider's Retry-After).
    const delay = (retryAfter ?? 30 * 2 ** (job.attempts - 1)) * 1000;
    await deps.db
      .update(schema.jobs)
      .set({ status: dead ? 'dead' : 'queued', lastError: msg, lockedAt: null, lockedBy: null, runAt: new Date(deps.now().getTime() + delay).toISOString(), finishedAt: dead ? deps.now().toISOString() : null })
      .where(eq(schema.jobs.id, job.id));
    await deps.db.insert(schema.jobRuns).values({ jobId: job.id, userId: job.userId, type: job.type, attempt: job.attempts, status: 'failed', error: msg, durationMs: Date.now() - started });
    deps.log.warn({ jobId: job.id, type: job.type, attempt: job.attempts, dead }, 'job failed');
  }
}

/** Runs all currently due jobs (used by the worker loop and by tests). */
export async function drainJobs(deps: Deps, workerId = `w-${randomUUID().slice(0, 8)}`, max = 50): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const job = await claimJob(deps, workerId);
    if (!job) break;
    await runJob(deps, job);
  }
  return n;
}

export function startWorker(deps: Deps): () => void {
  const workerId = `w-${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await recoverStaleJobs(deps);
      await schedulerTick(deps);
      await drainJobs(deps, workerId);
    } catch (e) {
      deps.log.error({ err: e }, 'scheduler tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, deps.config.JOB_TICK_SECONDS * 1000);
  void tick();
  deps.log.info({ workerId }, 'job worker started');
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------

async function runReminders(deps: Deps, userId: string) {
  const s = await getSettings(deps, userId);
  if (s.automations.paused || inQuietHours(s, deps.now())) return;
  const now = deps.now();
  const tz = s.timezone;
  const preview = s.notifications.showPreviews;

  if (s.automations.deadlineReminders && s.notifications.deadlineReminders) {
    const soon = new Date(now.getTime() + 60 * 60_000).toISOString();
    const due = await deps.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.userId, userId), eq(schema.tasks.confirmed, true), ne(schema.tasks.status, 'done'), ne(schema.tasks.status, 'canceled'), eq(schema.tasks.dueIsAllDay, false), gte(schema.tasks.dueAt, now.toISOString()), lte(schema.tasks.dueAt, soon)));
    for (const t of due) {
      await notify(deps, userId, { kind: 'deadline', title: preview ? `Due at ${formatTime(t.dueAt!, tz)}: ${t.title}` : 'A task is due within the hour', body: t.title, link: '/tasks', dedupeKey: `deadline:${t.id}:${t.dueAt}` });
    }
  }
  if (s.automations.meetingPrep && s.notifications.meetingPrepMinutes > 0) {
    const until = new Date(now.getTime() + s.notifications.meetingPrepMinutes * 60_000).toISOString();
    const evs = await deps.db
      .select()
      .from(schema.items)
      .where(and(eq(schema.items.userId, userId), eq(schema.items.kind, 'event'), gte(schema.items.occurredAt, now.toISOString()), lte(schema.items.occurredAt, until)));
    for (const row of evs) {
      const d = row.data as { attendees: { self: boolean }[]; status: string; selfResponse: string; allDay: boolean };
      if (d.allDay || d.status === 'cancelled' || d.selfResponse === 'declined' || d.attendees.filter((a) => !a.self).length === 0) continue;
      await notify(deps, userId, {
        kind: 'meeting_prep',
        title: preview ? `${row.title} at ${formatTime(row.occurredAt, tz)}` : `Meeting at ${formatTime(row.occurredAt, tz)}`,
        body: 'Open the briefing for preparation notes.',
        link: '/calendar',
        dedupeKey: `prep:${row.id}:${row.occurredAt}`,
      });
    }
  }
  if (s.automations.followUps && s.notifications.followUpReminders) {
    const today = localDate(now, tz);
    const rows = await deps.db
      .select()
      .from(schema.items)
      .where(and(eq(schema.items.userId, userId), eq(schema.items.kind, 'email'), gte(schema.items.occurredAt, new Date(now.getTime() - 7 * 86400_000).toISOString())))
      .orderBy(desc(schema.items.occurredAt))
      .limit(100);
    const waiting = rows.map((r) => toItem(r) as EmailItem).filter((e) => {
      const sig = emailSignals(e, now);
      return sig.unansweredDays !== null && sig.unansweredDays >= 2 && sig.category !== 'informational' && sig.category !== 'can_wait';
    });
    if (waiting.length) {
      await notify(deps, userId, {
        kind: 'follow_up',
        title: `${waiting.length} email${waiting.length > 1 ? 's' : ''} waiting for your reply`,
        body: preview ? waiting.slice(0, 3).map((w) => w.title).join(' · ') : '',
        link: '/inbox',
        dedupeKey: `followups:${today}`,
      });
    }
  }
}

/** Deletes synced data and history older than the user's retention window. */
export async function applyRetention(deps: Deps, userId: string) {
  const s = await getSettings(deps, userId);
  const cutoff = new Date(deps.now().getTime() - s.retentionDays * 86400_000).toISOString();
  await deps.db.delete(schema.items).where(and(eq(schema.items.userId, userId), lt(schema.items.occurredAt, cutoff)));
  await deps.db.delete(schema.notifications).where(and(eq(schema.notifications.userId, userId), lt(schema.notifications.createdAt, cutoff)));
  await deps.db.delete(schema.chatMessages).where(and(eq(schema.chatMessages.userId, userId), lt(schema.chatMessages.createdAt, cutoff)));
  await deps.db.delete(schema.briefings).where(and(eq(schema.briefings.userId, userId), lt(schema.briefings.createdAt, cutoff)));
  await deps.db.delete(schema.reviews).where(and(eq(schema.reviews.userId, userId), lt(schema.reviews.createdAt, cutoff)));
  await deps.db.delete(schema.aiUsage).where(and(eq(schema.aiUsage.userId, userId), lt(schema.aiUsage.createdAt, cutoff)));
  await deps.db.delete(schema.jobs).where(and(eq(schema.jobs.userId, userId), lt(schema.jobs.createdAt, cutoff), or(eq(schema.jobs.status, 'succeeded'), eq(schema.jobs.status, 'dead'))));
  // High-frequency housekeeping jobs only need a short history.
  const shortCutoff = new Date(deps.now().getTime() - 2 * 86400_000).toISOString();
  await deps.db.delete(schema.jobs).where(and(eq(schema.jobs.userId, userId), lt(schema.jobs.createdAt, shortCutoff), eq(schema.jobs.status, 'succeeded'), or(eq(schema.jobs.type, 'sync'), eq(schema.jobs.type, 'reminders'))));
  await deps.db.delete(schema.tasks).where(and(eq(schema.tasks.userId, userId), eq(schema.tasks.status, 'canceled'), lt(schema.tasks.updatedAt, cutoff)));
}
