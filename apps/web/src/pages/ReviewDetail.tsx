import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarCheck, CheckCircle2, Hourglass, Lightbulb, Mail, Sunrise } from 'lucide-react';
import { toast } from 'sonner';
import type { Review } from '@secretary/core';
import { api, errorMessage } from '../lib/api';
import { fmtDue, fmtTime } from '../lib/format';
import { useMe, useReview } from '../lib/queries';
import { Badge, Banner, Button, Card, CardHeader, EmptyState, ErrorState, Expandable, PageHeader, ProvenanceBadge, SkeletonList, SourceChip, Textarea } from '../ui';

type Correction = { kind: string; taskId?: string; itemId?: string; status?: string; attendance?: string; note?: string; at: string };

export default function ReviewDetailPage() {
  const { date = '' } = useParams();
  const q = useReview(date);
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const qc = useQueryClient();
  const [note, setNote] = useState('');

  if (q.isLoading) return <SkeletonList rows={8} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data!.review;
  const corrections = (q.data!.corrections ?? []) as Correction[];
  const taskCorr = new Map(corrections.filter((c) => c.kind === 'task').map((c) => [c.taskId!, c.status!]));
  const meetCorr = new Map(corrections.filter((c) => c.kind === 'meeting').map((c) => [c.itemId!, c.attendance!]));

  const correct = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api(`/api/reviews/${date}/corrections`, { method: 'POST', body });
      await Promise.all([qc.invalidateQueries({ queryKey: ['review', date] }), qc.invalidateQueries({ queryKey: ['tasks'] }), qc.invalidateQueries({ queryKey: ['reviews'] })]);
      toast.success(msg);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/reviews" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" /> All reviews
        </Link>
        <PageHeader eyebrow="End-of-day review" title={r.dateLabel} subtitle={r.summary} />
        <div className="-mt-3 flex items-center gap-2 text-[12px] text-faint">
          <ProvenanceBadge kind={r.summaryProvenance} />
          {r.mode === 'rules' && r.aiError ? <span>{r.aiError}</span> : r.model ? <span>{r.model}</span> : null}
        </div>
      </div>
      {r.warnings.map((w) => (
        <Banner key={w} tone="info">
          {w}
        </Banner>
      ))}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Accomplished" subtitle="Confirmed from your tasks and mail" icon={<CheckCircle2 className="size-4 text-ok" />} />
          <div className="px-5 pb-5">
            {!r.accomplishments.completedTasks.length && !r.accomplishments.emailsHandled.length ? (
              <p className="text-[13px] text-muted">No completed tasks recorded today. If you finished something, mark it done below or in Tasks.</p>
            ) : (
              <ul className="space-y-1.5 text-[13.5px]">
                {r.accomplishments.completedTasks.map((t) => (
                  <li key={t.taskId} className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 shrink-0 text-ok" />
                    <span className="flex-1">{t.title}</span>
                    <span className="text-[12px] text-faint tabular">{fmtTime(t.completedAt, tz)}</span>
                  </li>
                ))}
                {r.accomplishments.emailsHandled.map((e) => (
                  <li key={e.itemId} className="flex items-center gap-2">
                    <Mail className="size-4 shrink-0 text-muted" />
                    <span className="flex-1">Replied: {e.subject}</span>
                    <SourceChip source="" url={e.url} label="" />
                  </li>
                ))}
              </ul>
            )}
            {r.accomplishments.projectProgress.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {r.accomplishments.projectProgress.map((p) => (
                  <Badge key={p.projectId} tone="ok">
                    {p.name}: +{p.completedToday} ({p.remaining} left)
                  </Badge>
                ))}
              </div>
            )}
            {r.accomplishments.inferredProgress.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-muted">In progress <ProvenanceBadge kind="inference" /></div>
                <ul className="space-y-1 text-[13px] text-ink-2">
                  {r.accomplishments.inferredProgress.map((t) => (
                    <li key={t.taskId}>• {t.title}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Meetings on your calendar" subtitle="Attendance isn’t verified — correct it if needed" icon={<CalendarCheck className="size-4" />} />
          <div className="px-5 pb-5">
            {!r.accomplishments.meetings.length ? (
              <p className="text-[13px] text-muted">No meetings today.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {r.accomplishments.meetings.map((m) => (
                  <li key={m.itemId} className="flex flex-wrap items-center gap-2 text-[13.5px]">
                    <span className="w-16 text-[12px] tabular text-muted">{fmtTime(m.start, tz)}</span>
                    <span className="min-w-0 flex-1 truncate">{m.title}</span>
                    {meetCorr.get(m.itemId) ? (
                      <Badge tone={meetCorr.get(m.itemId) === 'missed' ? 'warn' : 'ok'}>{meetCorr.get(m.itemId)}</Badge>
                    ) : (
                      <>
                        <Badge title="Based on your calendar response">{m.attendance === 'organizer_unverified' ? 'Organizer' : m.attendance === 'accepted_unverified' ? 'Accepted' : 'Unknown'}</Badge>
                        <Button size="sm" variant="ghost" onClick={() => correct({ kind: 'meeting', itemId: m.itemId, attendance: 'attended' }, 'Marked attended')}>Attended</Button>
                        <Button size="sm" variant="ghost" onClick={() => correct({ kind: 'meeting', itemId: m.itemId, attendance: 'missed' }, 'Marked missed')}>Missed</Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Still open" subtitle="Mark each one so tomorrow’s plan is accurate" icon={<Hourglass className="size-4 text-warn" />} />
        <div className="px-5 pb-5">
          {!r.unfinished.carryOver.length && !r.unfinished.blockers.length ? (
            <EmptyState title="Nothing carries over" body="Everything planned for today is done." className="py-4" />
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {r.unfinished.carryOver.map((t) => (
                <TaskCorrectionRow key={t.taskId} title={t.title} status={taskCorr.get(t.taskId)} onSet={(status) => correct({ kind: 'task', taskId: t.taskId, status }, 'Updated')} />
              ))}
              {r.unfinished.blockers
                .filter((b) => !r.unfinished.carryOver.some((c) => c.taskId === b.taskId))
                .map((b) => (
                  <TaskCorrectionRow key={b.taskId} title={b.title} sub={b.reason} status={taskCorr.get(b.taskId)} onSet={(status) => correct({ kind: 'task', taskId: b.taskId, status }, 'Updated')} />
                ))}
            </ul>
          )}
          {r.unfinished.awaitingReply.length > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 text-[12px] font-medium text-muted">Still waiting for your reply</div>
              <ul className="space-y-1 text-[13px]">
                {r.unfinished.awaitingReply.map((a) => (
                  <li key={a.itemId} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {a.from}: {a.title}
                    </span>
                    <SourceChip source="" url={a.url} label="" />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.unfinished.approachingDeadlines.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {r.unfinished.approachingDeadlines.map((d) => (
                <Badge key={d.taskId} tone="warn">
                  {d.title} · {fmtDue(d.dueAt, false, tz)}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Insights" subtitle="Each one explains how it was calculated" icon={<Lightbulb className="size-4" />} />
          <ul className="flex flex-col gap-4 px-5 pb-5">
            {!r.insights.length && <li className="text-[13px] text-muted">Not enough activity today for meaningful insights.</li>}
            {r.insights.map((i) => (
              <li key={i.id}>
                <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
                  {i.title} <ProvenanceBadge kind={i.provenance} />
                </div>
                <p className="mt-0.5 text-[13px] text-ink-2">{i.detail}</p>
                <div className="mt-1">
                  <Expandable summary="How this was calculated">
                    <p className="text-[12.5px] text-muted">{i.methodology}</p>
                  </Expandable>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Tomorrow r={r} tz={tz} />
      </div>

      <Card className="p-5">
        <div className="mb-2 text-[13.5px] font-medium">Add a note to this review</div>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the review missed or got wrong" />
        <div className="mt-2 flex justify-end">
          <Button disabled={!note.trim()} onClick={async () => { await correct({ kind: 'note', note }, 'Note saved'); setNote(''); }}>
            Save note
          </Button>
        </div>
        {corrections.filter((c) => c.kind === 'note').map((c, i) => (
          <p key={i} className="mt-2 rounded-lg bg-bg-subtle px-3 py-2 text-[13px] text-ink-2">{c.note}</p>
        ))}
      </Card>
    </div>
  );
}

function TaskCorrectionRow({ title, sub, status, onSet }: { title: string; sub?: string; status?: string; onSet: (s: string) => void }) {
  return (
    <li className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]">{title}</div>
        {sub && <div className="text-[12px] text-muted">{sub}</div>}
      </div>
      {status ? (
        <Badge tone={status === 'done' ? 'ok' : status === 'canceled' ? 'neutral' : 'warn'}>{status}</Badge>
      ) : (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="subtle" onClick={() => onSet('done')}>Done</Button>
          <Button size="sm" variant="subtle" onClick={() => onSet('postponed')}>Tomorrow</Button>
          <Button size="sm" variant="subtle" onClick={() => onSet('blocked')}>Blocked</Button>
          <Button size="sm" variant="ghost" onClick={() => onSet('canceled')}>Cancel</Button>
        </div>
      )}
    </li>
  );
}

function Tomorrow({ r, tz }: { r: Review; tz: string }) {
  const t = r.tomorrow;
  return (
    <Card>
      <CardHeader title="Tomorrow" subtitle={t.date} icon={<Sunrise className="size-4" />} />
      <div className="flex flex-col gap-4 px-5 pb-5 text-[13.5px]">
        {t.firstTask && (
          <div className="rounded-xl border border-accent/25 bg-accent-soft/50 p-3">
            <div className="flex items-center gap-2 text-[12px] font-medium text-accent-text">Start with <ProvenanceBadge kind="suggestion" /></div>
            <div className="mt-0.5 font-medium">{t.firstTask.title}</div>
            {t.firstTask.reason && <div className="text-[12.5px] text-muted">{t.firstTask.reason}</div>}
          </div>
        )}
        {t.priorities.length > 0 && (
          <div>
            <div className="mb-1 text-[12px] font-medium text-muted">Top priorities</div>
            <ol className="list-decimal space-y-0.5 pl-5">
              {t.priorities.map((p) => (
                <li key={p.taskId}>{p.title}</li>
              ))}
            </ol>
          </div>
        )}
        {t.deadlines.length > 0 && (
          <div>
            <div className="mb-1 text-[12px] font-medium text-muted">Deadlines</div>
            {t.deadlines.map((d) => (
              <div key={d.taskId}>
                {d.title} — {fmtTime(d.dueAt, tz)}
              </div>
            ))}
          </div>
        )}
        {t.meetingsNeedingPrep.length > 0 && (
          <div>
            <div className="mb-1 text-[12px] font-medium text-muted">Meetings to prepare for</div>
            {t.meetingsNeedingPrep.map((m) => (
              <div key={m.itemId}>
                {fmtTime(m.start, tz)} · {m.title}
              </div>
            ))}
          </div>
        )}
        {t.beforeSignOff.length > 0 && (
          <div>
            <div className="mb-1 text-[12px] font-medium text-muted">Worth finishing before you sign off</div>
            <ul className="space-y-0.5">
              {t.beforeSignOff.map((b) => (
                <li key={b.text}>• {b.text}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
