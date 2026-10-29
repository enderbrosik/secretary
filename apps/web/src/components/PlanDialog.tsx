import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { fmtTime } from '../lib/format';
import { useApiMutation, useMe, usePlan, type PendingAction } from '../lib/queries';
import { Banner, Button, Checkbox, Dialog, Field, Input, Select, Spinner } from '../ui';
import { ActionCard } from './Approvals';

/**
 * Lets the user review and edit the proposed plan. Selected focus blocks become
 * a pending "create events" action — nothing is written until it is approved.
 */
export function PlanDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const plan = usePlan();
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [calendar, setCalendar] = useState('');
  const [created, setCreated] = useState<PendingAction | null>(null);
  const blocks = (plan.data?.blocks ?? []).filter((b) => !b.existing && b.kind === 'focus');
  const writable = (plan.data?.calendars ?? []).filter((c) => c.canWrite);

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setSelected(Object.fromEntries(blocks.map((b) => [b.id, true])));
    setTitles(Object.fromEntries(blocks.map((b) => [b.id, `Focus: ${b.title}`])));
    setCalendar(writable[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan.data]);

  const propose = useApiMutation(
    () =>
      api<PendingAction>('/api/actions', {
        method: 'POST',
        body: {
          type: 'create_events',
          connectionId: calendar,
          origin: 'plan',
          payload: { events: blocks.filter((b) => selected[b.id]).map((b) => ({ title: titles[b.id] || b.title, start: b.start, end: b.end, description: 'Focus time planned with Secretary.' })) },
        },
      }),
    [['actions']],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Review today’s plan" description="Choose which focus blocks to add to your calendar. Existing meetings are never moved." wide>
      {plan.isLoading ? (
        <Spinner />
      ) : created ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted">Approve to add these blocks to your calendar.</p>
          <ActionCard action={created} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {!blocks.length && <p className="text-[13px] text-muted">There are no suggested focus blocks for the rest of today.</p>}
          <ul className="flex flex-col gap-2">
            {blocks.map((b) => (
              <li key={b.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <Checkbox checked={!!selected[b.id]} onCheckedChange={(v) => setSelected((s) => ({ ...s, [b.id]: v }))} label={`Include ${b.title}`} />
                <span className="w-[120px] shrink-0 text-[12.5px] tabular text-muted">
                  {fmtTime(b.start, tz)} – {fmtTime(b.end, tz)}
                </span>
                <Input value={titles[b.id] ?? ''} onChange={(e) => setTitles((t) => ({ ...t, [b.id]: e.target.value }))} className="h-8" aria-label="Event title" />
              </li>
            ))}
          </ul>
          {writable.length ? (
            <Field label="Add to calendar">
              {(id) => (
                <Select id={id} value={calendar} onChange={(e) => setCalendar(e.target.value)}>
                  {writable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.provider === 'google' ? 'Google Calendar' : 'Outlook Calendar'} — {c.accountLabel}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <Banner tone="info" title="Calendar changes are turned off">
              To add focus blocks automatically, allow “Send & make changes” for a calendar in <Link className="underline" to="/settings/integrations">Integrations</Link>. You can still follow the plan without adding it.
            </Banner>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              variant="primary"
              disabled={!writable.length || !blocks.some((b) => selected[b.id])}
              loading={propose.isPending}
              onClick={async () => {
                try {
                  setCreated(await propose.mutateAsync(undefined));
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Continue to approval
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
