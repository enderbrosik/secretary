import { DateTime } from 'luxon';
import { z } from 'zod';
import { blockingEvents, eventsOnDay, meetingMinutes, needsPreparation, workWindow } from './calendar.js';
import { buildRefRegistry, type RefRegistry } from './briefing.js';
import { emailSignals } from './email.js';
import { dueState, isOpen, scoreTasks } from './priority.js';
import { addDays, dayBounds, formatDateLong, formatTime, localDate, minutesBetween } from './time.js';
import { UNTRUSTED_CONTENT_POLICY, sanitizeText } from './untrusted.js';
import { GROUNDING_RULES, personaInstructions } from './prompts.js';
import type { EmailItem, EventItem, FreshnessInfo, MessageItem, Provenance, SourceRef, Task, UserPreferences } from './types.js';

export interface ReviewInput {
  now: Date;
  prefs: UserPreferences;
  tasks: Task[];
  events: EventItem[];
  emails: EmailItem[];
  messages: MessageItem[];
  /** Task ids the morning plan / briefing proposed for today. */
  plannedTaskIds: string[];
  freshness: FreshnessInfo[];
  projects: { id: string; name: string }[];
}

export interface ReviewInsight {
  id: string;
  title: string;
  detail: string;
  methodology: string;
  refs: SourceRef[];
  provenance: Provenance;
}

export interface Review {
  date: string;
  timezone: string;
  generatedAt: string;
  mode: 'ai' | 'rules';
  model: string | null;
  aiError: string | null;
  dateLabel: string;
  summary: string;
  summaryProvenance: Provenance;
  accomplishments: {
    completedTasks: { taskId: string; title: string; completedAt: string; projectId: string | null }[];
    meetings: { itemId: string; title: string; start: string; end: string; attendance: 'accepted_unverified' | 'organizer_unverified' | 'unknown'; url: string | null }[];
    emailsHandled: { itemId: string; subject: string; counterpart: string; url: string | null }[];
    projectProgress: { projectId: string; name: string; completedToday: number; remaining: number }[];
    inferredProgress: { taskId: string; title: string; evidence: string }[];
  };
  unfinished: {
    plannedNotDone: { taskId: string; title: string; status: string }[];
    approachingDeadlines: { taskId: string; title: string; dueAt: string }[];
    awaitingReply: { itemId: string; title: string; from: string; url: string | null; kind: 'email' | 'message' }[];
    carryOver: { taskId: string; title: string }[];
    blockers: { taskId: string; title: string; reason: string }[];
  };
  insights: ReviewInsight[];
  tomorrow: {
    date: string;
    priorities: { taskId: string; title: string; reasons: string[] }[];
    deadlines: { taskId: string; title: string; dueAt: string }[];
    meetingsNeedingPrep: { itemId: string; title: string; start: string }[];
    firstTask: { taskId: string; title: string; reason: string; provenance: Provenance } | null;
    beforeSignOff: { text: string; refs: SourceRef[] }[];
  };
  freshness: FreshnessInfo[];
  warnings: string[];
}

export const reviewAIOutputSchema = z.object({
  summary: z.string().describe('2-4 sentences. Distinguish confirmed completions from inferred progress. No shaming.'),
  insights: z.array(z.object({ title: z.string(), detail: z.string(), basisRefs: z.array(z.string()) })),
  firstTaskRef: z.string().nullable().describe('Task ref to start with tomorrow morning'),
  firstTaskReason: z.string().nullable(),
  beforeSignOff: z.array(z.object({ text: z.string(), refs: z.array(z.string()) })),
});
export type ReviewAIOutput = z.infer<typeof reviewAIOutputSchema>;

export interface ReviewContext {
  input: ReviewInput;
  date: string;
  tomorrow: string;
  tz: string;
  refs: RefRegistry;
  base: Omit<Review, 'mode' | 'model' | 'aiError' | 'generatedAt'>;
}

