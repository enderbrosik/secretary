import { Check, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useApiMutation, useTasks } from '../lib/queries';
import { Badge, Button, Card, CardHeader, EmptyState, SourceChip } from '../ui';

/** Review tray for tasks the assistant detected in emails/messages. Nothing is added until accepted. */
export function SuggestedTasks({ compact }: { compact?: boolean }) {
  const q = useTasks('suggested');
  const accept = useApiMutation((id: string) => api(`/api/tasks/${id}/accept`, { method: 'POST', body: {} }), [['tasks']]);
  const dismiss = useApiMutation((id: string) => api(`/api/tasks/${id}/dismiss`, { method: 'POST', body: {} }), [['tasks']]);
  const items = q.data ?? [];
  if (compact && !items.length) return null;
  return (
    <Card>
      <CardHeader title="Detected tasks" subtitle="Found in your messages — review before they’re added" icon={<Sparkles className="size-4" />} actions={items.length ? <Badge tone="accent">{items.length}</Badge> : undefined} />
      {!items.length ? (
        <EmptyState title="No suggestions to review" body="When an email or message asks something of you, a suggested task appears here." className="pt-0" />
      ) : (
        <ul className="flex flex-col">
          {items.slice(0, compact ? 4 : 50).map((t) => (
            <li key={t.id} className="border-t border-line px-5 py-3 first:border-t-0">
              <div className="text-[13.5px] font-medium">{t.title}</div>
              {t.suggestionReason && <p className="mt-0.5 text-[12.5px] text-muted">{t.suggestionReason}</p>}
              {t.description && <p className="mt-0.5 text-[12.5px] text-warn">{t.description}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="accent">AI suggestion</Badge>
                {t.sourceItem && <SourceChip source={t.sourceItem.source} url={t.sourceItem.url} label={`From: ${t.sourceItem.title.slice(0, 40)}`} />}
                <span className="flex-1" />
                <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => dismiss.mutate(t.id, { onError: (e) => toast.error(errorMessage(e)) })}>
                  Dismiss
                </Button>
                <Button size="sm" icon={<Check className="size-3.5" />} onClick={() => accept.mutate(t.id, { onSuccess: () => toast.success('Added to your tasks'), onError: (e) => toast.error(errorMessage(e)) })}>
                  Add task
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
