import { useEffect, useMemo, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';
import { DateTime } from 'luxon';
import { CheckSquare, Clock, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { TASK_STATUSES, type TaskPriority, type TaskStatus } from '@secretary/core';
import { api, errorMessage } from '../lib/api';
import { fmtDue } from '../lib/format';
import { useApiMutation, useMe, useProjects, useTasks, type TaskDto } from '../lib/queries';
import { SuggestedTasks } from '../components/SuggestedTasks';
import { Badge, Button, Card, Checkbox, cn, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Segmented, Select, SkeletonList, SourceChip, Textarea } from '../ui';

const FILTERS = [
  { value: 'today', label: 'Today' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'waiting', label: 'Waiting / blocked' },
  { value: 'open', label: 'All open' },
  { value: 'completed', label: 'Completed' },
  { value: 'suggested', label: 'Suggested' },
] as const;

const STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', waiting: 'Waiting on someone', blocked: 'Blocked', done: 'Done', canceled: 'Canceled' };
const PRI_TONE = { urgent: 'danger', high: 'warn', medium: 'neutral', low: 'neutral' } as const;

export default function TasksPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('today');
  const [query, setQuery] = useState('');
  const q = useTasks(filter);
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const { openQuickAdd } = useOutletContext<{ openQuickAdd: () => void }>();
  const openId = params.get('open');
  const all = useTasks('all');
  const editing = openId ? all.data?.find((t) => t.id === openId) : undefined;

  const items = useMemo(() => (q.data ?? []).filter((t) => !query || t.title.toLowerCase().includes(query.toLowerCase())), [q.data, query]);

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle="Everything you’ve committed to — from this app and your connected task services."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={openQuickAdd}>
            New task
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Segmented value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ ...f }))} />
        <div className="relative md:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tasks" className="pl-8" aria-label="Filter tasks" />
        </div>
      </div>
      {filter === 'suggested' ? (
        <SuggestedTasks />
      ) : (
        <Card>
          {q.isLoading ? (
            <SkeletonList rows={6} />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : !items.length ? (
            <EmptyState
              icon={<CheckSquare className="size-5" />}
              title={filter === 'overdue' ? 'Nothing overdue' : filter === 'today' ? 'Nothing due today' : filter === 'completed' ? 'No completed tasks yet' : 'No tasks here'}
              body={filter === 'today' ? 'Tasks with a due date today will appear here.' : undefined}
              action={filter !== 'completed' ? <Button onClick={openQuickAdd}>Add a task</Button> : undefined}
            />
          ) : (
            <ul>
              {items.map((t) => (
                <TaskRow key={t.id} t={t} tz={tz} onOpen={() => setParams({ open: t.id })} />
              ))}
            </ul>
          )}
        </Card>
      )}
      {editing && <TaskEditor task={editing} allTasks={all.data ?? []} onClose={() => setParams({})} />}
    </div>
  );
}