export function buildReviewContext(input: ReviewInput): ReviewContext {
  const { now, prefs } = input;
  const tz = prefs.timezone;
  const date = localDate(now, tz);
  const tomorrow = addDays(date, 1, tz);
  const { start, end } = dayBounds(date, tz);
  const inDay = (iso: string | null) => !!iso && DateTime.fromISO(iso) >= start && DateTime.fromISO(iso) < end;
  const tasks = input.tasks.filter((t) => t.confirmed);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const completed = tasks.filter((t) => t.status === 'done' && inDay(t.completedAt));
  const todayEvents = blockingEvents(eventsOnDay(input.events, date, tz)).filter((e) => Date.parse(e.data.end) <= now.getTime());
  const meetings = todayEvents.map((e) => {
    const self = e.data.attendees.find((a) => a.self);
    const attendance: Review['accomplishments']['meetings'][number]['attendance'] = self?.organizer
      ? 'organizer_unverified'
      : e.data.selfResponse === 'accepted'
        ? 'accepted_unverified'
        : 'unknown';
    return { itemId: e.id, title: e.title, start: e.data.start, end: e.data.end, attendance, url: e.url };
  });
  const emailsHandled = input.emails
    .filter((e) => e.data.lastMessageFromMe && inDay(e.updatedAt))
    .map((e) => ({
      itemId: e.id,
      subject: e.title,
      counterpart: e.data.to[0]?.name ?? e.data.to[0]?.email ?? e.data.from.name ?? '',
      url: e.url,
    }));

  const projectProgress = input.projects
    .map((p) => ({
      projectId: p.id,
      name: p.name,
      completedToday: completed.filter((t) => t.projectId === p.id).length,
      remaining: tasks.filter((t) => t.projectId === p.id && isOpen(t)).length,
    }))
    .filter((p) => p.completedToday > 0);

  const inferredProgress = tasks
    .filter((t) => t.status === 'in_progress' && inDay(t.updatedAt))
    .map((t) => ({ taskId: t.id, title: t.title, evidence: 'Marked in progress and updated today (completion not confirmed)' }));

  const planned = input.plannedTaskIds.map((id) => byId.get(id)).filter((t): t is Task => !!t);
  const plannedNotDone = planned.filter(isOpen).map((t) => ({ taskId: t.id, title: t.title, status: t.status }));
  const horizon = DateTime.fromISO(addDays(date, 4, tz), { zone: tz }).startOf('day');
  const approachingDeadlines = tasks
    .filter((t) => isOpen(t) && t.dueAt && DateTime.fromISO(t.dueAt) < horizon)
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))
    .map((t) => ({ taskId: t.id, title: t.title, dueAt: t.dueAt! }));
  const awaitingReply = [
    ...input.emails
      .filter((e) => {
        const s = emailSignals(e, now);
        return s.unansweredDays !== null && (s.category === 'needs_reply' || s.category === 'urgent' || s.category === 'waiting_for_me');
      })
      .map((e) => ({ itemId: e.id, title: e.title, from: e.data.from.name ?? e.data.from.email ?? '', url: e.url, kind: 'email' as const })),
    ...input.messages
      .filter((m) => !m.data.fromMe && m.data.awaitingReply && (m.data.mentionsMe || m.data.channelType === 'dm'))
      .map((m) => ({ itemId: m.id, title: m.title, from: m.data.author.name ?? m.data.author.id, url: m.url, kind: 'message' as const })),
  ].slice(0, 12);
  const blockers = tasks
    .filter((t) => isOpen(t) && (t.status === 'blocked' || t.dependsOn.some((d) => byId.get(d) && isOpen(byId.get(d)!))))
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      reason: t.status === 'blocked' ? 'Marked blocked' : `Depends on: ${t.dependsOn.map((d) => byId.get(d)?.title).filter(Boolean).join(', ')}`,
    }));
  const carryOver = tasks
    .filter((t) => isOpen(t) && t.status !== 'waiting' && ['overdue', 'today'].includes(dueState(t, date, tz)))
    .concat(planned.filter(isOpen))
    .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
    .map((t) => ({ taskId: t.id, title: t.title }));

  // ---- insights (each states its method) ------------------------------------
  const insights: ReviewInsight[] = [];
  if (planned.length) {
    const done = planned.filter((t) => t.status === 'done').length;
    insights.push({
      id: 'planned-completion',
      title: `Completed ${done} of ${planned.length} planned tasks`,
      detail:
        done === planned.length
          ? 'Everything planned for today is marked done.'
          : `${planned.length - done} planned task${planned.length - done > 1 ? 's remain' : ' remains'} open.`,
      methodology: 'Counts tasks proposed in this morning’s plan/priorities whose status is “done”. Tasks completed outside the app are only counted once they are synced or marked done.',
      refs: [],
      provenance: 'fact',
    });
  }
  const postponed = tasks.filter((t) => isOpen(t) && t.postponeCount >= 2);
  if (postponed.length) {
    insights.push({
      id: 'postponed',
      title: `${postponed.length} task${postponed.length > 1 ? 's have' : ' has'} been postponed repeatedly`,
      detail: postponed.slice(0, 4).map((t) => `“${t.title}” (${t.postponeCount}×)`).join(', ') + '. Consider breaking them down, delegating or dropping them.',
      methodology: 'A postponement is recorded each time a task’s due date is moved later or it is carried over in a review.',
      refs: [],
      provenance: 'fact',
    });
  }
  const w = workWindow(date, tz, prefs.workHours);
  const workMins = Math.max(1, minutesBetween(w.start, w.end));
  const mm = meetingMinutes(eventsOnDay(input.events, date, tz));
  if (mm / workMins >= 0.6) {
    insights.push({
      id: 'overload',
      title: `Meetings took ${Math.round((mm / workMins) * 100)}% of your work hours`,
      detail: `${Math.round(mm / 60 * 10) / 10}h of meetings in a ${Math.round(workMins / 60 * 10) / 10}h work day leaves little time for focused work.`,
      methodology: 'Sum of non-declined, non-all-day calendar events today divided by your configured work hours.',
      refs: [],
      provenance: 'fact',
    });
  }
  const under = completed.filter(
    (t) => t.estimateMinutes && t.startedAt && t.completedAt && minutesBetween(t.startedAt, t.completedAt) > t.estimateMinutes * 1.5 && minutesBetween(t.startedAt, t.completedAt) < 60 * 16,
  );
  if (under.length) {
    insights.push({
      id: 'underestimated',
      title: `${under.length} task${under.length > 1 ? 's' : ''} took longer than estimated`,
      detail: under.map((t) => `“${t.title}”: est. ${t.estimateMinutes} min, ~${minutesBetween(t.startedAt!, t.completedAt!)} min elapsed`).join('; '),
      methodology: 'Elapsed time between “in progress” and “done” compared with your estimate (flagged above 150%). Elapsed time includes interruptions, so treat this as an upper bound.',
      refs: [],
      provenance: 'inference',
    });
  }
  const topToday = scoreTasks(input.tasks, date, tz).slice(0, 3);
  if (topToday.length && completed.length) {
    const touched = completed.filter((t) => topToday.some((r) => r.taskId === t.id)).length;
    insights.push({
      id: 'priority-attention',
      title: touched ? `${touched} of today’s completed tasks were top priorities` : 'Completed work was outside the top priorities',
      detail: touched ? 'Your effort went to high-impact items.' : 'Today’s completions were not among the highest-ranked open tasks. That can be fine if priorities changed — consider updating them.',
      methodology: 'Compares tasks completed today against the deterministic top-3 ranking (deadline, priority, dependencies).',
      refs: [],
      provenance: 'inference',
    });
  }

  // ---- tomorrow ----------------------------------------------------------------
  const rankTomorrow = scoreTasks(input.tasks, tomorrow, tz);
  const tomorrowEvents = blockingEvents(eventsOnDay(input.events, tomorrow, tz));
  const tEnd = dayBounds(tomorrow, tz).end;
  const deadlinesTomorrow = tasks
    .filter((t) => isOpen(t) && t.dueAt && DateTime.fromISO(t.dueAt) < tEnd && DateTime.fromISO(t.dueAt) >= dayBounds(tomorrow, tz).start)
    .map((t) => ({ taskId: t.id, title: t.title, dueAt: t.dueAt! }));
  const prep = tomorrowEvents.filter(needsPreparation).map((e) => ({ itemId: e.id, title: e.title, start: e.data.start }));
  const firstR = rankTomorrow.find((r) => r.blockedBy.length === 0);
  const firstT = firstR ? byId.get(firstR.taskId) : undefined;
  const beforeSignOff = awaitingReply
    .filter((a) => a.kind === 'email')
    .slice(0, 3)
    .map((a) => ({ text: `Reply to ${a.from} about “${a.title}”`, refs: [] as SourceRef[] }));

  const refs = buildRefRegistry({
    events: [...todayEvents, ...tomorrowEvents],
    emails: input.emails.filter((e) => awaitingReply.some((a) => a.itemId === e.id) || emailsHandled.some((h) => h.itemId === e.id)),
    messages: input.messages.filter((m) => awaitingReply.some((a) => a.itemId === m.id)),
    tasks: uniq([...completed, ...planned, ...rankTomorrow.slice(0, 10).map((r) => byId.get(r.taskId)!).filter(Boolean), ...postponed]),
  });
  for (const b of beforeSignOff) {
    const id = awaitingReply.find((a) => b.text.includes(a.title))?.itemId;
    const r = id ? refs.byId.get(id) : undefined;
    if (r) b.refs.push(r);
  }
  for (const i of insights) {
    if (i.id === 'postponed') i.refs = postponed.map((t) => refs.byId.get(t.id)).filter((x): x is SourceRef => !!x);
    if (i.id === 'underestimated') i.refs = under.map((t) => refs.byId.get(t.id)).filter((x): x is SourceRef => !!x);
  }

  const warnings: string[] = [];
  for (const f of input.freshness) if (f.status === 'error' || f.stale) warnings.push(`${f.label} may be out of date; this review could be missing activity from it.`);
  if (meetings.length) warnings.push('Meeting attendance is based on your calendar response and cannot be verified. Correct it below if needed.');

  const summary = [
    completed.length ? `You completed ${completed.length} task${completed.length > 1 ? 's' : ''} today.` : 'No tasks were marked done today.',
    meetings.length ? `${meetings.length} meeting${meetings.length > 1 ? 's were' : ' was'} on your calendar.` : '',
    emailsHandled.length ? `You replied in ${emailsHandled.length} email thread${emailsHandled.length > 1 ? 's' : ''}.` : '',
    plannedNotDone.length ? `${plannedNotDone.length} planned task${plannedNotDone.length > 1 ? 's' : ''} carry over.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    input,
    date,
    tomorrow,
    tz,
    refs,
    base: {
      date,
      timezone: tz,
      dateLabel: formatDateLong(date, tz),
      summary,
      summaryProvenance: 'fact',
      accomplishments: {
        completedTasks: completed.map((t) => ({ taskId: t.id, title: t.title, completedAt: t.completedAt!, projectId: t.projectId })),
        meetings,
        emailsHandled,
        projectProgress,
        inferredProgress,
      },
      unfinished: { plannedNotDone, approachingDeadlines, awaitingReply, carryOver, blockers },
      insights,
      tomorrow: {
        date: tomorrow,
        priorities: rankTomorrow.slice(0, 3).map((r) => ({ taskId: r.taskId, title: byId.get(r.taskId)?.title ?? '', reasons: r.reasons })),
        deadlines: deadlinesTomorrow,
        meetingsNeedingPrep: prep,
        firstTask: firstT ? { taskId: firstT.id, title: firstT.title, reason: firstR!.reasons.join(' · ') || 'Highest-ranked unblocked task', provenance: 'suggestion' } : null,
        beforeSignOff,
      },
      freshness: input.freshness,
      warnings,
    },
  };
}

function uniq<T extends { id: string }>(xs: T[]): T[] {
  const s = new Set<string>();
  return xs.filter((x) => (s.has(x.id) ? false : (s.add(x.id), true)));
}

export function reviewSystemPrompt(prefs: UserPreferences): string {
  return [
    personaInstructions(prefs),
    UNTRUSTED_CONTENT_POLICY,
    GROUNDING_RULES,
    'You are writing the end-of-day review. Never shame the user and never invent a productivity score. Distinguish confirmed completions from inferred progress. Meeting attendance is NOT verified; do not claim meetings achieved their goals.',
    'Respond only with JSON matching the provided schema.',
  ].join('\n\n');
}

export function reviewUserPrompt(ctx: ReviewContext): string {
  const b = ctx.base;
  const r = (id: string) => ctx.refs.byId.get(id)?.ref ?? '?';
  const L: string[] = [`Date: ${ctx.date} (${ctx.tz}).`, '', 'FACTS:'];
  L.push(`Completed today (confirmed): ${b.accomplishments.completedTasks.map((t) => `[${r(t.taskId)}] ${sanitizeText(t.title, 100)}`).join('; ') || 'none'}`);
  L.push(`In progress (inferred): ${b.accomplishments.inferredProgress.map((t) => sanitizeText(t.title, 100)).join('; ') || 'none'}`);
  L.push(`Calendar meetings (attendance unverified): ${b.accomplishments.meetings.map((m) => `[${r(m.itemId)}] ${sanitizeText(m.title, 80)} ${formatTime(m.start, ctx.tz)}`).join('; ') || 'none'}`);
  L.push(`Email threads replied to: ${b.accomplishments.emailsHandled.length}`);
  L.push(`Planned but not done: ${b.unfinished.plannedNotDone.map((t) => `[${r(t.taskId)}] ${sanitizeText(t.title, 100)} (${t.status})`).join('; ') || 'none'}`);
  L.push(`Deadlines in next 3 days: ${b.unfinished.approachingDeadlines.map((t) => `[${r(t.taskId)}] ${sanitizeText(t.title, 80)} due ${t.dueAt}`).join('; ') || 'none'}`);
  L.push(`Awaiting the user's reply: ${b.unfinished.awaitingReply.map((a) => `[${r(a.itemId)}] ${sanitizeText(a.title, 80)} from ${sanitizeText(a.from, 40)}`).join('; ') || 'none'}`);
  L.push(`Blockers: ${b.unfinished.blockers.map((t) => `[${r(t.taskId)}] ${sanitizeText(t.title, 80)}: ${t.reason}`).join('; ') || 'none'}`);
  L.push(`Computed insights: ${b.insights.map((i) => `${i.title} — ${i.detail}`).join(' | ') || 'none'}`);
  L.push(`Tomorrow (${ctx.tomorrow}) ranked tasks: ${b.tomorrow.priorities.map((p) => `[${r(p.taskId)}] ${sanitizeText(p.title, 80)} (${p.reasons.join(', ')})`).join('; ') || 'none'}`);
  L.push(`Tomorrow meetings needing prep: ${b.tomorrow.meetingsNeedingPrep.map((m) => `[${r(m.itemId)}] ${sanitizeText(m.title, 80)} at ${formatTime(m.start, ctx.tz)}`).join('; ') || 'none'}`);
  L.push('', 'TASK: Write the review JSON: a short summary, up to 3 additional evidence-based insights (cite basisRefs), the best first task for tomorrow (a T ref), and up to 3 things worth finishing before signing off.');
  return L.join('\n');
}

