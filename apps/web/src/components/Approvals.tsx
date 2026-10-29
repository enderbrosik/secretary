import { CalendarPlus, Check, CheckCircle2, Mail, Send, ShieldCheck, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { openExternal } from '../lib/platform';
import { useActions, useApiMutation, type PendingAction } from '../lib/queries';
import { Badge, Button, Dialog, EmptyState } from '../ui';

const ICON: Record<string, React.ReactNode> = {
  create_draft: <Mail className="size-4" />,
  send_email: <Send className="size-4" />,
  create_events: <CalendarPlus className="size-4" />,
  complete_task: <CheckCircle2 className="size-4" />,
};

/** Every external write waits here until the user approves that specific action. */
export function ApprovalsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const pending = useActions('pending');
  const recent = useActions();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Approvals" description="Nothing is sent or changed in your accounts until you approve it here." wide>
      {pending.data?.length ? (
        <div className="flex flex-col gap-3">
          {pending.data.map((a) => (
            <ActionCard key={a.id} action={a} />
          ))}
        </div>
      ) : (
        <EmptyState icon={<ShieldCheck className="size-5" />} title="Nothing waiting for approval" body="Drafts, emails and calendar changes you ask for appear here first." />
      )}
      {!!recent.data?.filter((a) => a.status !== 'pending').length && (
        <div className="mt-6">
          <div className="mb-2 text-[12px] font-medium uppercase tracking-wider text-faint">Recent</div>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {recent.data
              .filter((a) => a.status !== 'pending')
              .slice(0, 8)
              .map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                  <span className="text-muted">{ICON[a.type]}</span>
                  <span className="flex-1 truncate">{a.summary}</span>
                  <Badge tone={a.status === 'done' ? 'ok' : a.status === 'failed' ? 'danger' : 'neutral'}>{a.status}</Badge>
                  <span className="text-[11.5px] text-faint">{fmtRelative(a.createdAt)}</span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

export function ActionCard({ action }: { action: PendingAction }) {
  const approve = useApiMutation(() => api<PendingAction>(`/api/actions/${action.id}/approve`, { method: 'POST', body: {} }), [['actions'], ['calendar'], ['tasks']]);
  const reject = useApiMutation(() => api(`/api/actions/${action.id}/reject`, { method: 'POST', body: {} }), [['actions']]);
  const p = action.payload as { to?: string[]; subject?: string; body?: string; events?: { title: string; start: string; end: string }[] };
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-accent-text">{ICON[action.type]}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{action.summary}</div>
          <div className="text-[12px] text-faint">Requested {fmtRelative(action.createdAt)} · {action.origin === 'plan' ? 'from your daily plan' : action.origin === 'assistant' ? 'by the assistant' : 'by you'}</div>
          {p.body && <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 font-sans text-[13px] text-ink-2">{p.body}</pre>}
          {p.events && (
            <ul className="mt-3 space-y-1 text-[13px] text-ink-2">
              {p.events.map((e, i) => (
                <li key={i}>
                  • {e.title} — {new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}–{new Date(e.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} loading={reject.isPending} onClick={() => reject.mutate(undefined)}>
          Decline
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Check className="size-3.5" />}
          loading={approve.isPending}
          onClick={async () => {
            try {
              const r = await approve.mutateAsync(undefined);
              toast.success(r.result?.message ?? 'Done', r.result?.url ? { action: { label: 'Open', onClick: () => void openExternal(r.result!.url!) } } : undefined);
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}
