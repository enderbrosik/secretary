import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, MapPin, Video } from 'lucide-react';
import type { EventItem } from '@secretary/core';
import { fmtTime } from '../lib/format';
import { openExternal } from '../lib/platform';
import { useIntegrations, useMe, useCalendar } from '../lib/queries';
import { PlanDialog } from '../components/PlanDialog';
import { Badge, Button, Card, cn, EmptyState, ErrorState, IconButton, PageHeader, SkeletonList, SourceChip } from '../ui';

export default function CalendarPage() {
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const [start, setStart] = useState(() => DateTime.now().setZone(tz).startOf('day'));
  const [planOpen, setPlanOpen] = useState(false);
  const q = useCalendar(start.toISODate()!, 7);
  const integ = useIntegrations();
  const hasCalendar = integ.data?.connections.some((c) => c.features.calendar);
  const conflictIds = useMemo(() => new Set((q.data?.conflicts ?? []).flatMap((c) => [c.a, c.b])), [q.data]);

  const days = Array.from({ length: 7 }, (_, i) => start.plus({ days: i }));
  const byDay = useMemo(() => {
    const m = new Map<string, EventItem[]>();
    for (const e of q.data?.events ?? []) {
      const d = DateTime.fromISO(e.data.start).setZone(tz).toISODate()!;
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(e);
    }
    return m;
  }, [q.data, tz]);

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle={`Your next seven days in ${tz}. Conflicts and preparation gaps are flagged automatically.`}
        actions={
          <>
            <div className="flex items-center gap-1">
              <IconButton label="Previous week" onClick={() => setStart((s) => s.minus({ days: 7 }))}>
                <ChevronLeft className="size-4" />
              </IconButton>
              <Button size="sm" onClick={() => setStart(DateTime.now().setZone(tz).startOf('day'))}>
                Today
              </Button>
              <IconButton label="Next week" onClick={() => setStart((s) => s.plus({ days: 7 }))}>
                <ChevronRight className="size-4" />
              </IconButton>
            </div>
            <Button variant="primary" onClick={() => setPlanOpen(true)}>
              Plan today
            </Button>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-7 gap-1.5">
        {days.map((d) => {
          const n = byDay.get(d.toISODate()!)?.filter((e) => !e.data.allDay).length ?? 0;
          const isToday = d.hasSame(DateTime.now().setZone(tz), 'day');
          return (
            <a key={d.toISODate()} href={`#day-${d.toISODate()}`} className={cn('rounded-xl border px-2 py-2 text-center transition-colors', isToday ? 'border-accent/40 bg-accent-soft' : 'border-line bg-surface hover:border-line-strong')}>
              <div className="text-[11px] uppercase tracking-wider text-faint">{d.toFormat('ccc')}</div>
              <div className="text-[18px] font-semibold tabular">{d.day}</div>
              <div className="text-[11px] text-muted">{n ? `${n} event${n > 1 ? 's' : ''}` : '—'}</div>
            </a>
          );
        })}
      </div>
      {q.isLoading ? (
        <Card>
          <SkeletonList rows={6} />
        </Card>
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : !hasCalendar ? (
        <Card>
          <EmptyState icon={<CalendarDays className="size-5" />} title="No calendar connected" body="Connect Google Calendar or Outlook in Settings → Integrations to see your schedule here." />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {days.map((d) => {
            const evs = byDay.get(d.toISODate()!) ?? [];
            return (
              <section key={d.toISODate()} id={`day-${d.toISODate()}`} className="scroll-mt-20">
                <h2 className="mb-2 text-[13px] font-semibold text-ink-2">
                  {d.toFormat('cccc, LLLL d')}
                  {d.hasSame(DateTime.now().setZone(tz), 'day') && <span className="ml-2 text-accent-text">Today</span>}
                </h2>
                <Card>
                  {!evs.length ? (
                    <div className="px-5 py-4 text-[13px] text-faint">No events</div>
                  ) : (
                    <ul>
                      {evs.map((e) => (
                        <EventRow key={e.id} e={e} tz={tz} conflict={conflictIds.has(e.id)} />
                      ))}
                    </ul>
                  )}
                </Card>
              </section>
            );
          })}
        </div>
      )}
      <PlanDialog open={planOpen} onOpenChange={setPlanOpen} />
    </div>
  );
}

function EventRow({ e, tz, conflict }: { e: EventItem; tz: string; conflict: boolean }) {
  const d = e.data;
  const past = Date.parse(d.end) < Date.now();
  const others = d.attendees.filter((a) => !a.self);
  return (
    <li className={cn('flex gap-4 border-t border-line px-5 py-3 first:border-t-0', past && 'opacity-55', d.status === 'cancelled' && 'line-through opacity-50')}>
      <div className="w-[76px] shrink-0 text-[12.5px] tabular text-muted">
        {d.allDay ? (
          'All day'
        ) : (
          <>
            {fmtTime(d.start, tz)}
            <div className="text-faint">{fmtTime(d.end, tz)}</div>
          </>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium">{e.title}</span>
          {conflict && (
            <Badge tone="danger">
              <AlertTriangle className="size-3" /> Overlaps
            </Badge>
          )}
          {d.selfResponse === 'needsAction' && <Badge tone="warn">Not responded</Badge>}
          {d.selfResponse === 'tentative' && <Badge>Tentative</Badge>}
          {d.selfResponse === 'declined' && <Badge>Declined</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-muted">
          {others.length > 0 && <span>{others.map((a) => a.name ?? a.email).slice(0, 5).join(', ')}{others.length > 5 ? ` +${others.length - 5}` : ''}</span>}
          {d.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3" />
              {d.location}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-2">
        {d.conferenceUrl && !past && (
          <Button size="sm" variant="subtle" icon={<Video className="size-3.5" />} onClick={() => void openExternal(d.conferenceUrl!)}>
            Join
          </Button>
        )}
        <SourceChip source={e.source} url={e.url} label={e.source === 'demo' ? 'Demo' : 'Open'} />
      </div>
    </li>
  );
}
