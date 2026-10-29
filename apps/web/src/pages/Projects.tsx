import { useState } from 'react';
import { useNavigate } from 'react-router';
import { FolderKanban, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useApiMutation, useProjects } from '../lib/queries';
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, SkeletonList, Textarea } from '../ui';

const COLORS = ['#2f4bb8', '#2f7a55', '#9a6114', '#b2382f', '#6b4fb8', '#3b6b8f'];

export default function ProjectsPage() {
  const q = useProjects();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const create = useApiMutation(() => api<{ id: string }>('/api/projects', { method: 'POST', body: { name, description, color } }), [['projects']]);
  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Group related tasks and see the conversations around them."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            New project
          </Button>
        }
      />
      {q.isLoading ? (
        <Card>
          <SkeletonList />
        </Card>
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : !q.data?.length ? (
        <Card>
          <EmptyState icon={<FolderKanban className="size-5" />} title="No projects yet" body="Create a project, then assign tasks to it from the task editor." action={<Button onClick={() => setOpen(true)}>Create a project</Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.map((p) => {
            const pct = p.stats.total ? Math.round((p.stats.done / p.stats.total) * 100) : 0;
            return (
              <button key={p.id} onClick={() => nav(`/projects/${p.id}`)} className="text-left">
                <Card className="h-full p-5 transition-colors hover:border-line-strong">
                  <div className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full" style={{ background: p.color }} />
                    <span className="text-[14.5px] font-semibold">{p.name}</span>
                    {p.status !== 'active' && <Badge>{p.status}</Badge>}
                  </div>
                  {p.description && <p className="mt-1.5 text-[13px] text-muted line-clamp-2">{p.description}</p>}
                  <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-bg-subtle">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: p.color }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[12px] text-muted">
                    <span>
                      {p.stats.done} of {p.stats.total} tasks done
                    </span>
                    {p.stats.overdue > 0 && <Badge tone="danger">{p.stats.overdue} overdue</Badge>}
                  </div>
                </Card>
              </button>
            );
          })}
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New project"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              loading={create.isPending}
              onClick={async () => {
                try {
                  const p = await create.mutateAsync(undefined);
                  setOpen(false);
                  setName('');
                  setDescription('');
                  nav(`/projects/${p.id}`);
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
          <Field label="Description" hint="Used to find related emails and messages.">{(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <div className="flex gap-2" role="radiogroup" aria-label="Color">
            {COLORS.map((c) => (
              <button key={c} role="radio" aria-checked={c === color} aria-label={c} onClick={() => setColor(c)} className="size-7 rounded-full ring-offset-2 ring-offset-surface aria-checked:ring-2 aria-checked:ring-ink" style={{ background: c }} />
            ))}
          </div>
        </div>
      </Dialog>
    </div>
  );
}
