import { useState } from 'react';
import { DateTime } from 'luxon';
import { toast } from 'sonner';
import type { TaskPriority } from '@secretary/core';
import { api, errorMessage } from '../lib/api';
import { useApiMutation, useMe, useProjects } from '../lib/queries';
import { Button, Dialog, Field, Input, Select, Textarea } from '../ui';

export function QuickAddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const me = useMe();
  const projects = useProjects();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [time, setTime] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [estimate, setEstimate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [notes, setNotes] = useState('');
  const reset = () => {
    setTitle('');
    setDue('');
    setTime('');
    setPriority('medium');
    setEstimate('');
    setProjectId('');
    setNotes('');
  };
  const create = useApiMutation(
    () => {
      const dueAt = due ? DateTime.fromISO(`${due}T${time || '00:00'}`, { zone: tz }).toISO() : null;
      return api('/api/tasks', {
        method: 'POST',
        body: { title, priority, dueAt, dueIsAllDay: !!due && !time, estimateMinutes: estimate ? Number(estimate) : null, projectId: projectId || null, description: notes },
      });
    },
    [['tasks'], ['projects']],
  );
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await create.mutateAsync(undefined);
      toast.success('Task added');
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New task" description="Added to your task list as confirmed by you.">
      <form id="quick-add" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="What needs to be done?">{(id) => <Input id={id} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Send revised proposal to Lumen" maxLength={300} />}</Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Due date" className="col-span-1">{(id) => <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
          <Field label="Time" className="col-span-1">{(id) => <Input id={id} type="time" value={time} disabled={!due} onChange={(e) => setTime(e.target.value)} />}</Field>
          <Field label="Priority">
            {(id) => (
              <Select id={id} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
            )}
          </Field>
          <Field label="Estimate (min)">{(id) => <Input id={id} type="number" min={5} step={5} value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="30" />}</Field>
        </div>
        {!!projects.data?.length && (
          <Field label="Project">
            {(id) => (
              <Select id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {projects.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Notes">{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional details" />}</Field>
      </form>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" type="submit" form="quick-add" loading={create.isPending} disabled={!title.trim()}>
          Add task
        </Button>
      </div>
    </Dialog>
  );
}