export function TaskRow({ t, tz, onOpen }: { t: TaskDto; tz: string; onOpen: () => void }) {
  const toggle = useApiMutation((done: boolean) => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: done ? 'done' : 'todo' } }), [['tasks'], ['briefing']]);
  const due = fmtDue(t.dueAt, t.dueIsAllDay, tz);
  const overdue = t.dueAt && t.status !== 'done' && (t.dueIsAllDay ? DateTime.fromISO(t.dueAt).setZone(tz).endOf('day') : DateTime.fromISO(t.dueAt)) < DateTime.now();
  return (
    <li className="group flex items-start gap-3 border-t border-line px-5 py-3 first:border-t-0 hover:bg-surface-2">
      <Checkbox
        checked={t.status === 'done'}
        onCheckedChange={(v) =>
          toggle.mutate(v, {
            onSuccess: () => {
              if (v && t.canCompleteExternally)
                toast.success('Marked done', { action: { label: 'Also complete in source app', onClick: () => void api(`/api/tasks/${t.id}/complete-external`, { method: 'POST', body: {} }).then(() => toast.success('Completed in source app'), (e) => toast.error(errorMessage(e))) } });
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
        label={`Mark “${t.title}” ${t.status === 'done' ? 'not done' : 'done'}`}
        className="mt-0.5"
      />
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className={cn('text-[14px] leading-snug', t.status === 'done' && 'text-muted line-through')}>{t.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {due && (
            <Badge tone={overdue ? 'danger' : 'neutral'}>
              <Clock className="size-3" />
              {due}
            </Badge>
          )}
          {(t.priority === 'urgent' || t.priority === 'high') && <Badge tone={PRI_TONE[t.priority]}>{t.priority}</Badge>}
          {t.status !== 'todo' && t.status !== 'done' && <Badge tone={t.status === 'blocked' ? 'danger' : 'warn'}>{STATUS_LABEL[t.status]}{t.waitingOn ? `: ${t.waitingOn}` : ''}</Badge>}
          {t.origin === 'ai_suggested' && <Badge tone="accent" title="Detected by the assistant and confirmed by you">AI-detected</Badge>}
          {t.dependsOn.length > 0 && <Badge>Depends on {t.dependsOn.length}</Badge>}
          {t.estimateMinutes && <span className="text-[12px] text-faint">{t.estimateMinutes} min</span>}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {t.source !== 'internal' && <SourceChip source={t.source} url={t.sourceUrl} />}
        {t.sourceItem && <SourceChip source={t.sourceItem.source} url={t.sourceItem.url} label={t.sourceItem.kind === 'email' ? 'Email' : 'Message'} />}
      </div>
    </li>
  );
}

function TaskEditor({ task, allTasks, onClose }: { task: TaskDto; allTasks: TaskDto[]; onClose: () => void }) {
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const projects = useProjects();
  const [f, setF] = useState(() => toForm(task, tz));
  useEffect(() => setF(toForm(task, tz)), [task, tz]);
  const save = useApiMutation(
    () =>
      api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: {
          title: f.title,
          description: f.description,
          priority: f.priority,
          status: f.status,
          dueAt: f.due ? DateTime.fromISO(`${f.due}T${f.time || '00:00'}`, { zone: tz }).toISO() : null,
          dueIsAllDay: !!f.due && !f.time,
          estimateMinutes: f.estimate ? Number(f.estimate) : null,
          projectId: f.projectId || null,
          dependsOn: f.dependsOn,
          waitingOn: f.waitingOn || null,
          nextAction: f.nextAction || null,
          notes: f.notes,
        },
      }),
    [['tasks'], ['projects']],
  );
  const del = useApiMutation(() => api(`/api/tasks/${task.id}`, { method: 'DELETE' }), [['tasks']]);
  const synced = !!task.connectionId;
  const others = allTasks.filter((t) => t.id !== task.id && t.status !== 'done' && t.status !== 'canceled');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title="Edit task"
      description={synced ? `Synced from ${task.source}. Changes here stay in Secretary; edit the original to change it there.` : task.origin === 'ai_suggested' ? 'Detected by the assistant from a message.' : 'Created by you.'}
      wide
      footer={
        <>
          {!synced && (
            <Button variant="ghost" className="mr-auto text-danger" icon={<Trash2 className="size-4" />} onClick={async () => { await del.mutateAsync(undefined); onClose(); }}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync(undefined);
                toast.success('Task saved');
                onClose();
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" className="sm:col-span-2">{(id) => <Input id={id} value={f.title} onChange={(e) => set('title', e.target.value)} />}</Field>
        <Field label="Status">
          {(id) => (
            <Select id={id} value={f.status} onChange={(e) => set('status', e.target.value as TaskStatus)}>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Priority">
          {(id) => (
            <Select id={id} value={f.priority} onChange={(e) => set('priority', e.target.value as TaskPriority)}>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due date">{(id) => <Input id={id} type="date" value={f.due} onChange={(e) => set('due', e.target.value)} />}</Field>
          <Field label="Time">{(id) => <Input id={id} type="time" value={f.time} disabled={!f.due} onChange={(e) => set('time', e.target.value)} />}</Field>
        </div>
        <Field label="Estimate (minutes)">{(id) => <Input id={id} type="number" min={5} step={5} value={f.estimate} onChange={(e) => set('estimate', e.target.value)} />}</Field>
        {f.status === 'waiting' && <Field label="Waiting on" className="sm:col-span-2">{(id) => <Input id={id} value={f.waitingOn} onChange={(e) => set('waitingOn', e.target.value)} placeholder="Person or team" />}</Field>}
        <Field label="Next concrete action" className="sm:col-span-2">{(id) => <Input id={id} value={f.nextAction} onChange={(e) => set('nextAction', e.target.value)} placeholder="e.g. Email Dana the revised numbers" />}</Field>
        <Field label="Project">
          {(id) => (
            <Select id={id} value={f.projectId} onChange={(e) => set('projectId', e.target.value)}>
              <option value="">No project</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Depends on" hint="This task can’t start until these are done.">
          {(id) => (
            <Select
              id={id}
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v && !f.dependsOn.includes(v)) set('dependsOn', [...f.dependsOn, v]);
              }}
            >
              <option value="">Add a dependency…</option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {f.dependsOn.length > 0 && (
          <div className="flex flex-wrap gap-1.5 sm:col-span-2">
            {f.dependsOn.map((d) => (
              <button key={d} onClick={() => set('dependsOn', f.dependsOn.filter((x) => x !== d))} className="rounded-md border border-line px-2 py-0.5 text-[12px] hover:border-danger hover:text-danger">
                {allTasks.find((t) => t.id === d)?.title ?? 'Unknown task'} ×
              </button>
            ))}
          </div>
        )}
        <Field label="Description" className="sm:col-span-2">{(id) => <Textarea id={id} value={f.description} onChange={(e) => set('description', e.target.value)} />}</Field>
        <Field label="Your notes" className="sm:col-span-2">{(id) => <Textarea id={id} value={f.notes} onChange={(e) => set('notes', e.target.value)} />}</Field>
      </div>
      {(task.sourceUrl || task.sourceItem) && (
        <div className="mt-4 flex flex-wrap gap-3 text-[12.5px] text-muted">
          Source:
          {task.sourceUrl && <SourceChip source={task.source} url={task.sourceUrl} label="Open original task" />}
          {task.sourceItem && <SourceChip source={task.sourceItem.source} url={task.sourceItem.url} label={task.sourceItem.title} />}
        </div>
      )}
    </Dialog>
  );
}

function toForm(t: TaskDto, tz: string) {
  const d = t.dueAt ? DateTime.fromISO(t.dueAt).setZone(tz) : null;
  return {
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    due: d?.toISODate() ?? '',
    time: d && !t.dueIsAllDay ? d.toFormat('HH:mm') : '',
    estimate: t.estimateMinutes ? String(t.estimateMinutes) : '',
    projectId: t.projectId ?? '',
    dependsOn: t.dependsOn,
    waitingOn: t.waitingOn ?? '',
    nextAction: t.nextAction ?? '',
    notes: t.notes,
  };
}
