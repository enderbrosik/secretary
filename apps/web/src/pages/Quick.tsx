import { useState } from 'react';
import { DateTime } from 'luxon';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { fmtTime } from '../lib/format';
import { useApiMutation, useBriefing, useMe } from '../lib/queries';
import { Badge, Checkbox, Input, Spinner } from '../ui';

/** Compact view for the menu bar / tray window. */
export default function QuickPage() {
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const b = useBriefing();
  const [title, setTitle] = useState('');
  const add = useApiMutation(() => api('/api/tasks', { method: 'POST', body: { title } }), [['tasks']]);
  const done = useApiMutation((id: string) => api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'done' } }), [['briefing'], ['tasks']]);
  const br = b.data?.briefing;
  const upcoming = br?.plan.filter((p) => p.kind === 'meeting' && Date.parse(p.end) > Date.now()).slice(0, 3) ?? [];
  return (
    <div className="min-h-screen bg-bg p-4 text-[13px]">
      <div className="text-[11.5px] uppercase tracking-wider text-faint">{DateTime.now().setZone(tz).toFormat('cccc, LLL d')}</div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          try {
            await add.mutateAsync(undefined);
            setTitle('');
            toast.success('Task added');
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      >
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Quick add a task…" autoFocus aria-label="New task" />
        <button type="submit" aria-label="Add" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink">
          <Plus className="size-4" />
        </button>
      </form>
      {b.isLoading ? (
        <Spinner className="mt-6" />
      ) : !br ? (
        <p className="mt-6 text-muted">Today’s briefing isn’t ready yet.</p>
      ) : (
        <>
          <div className="mt-5 mb-1.5 text-[12px] font-medium text-muted">Top priorities</div>
          <ul className="space-y-1.5">
            {br.priorities.slice(0, 4).map((p) => (
              <li key={p.taskId} className="flex items-start gap-2">
                <Checkbox checked={false} onCheckedChange={() => done.mutate(p.taskId)} label={`Complete ${p.title}`} className="mt-0.5" />
                <span className="flex-1">{p.title}</span>
                {p.deadline && <Badge tone="warn">due</Badge>}
              </li>
            ))}
          </ul>
          <div className="mt-5 mb-1.5 text-[12px] font-medium text-muted">Next up</div>
          <ul className="space-y-1">
            {upcoming.length ? upcoming.map((m) => (
              <li key={m.id} className="flex gap-2">
                <span className="w-16 shrink-0 tabular text-muted">{fmtTime(m.start, tz)}</span>
                <span className="truncate">{m.title}</span>
              </li>
            )) : <li className="text-muted">No more meetings today.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
