import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Mail, MessageSquare, Trash2 } from 'lucide-react';
import type { Item, Task } from '@secretary/core';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { useApiMutation, useMe, type TaskDto } from '../lib/queries';
import { TaskRow } from './Tasks';
import { Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, Select, SkeletonList, SourceChip } from '../ui';

export default function ProjectDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api<{ project: { id: string; name: string; description: string; color: string; status: string }; tasks: (Task & { connectionId: string | null })[]; related: Item[] }>(`/api/projects/${id}`) });
  const update = useApiMutation((status: string) => api(`/api/projects/${id}`, { method: 'PATCH', body: { status } }), [['project', id], ['projects']]);
  const del = useApiMutation(() => api(`/api/projects/${id}`, { method: 'DELETE' }), [['projects']]);
  if (q.isLoading) return <SkeletonList rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { project, tasks, related } = q.data!;
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/projects" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" /> Projects
        </Link>
        <PageHeader
          title={
            <span className="inline-flex items-center gap-3">
              <span className="size-3 rounded-full" style={{ background: project.color }} />
              {project.name}
            </span>
          }
          subtitle={project.description || undefined}
          actions={
            <>
              <Select value={project.status} onChange={(e) => update.mutate(e.target.value)} aria-label="Project status" className="w-32">
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="done">Done</option>
              </Select>
              <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={async () => { await del.mutateAsync(undefined); nav('/projects'); }}>
                Delete
              </Button>
            </>
          }
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader title="Tasks" subtitle={`${open.length} open · ${done.length} done`} />
          {!tasks.length ? (
            <EmptyState title="No tasks in this project" body="Open a task and choose this project to add it." className="pt-2" />
          ) : (
            <ul>
              {[...open, ...done].map((t) => (
                <TaskRow key={t.id} t={{ ...(t as TaskDto), sourceItem: null }} tz={tz} onOpen={() => nav(`/tasks?open=${t.id}`)} />
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Related conversations" subtitle="Recent emails and messages that mention this project" />
          {!related.length ? (
            <EmptyState title="Nothing found" body="Messages that mention the project name will appear here." className="pt-2" />
          ) : (
            <ul>
              {related.map((r) => (
                <li key={r.id} className="flex items-start gap-2.5 border-t border-line px-5 py-3 first:border-t-0">
                  {r.kind === 'email' ? <Mail className="mt-0.5 size-4 text-muted" /> : <MessageSquare className="mt-0.5 size-4 text-muted" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">{r.title}</div>
                    <div className="text-[11.5px] text-faint">{fmtRelative(r.occurredAt)}</div>
                  </div>
                  <SourceChip source={r.source} url={r.url} label="" />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
