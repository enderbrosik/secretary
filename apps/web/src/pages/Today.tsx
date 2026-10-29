import { useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, CalendarClock, Clock, Coffee, Lightbulb, ListChecks, Mail, MessageSquare, RefreshCw, Sparkles, Target, Users, Video } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { EMAIL_CATEGORY_LABELS, type Briefing, type BriefingEmail, type BriefingMeeting, type BriefingPriority, type PlanBlock } from '@secretary/core';
import { api, errorMessage } from '../lib/api';
import { fmtDue, fmtMinutes, fmtRelative, fmtTime, initials } from '../lib/format';
import { openExternal } from '../lib/platform';
import { useApiMutation, useBriefing, useMe, useTasks, type TaskDto } from '../lib/queries';
import { PlanDialog } from '../components/PlanDialog';
import { SuggestedTasks } from '../components/SuggestedTasks';
import { Avatar, Badge, Banner, Button, Card, CardHeader, Checkbox, cn, EmptyState, ErrorState, Expandable, ProvenanceBadge, Skeleton, SourceChip, type Tone } from '../ui';

export function TodayPage() {
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const q = useBriefing();
  const qc = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const { openQuickAdd } = useOutletContext<{ openQuickAdd: () => void }>();

  const generate = async () => {
    setGenerating(true);
    try {
      await api('/api/briefings/generate', { method: 'POST', body: {} });
      await Promise.all([qc.invalidateQueries({ queryKey: ['briefing'] }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  if (q.isLoading) return <TodaySkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const b = q.data?.briefing;
  if (!b)
    return (
      <div>
        <Greeting name={me.data?.user?.displayName ?? ''} />
        <Card className="mt-6">
          <EmptyState
            icon={<Sparkles className="size-5" />}
            title="Your briefing for today hasn’t been prepared yet"
            body={`It’s scheduled for ${me.data?.settings?.briefingTime ?? 'the morning'} on work days. You can prepare it now — it takes a few seconds.`}
            action={
              <Button variant="primary" loading={generating} onClick={generate} icon={<Sparkles className="size-4" />}>
                Prepare today’s briefing
              </Button>
            }
          />
        </Card>
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 max-w-3xl">
          <div className="text-[12px] font-medium uppercase tracking-[0.08em] text-faint">{b.overview.dateLabel}</div>
          <h1 className="mt-1.5 font-display text-[34px] leading-[1.12] tracking-[-0.015em]">{b.greeting}.</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{b.overview.summary}</p>
          <div className="mt-2 flex items-center gap-2 text-[12px] text-faint">
            <ProvenanceBadge kind={b.overview.summaryProvenance} />
            <span>
              Prepared {fmtRelative(b.generatedAt)}
              {b.model ? ` · ${b.model}` : ''}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={openQuickAdd}>Add task</Button>
          <Button variant="primary" icon={<RefreshCw className={cn('size-4', generating && 'animate-spin')} />} disabled={generating} onClick={generate}>
            {generating ? 'Refreshing…' : 'Refresh briefing'}
          </Button>
        </div>
      </header>

      <Stats b={b} />

      {b.mode === 'rules' && b.aiError && (
        <Banner tone="info" title="Rule-based briefing" action={<Link to="/settings/ai"><Button size="sm">AI settings</Button></Link>}>
          {b.aiError} Facts, deadlines and conflicts below are computed from your data; AI summaries and tailored suggestions are unavailable.
        </Banner>
      )}
      {b.warnings.filter((w) => !w.startsWith('No calendar') || !me.data?.demoMode).map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}

      {b.attention.length > 0 && <Attention b={b} />}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Priorities b={b} tz={tz} />
          <Communications b={b} tz={tz} />
          <Meetings b={b} tz={tz} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Timeline plan={b.plan} tz={tz} />
          <Tips b={b} />
          <SuggestedTasks compact />
          <Freshness b={b} />
        </div>
      </div>
    </div>
  );
}

function Greeting({ name }: { name: string }) {
  const h = new Date().getHours();
  return <h1 className="font-display text-[34px] tracking-[-0.015em]">{h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}{name ? `, ${name.split(' ')[0]}` : ''}.</h1>;
}

function TodaySkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-10 w-80" />
      <Skeleton className="h-5 w-full max-w-2xl" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

function Stats({ b }: { b: Briefing }) {
  const items = [
    { label: 'Meetings', value: String(b.overview.meetingsCount), sub: b.overview.meetingMinutes ? fmtMinutes(b.overview.meetingMinutes) : 'none', icon: Users },
    { label: 'Free focus time', value: fmtMinutes(b.overview.focusMinutes), sub: `${b.overview.freeSlots.filter((s) => s.minutes >= 30).length} blocks ≥ 30m`, icon: Target },
    { label: 'Due today', value: String(b.overview.dueTodayCount), sub: b.overview.overdueCount ? `${b.overview.overdueCount} overdue` : 'none overdue', icon: ListChecks, tone: b.overview.overdueCount ? 'warn' : undefined },
    { label: 'Conflicts', value: String(b.overview.conflicts.length), sub: b.overview.conflicts.length ? 'need a decision' : 'calendar is clear', icon: CalendarClock, tone: b.overview.conflicts.length ? 'danger' : undefined },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((s, i) => (
        <motion.div key={s.label} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
          <Card className="px-4 py-3.5">
            <div className="flex items-center gap-1.5 text-[12px] text-muted">
              <s.icon className="size-3.5" />
              {s.label}
            </div>
            <div className="mt-1 text-[22px] font-semibold tabular tracking-[-0.02em]">{s.value}</div>
            <div className={cn('text-[12px]', s.tone === 'warn' ? 'text-warn' : s.tone === 'danger' ? 'text-danger' : 'text-faint')}>{s.sub}</div>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}

function Attention({ b }: { b: Briefing }) {
  const tone: Record<string, Tone> = { conflict: 'danger', overdue: 'warn', urgent_email: 'danger', meeting_soon: 'accent', stale_source: 'warn' };
  const items = b.attention.filter((a) => a.kind !== 'stale_source');
  if (!items.length) return null;
  return (
    <Card className="border-warn/30">
      <CardHeader title="Needs attention" icon={<AlertCircle className="size-4 text-warn" />} />
      <ul className="flex flex-col gap-2 px-5 pb-4">
        {items.map((a, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-[13.5px]">
            <Badge tone={tone[a.kind] ?? 'neutral'}>{a.kind.replace('_', ' ')}</Badge>
            <span className="min-w-0 flex-1">{a.text}</span>
            {a.refs.slice(0, 2).map((r) => (
              <SourceChip key={r.id} source={r.source} url={r.url} />
            ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Priorities({ b, tz }: { b: Briefing; tz: string }) {
  const qc = useQueryClient();
  const tasks = useTasks('open');
  const complete = useApiMutation((id: string) => api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'done' } }), [['tasks']]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const byId = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data]);
  if (!b.priorities.length)
    return (
      <Card>
        <CardHeader title="Top priorities" icon={<Target className="size-4" />} />
        <EmptyState title="No open tasks to prioritize" body="Add tasks or connect a task app, and they’ll be ranked here by deadline, importance and dependencies." className="pt-2" />
      </Card>
    );
  return (
    <Card>
      <CardHeader title="Top priorities" subtitle="Ranked by deadlines, priority and what blocks other work" icon={<Target className="size-4" />} />
      <ol className="flex flex-col">
        {b.priorities.map((p, i) => (
          <PriorityRow
            key={p.taskId}
            p={p}
            index={i}
            tz={tz}
            task={byId.get(p.taskId)}
            done={done.has(p.taskId) || byId.get(p.taskId)?.status === 'done'}
            onDone={async () => {
              setDone((s) => new Set(s).add(p.taskId));
              try {
                await complete.mutateAsync(p.taskId);
                const t = byId.get(p.taskId);
                toast.success('Marked done', t?.canCompleteExternally ? { action: { label: `Also complete in ${t.source}`, onClick: () => void api(`/api/tasks/${p.taskId}/complete-external`, { method: 'POST', body: {} }).then(() => toast.success('Completed in source app'), (e) => toast.error(errorMessage(e))) } } : undefined);
                void qc.invalidateQueries({ queryKey: ['tasks'] });
              } catch (e) {
                setDone((s) => {
                  const n = new Set(s);
                  n.delete(p.taskId);
                  return n;
                });
                toast.error(errorMessage(e));
              }
            }}
          />
        ))}
      </ol>
    </Card>
  );
}

function PriorityRow({ p, index, tz, task, done, onDone }: { p: BriefingPriority; index: number; tz: string; task?: TaskDto; done: boolean; onDone: () => void }) {
  const due = p.deadline ? fmtDue(p.deadline.at, p.deadline.allDay, tz) : null;
  return (
    <li className={cn('border-t border-line px-5 py-4 first:border-t-0 transition-opacity', done && 'opacity-50')}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 w-5 text-[13px] font-semibold tabular text-faint">{index + 1}</span>
        <Checkbox checked={done} onCheckedChange={(v) => v && !done && onDone()} label={`Mark “${p.title}” done`} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className={cn('text-[14.5px] font-medium leading-snug', done && 'line-through')}>{p.title}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {due && (
              <Badge tone={p.reasons.includes('Overdue') ? 'danger' : 'warn'} title="Deadline from your task source">
                <Clock className="size-3" />
                Due {due}
              </Badge>
            )}
            {task?.priority === 'urgent' || task?.priority === 'high' ? <Badge tone="danger">{task.priority}</Badge> : null}
            {p.refs.map((r) => (
              <SourceChip key={r.id} source={r.source} url={r.url} label={r.kind === 'task' ? undefined : r.kind === 'email' ? 'Email' : r.kind === 'message' ? 'Message' : 'Event'} />
            ))}
          </div>
          <div className="mt-2.5 text-[13px] text-ink-2">
            <span className="font-medium text-ink">Next: </span>
            {p.nextAction}
          </div>
          <div className="mt-2">
            <Expandable summary="Why this matters">
              <dl className="grid gap-2 rounded-lg bg-bg-subtle p-3 text-[13px] sm:grid-cols-[110px_1fr]">
                <dt className="text-muted">Why</dt>
                <dd className="flex flex-wrap items-center gap-1.5">
                  {p.why} <ProvenanceBadge kind={p.provenance.why} />
                </dd>
                {p.when && (
                  <>
                    <dt className="text-muted">When</dt>
                    <dd className="flex flex-wrap items-center gap-1.5">
                      {p.when} <ProvenanceBadge kind="suggestion" />
                    </dd>
                  </>
                )}
                {p.ifDelayed && (
                  <>
                    <dt className="text-muted">If delayed</dt>
                    <dd>{p.ifDelayed}</dd>
                  </>
                )}
                {p.reasons.length > 0 && (
                  <>
                    <dt className="text-muted">Signals</dt>
                    <dd className="flex flex-wrap gap-1">
                      {p.reasons.map((r) => (
                        <Badge key={r}>{r}</Badge>
                      ))}
                    </dd>
                  </>
                )}
              </dl>
            </Expandable>
          </div>
        </div>
      </div>
    </li>
  );
}

const CAT_TONE: Record<string, Tone> = { urgent: 'danger', needs_reply: 'accent', waiting_for_me: 'warn', informational: 'neutral', can_wait: 'neutral' };

function Communications({ b, tz }: { b: Briefing; tz: string }) {
  const nav = useNavigate();
  const emails = b.emails.filter((e) => e.category !== 'can_wait').slice(0, 6);
  const msgs = b.messages.slice(0, 4);
  return (
    <Card>
      <CardHeader
        title="Messages that need you"
        subtitle={`${b.emails.filter((e) => ['urgent', 'needs_reply', 'waiting_for_me'].includes(e.category)).length} emails waiting on a reply · ${b.messages.length} chat messages`}
        icon={<Mail className="size-4" />}
        actions={
          <Button size="sm" variant="ghost" onClick={() => nav('/inbox')}>
            Inbox <ArrowRight className="size-3.5" />
          </Button>
        }
      />
      {!emails.length && !msgs.length ? (
        <EmptyState title="Nothing urgent in your inbox" body="Connect email or Slack to see what needs your attention." className="pt-2" />
      ) : (
        <ul className="flex flex-col">
          {emails.map((e) => (
            <EmailRow key={e.itemId} e={e} tz={tz} />
          ))}
          {msgs.map((m) => (
            <li key={m.itemId} className="flex gap-3 border-t border-line px-5 py-3.5">
              <Avatar label={initials(m.author)} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-medium">{m.author}</span>
                  <span className="text-[12px] text-faint">
                    <MessageSquare className="mr-1 inline size-3" />
                    {m.channel} · {fmtTime(m.at, tz)}
                  </span>
                </div>
                <p className="mt-0.5 text-[13px] text-ink-2 line-clamp-2">{m.summary}</p>
                {m.actionItem && <p className="mt-1 text-[12.5px] text-accent-text">→ {m.actionItem}</p>}
              </div>
              <SourceChip source="slack" url={m.url} label="Open" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function EmailRow({ e, tz }: { e: BriefingEmail; tz: string }) {
  return (
    <li className="flex gap-3 border-t border-line px-5 py-3.5 first:border-t-0">
      <Avatar label={initials(e.sender)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium">{e.sender}</span>
          <Badge tone={CAT_TONE[e.category]}>{EMAIL_CATEGORY_LABELS[e.category]}</Badge>
          {e.suspicious && (
            <Badge tone="danger" title="Contains text that tries to instruct an AI assistant. It was treated as plain data.">
              Suspicious content
            </Badge>
          )}
          <span className="text-[12px] text-faint">{fmtTime(e.receivedAt, tz)}</span>
        </div>
        <div className="mt-0.5 truncate text-[13.5px] text-ink">{e.subject}</div>
        <p className="mt-0.5 text-[13px] text-muted line-clamp-2">{e.summary}</p>
        {e.whyItMatters && (
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-2">
            {e.whyItMatters}
            {e.aiCategorized && <ProvenanceBadge kind="inference" />}
          </p>
        )}
      </div>
      <SourceChip source={e.source} url={e.url} label="Open" />
    </li>
  );
}

function Meetings({ b, tz }: { b: Briefing; tz: string }) {
  if (!b.meetings.length) return null;
  return (
    <Card>
      <CardHeader title="Meeting preparation" subtitle="Upcoming meetings with other people today" icon={<Users className="size-4" />} />
      <ul className="flex flex-col">
        {b.meetings.map((m) => (
          <MeetingRow key={m.itemId} m={m} tz={tz} />
        ))}
      </ul>
    </Card>
  );
}

function MeetingRow({ m, tz }: { m: BriefingMeeting; tz: string }) {
  const flagText: Record<string, [string, Tone]> = { conflict: ['Conflict', 'danger'], low_prep_time: ['Little prep time', 'warn'], no_agenda: ['No agenda', 'neutral'] };
  return (
    <li className="border-t border-line px-5 py-4 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[14px] font-medium">{m.title}</div>
          <div className="mt-0.5 text-[12.5px] text-muted tabular">
            {fmtTime(m.start, tz)} – {fmtTime(m.end, tz)} · {m.durationMinutes} min{m.attendees.length ? ` · ${m.attendees.map((a) => a.name ?? a.email).slice(0, 4).join(', ')}${m.attendees.length > 4 ? ` +${m.attendees.length - 4}` : ''}` : ''}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {m.flags.map((f) => (
            <Badge key={f} tone={flagText[f]![1]}>
              {flagText[f]![0]}
            </Badge>
          ))}
          {m.conferenceUrl && (
            <Button size="sm" variant="subtle" icon={<Video className="size-3.5" />} onClick={() => void openExternal(m.conferenceUrl!)}>
              Join
            </Button>
          )}
          <SourceChip source="" url={m.url} label="Event" />
        </div>
      </div>
      {m.agenda && <p className="mt-2 whitespace-pre-line rounded-lg bg-bg-subtle px-3 py-2 text-[12.5px] text-ink-2 line-clamp-4">{m.agenda}</p>}
      {(m.prepSteps.length > 0 || m.questions.length > 0) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {m.prepSteps.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted">
                Prepare {m.aiPrepared ? <ProvenanceBadge kind="suggestion" /> : null}
              </div>
              <ul className="space-y-1 text-[13px] text-ink-2">
                {m.prepSteps.map((s) => (
                  <li key={s}>• {s}</li>
                ))}
              </ul>
            </div>
          )}
          {m.questions.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] font-medium text-muted">Questions worth asking</div>
              <ul className="space-y-1 text-[13px] text-ink-2">
                {m.questions.map((s) => (
                  <li key={s}>• {s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {m.related.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
          Related:
          {m.related.map((r) => (
            <span key={r.id} className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5">
              <span className="max-w-[200px] truncate">{r.title}</span>
              <SourceChip source={r.source} url={r.url} label="" />
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

const BLOCK_STYLE: Record<PlanBlock['kind'], string> = {
  meeting: 'border-line bg-surface-2',
  focus: 'border-accent/30 bg-accent-soft/60 border-dashed',
  break: 'border-ok/30 bg-ok-soft/60 border-dashed',
  buffer: 'border-line border-dashed',
};

function Timeline({ plan, tz }: { plan: PlanBlock[]; tz: string }) {
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const proposals = plan.filter((p) => !p.existing && p.kind === 'focus');
  return (
    <Card>
      <CardHeader
        title="Your day"
        subtitle="Meetings are from your calendar; dashed blocks are suggestions"
        icon={<CalendarClock className="size-4" />}
        actions={
          proposals.length > 0 ? (
            <Button size="sm" variant="subtle" onClick={() => setOpen(true)}>
              Review plan
            </Button>
          ) : undefined
        }
      />
      {!plan.length ? (
        <EmptyState title="Nothing scheduled" body="Your remaining work hours are free." className="pt-0" />
      ) : (
        <ol className="flex flex-col gap-1.5 px-4 pb-4">
          {plan.map((p) => {
            const past = Date.parse(p.end) < now;
            const current = Date.parse(p.start) <= now && Date.parse(p.end) > now;
            return (
              <li key={p.id} className={cn('flex gap-3 rounded-lg border px-3 py-2', BLOCK_STYLE[p.kind], past && 'opacity-45', current && 'ring-2 ring-accent/40')}>
                <div className="w-[62px] shrink-0 text-[12px] tabular text-muted leading-5">
                  {fmtTime(p.start, tz)}
                  <div className="text-faint">{fmtTime(p.end, tz)}</div>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[13px] font-medium">
                    {p.kind === 'break' ? <Coffee className="size-3.5 text-ok" /> : p.kind === 'focus' ? <Target className="size-3.5 text-accent-text" /> : null}
                    <span className="truncate">{p.title}</span>
                  </div>
                  <div className="text-[11.5px] text-faint">{p.kind === 'meeting' ? 'On your calendar' : p.kind === 'focus' ? 'Suggested focus block' : 'Suggested break'}</div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <PlanDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

function Tips({ b }: { b: Briefing }) {
  if (!b.tips.length) return null;
  return (
    <Card>
      <CardHeader title="Suggestions for today" subtitle="Based on your calendar, tasks and messages" icon={<Lightbulb className="size-4" />} />
      <ul className="flex flex-col gap-3 px-5 pb-4">
        {b.tips.map((t, i) => (
          <li key={i} className="text-[13.5px] leading-relaxed text-ink-2">
            {t.text}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <ProvenanceBadge kind="suggestion" />
              <span className="text-[11.5px] text-faint">Based on: {t.basis.slice(0, 3).map((r) => r.title).join(', ')}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Freshness({ b }: { b: Briefing }) {
  if (!b.freshness.length) return null;
  return (
    <div className="px-1 text-[12px] text-faint">
      <div className="mb-1 font-medium text-muted">Sources</div>
      <ul className="space-y-0.5">
        {b.freshness.map((f) => (
          <li key={f.connectionId} className={cn(f.status === 'error' && 'text-danger', f.stale && 'text-warn')}>
            {f.label} — {f.status === 'error' ? 'sync failed' : f.lastSyncedAt ? `synced ${fmtRelative(f.lastSyncedAt)}` : 'not synced yet'}
          </li>
        ))}
      </ul>
    </div>
  );
}