export function composeReview(ctx: ReviewContext, ai: ReviewAIOutput | null, meta: { model: string | null; aiError: string | null; now: Date }): Review {
  const base: ReviewContext["base"] = JSON.parse(JSON.stringify(ctx.base));
  const resolve = (x: string) => ctx.refs.byRef.get(x.trim());
  if (ai) {
    if (ai.summary.trim()) {
      base.summary = ai.summary.slice(0, 900);
      base.summaryProvenance = 'inference';
    }
    for (const [i, ins] of ai.insights.slice(0, 3).entries()) {
      const refs = ins.basisRefs.map(resolve).filter((x): x is SourceRef => !!x);
      if (!refs.length) continue;
      base.insights.push({ id: `ai-${i}`, title: ins.title.slice(0, 140), detail: ins.detail.slice(0, 400), methodology: 'Observation generated by your AI provider from the records cited.', refs, provenance: 'inference' });
    }
    const ft = ai.firstTaskRef ? resolve(ai.firstTaskRef) : undefined;
    const t = ft?.kind === 'task' ? ctx.input.tasks.find((x) => x.id === ft.id && isOpen(x) && x.confirmed) : undefined;
    if (t) base.tomorrow.firstTask = { taskId: t.id, title: t.title, reason: (ai.firstTaskReason ?? '').slice(0, 240), provenance: 'suggestion' };
    const bso = ai.beforeSignOff
      .slice(0, 3)
      .map((x) => ({ text: x.text.slice(0, 200), refs: x.refs.map(resolve).filter((r): r is SourceRef => !!r) }))
      .filter((x) => x.refs.length);
    if (bso.length) base.tomorrow.beforeSignOff = bso;
  }
  return { ...base, generatedAt: meta.now.toISOString(), mode: ai ? 'ai' : 'rules', model: meta.model, aiError: meta.aiError };
}
