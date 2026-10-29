import { useNavigate } from 'react-router';
import { DateTime } from 'luxon';
import { NotebookPen } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useApiMutation, useMe, useReviews } from '../lib/queries';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, SkeletonList } from '../ui';

export default function ReviewsPage() {
  const q = useReviews();
  const me = useMe();
  const nav = useNavigate();
  const gen = useApiMutation(() => api<{ review: { date: string } }>('/api/reviews/generate', { method: 'POST', body: {} }), [['reviews']]);
  return (
    <div>
      <PageHeader
        title="Reviews"
        subtitle={`End-of-day reviews of what got done and what carries over. Prepared automatically at ${me.data?.settings?.reviewTime ?? '17:30'} on work days.`}
        actions={
          <Button
            variant="primary"
            loading={gen.isPending}
            onClick={async () => {
              try {
                const r = await gen.mutateAsync(undefined);
                nav(`/reviews/${r.review.date}`);
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Review today now
          </Button>
        }
      />
      <Card>
        {q.isLoading ? (
          <SkeletonList />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.length ? (
          <EmptyState icon={<NotebookPen className="size-5" />} title="No reviews yet" body="Your first end-of-day review appears here this evening — or prepare one now." />
        ) : (
          <ul>
            {q.data.map((r) => (
              <li key={r.date}>
                <button onClick={() => nav(`/reviews/${r.date}`)} className="flex w-full flex-col gap-1 border-t border-line px-5 py-4 text-left first:border-t-0 hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4">
                  <div className="w-44 shrink-0 text-[13.5px] font-medium">{DateTime.fromISO(r.date).toFormat('cccc, LLL d')}</div>
                  <div className="min-w-0 flex-1 text-[13px] text-muted line-clamp-2">{r.summary}</div>
                  <div className="flex shrink-0 gap-1.5">
                    <Badge tone="ok">{r.completed} done</Badge>
                    {r.carryOver > 0 && <Badge tone="warn">{r.carryOver} carry over</Badge>}
                    {r.corrections > 0 && <Badge>{r.corrections} corrected</Badge>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
