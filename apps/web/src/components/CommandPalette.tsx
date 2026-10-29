import { Command } from 'cmdk';
import { useNavigate } from 'react-router';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { CalendarDays, CheckSquare, FolderKanban, Inbox, MessageSquareText, NotebookPen, Plus, RefreshCw, Settings, Sun } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useTasks } from '../lib/queries';
import { Kbd } from '../ui';

const PAGES = [
  { label: 'Today', to: '/', icon: Sun, hint: 'G T' },
  { label: 'Tasks', to: '/tasks', icon: CheckSquare, hint: 'G K' },
  { label: 'Calendar', to: '/calendar', icon: CalendarDays, hint: 'G C' },
  { label: 'Inbox', to: '/inbox', icon: Inbox, hint: 'G I' },
  { label: 'Reviews', to: '/reviews', icon: NotebookPen, hint: 'G R' },
  { label: 'Projects', to: '/projects', icon: FolderKanban, hint: 'G P' },
  { label: 'Assistant', to: '/assistant', icon: MessageSquareText, hint: 'G A' },
  { label: 'Settings', to: '/settings/general', icon: Settings, hint: 'G S' },
  { label: 'AI provider settings', to: '/settings/ai', icon: Settings },
  { label: 'Connected accounts', to: '/settings/integrations', icon: Settings },
];

export function CommandPalette({ open, onOpenChange, onQuickAdd }: { open: boolean; onOpenChange: (v: boolean) => void; onQuickAdd: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const tasks = useTasks('open');
  const go = (to: string) => {
    onOpenChange(false);
    nav(to);
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-24px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Search pages, tasks and actions</DialogPrimitive.Description>
          <Command label="Command palette" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint">
            <Command.Input autoFocus placeholder="Type a command or search tasks…" className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] outline-none placeholder:text-faint" />
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5 scrollbar-thin">
              <Command.Empty className="px-4 py-6 text-center text-[13px] text-muted">No results.</Command.Empty>
              <Command.Group heading="Actions">
                <Item onSelect={() => { onOpenChange(false); onQuickAdd(); }} icon={<Plus className="size-4" />} hint="N">New task</Item>
                <Item
                  onSelect={async () => {
                    onOpenChange(false);
                    const id = toast.loading('Preparing your briefing…');
                    try {
                      await api('/api/briefings/generate', { method: 'POST', body: {} });
                      await qc.invalidateQueries({ queryKey: ['briefing'] });
                      toast.success('Briefing updated', { id });
                      nav('/');
                    } catch (e) {
                      toast.error(errorMessage(e), { id });
                    }
                  }}
                  icon={<RefreshCw className="size-4" />}
                >
                  Refresh today’s briefing
                </Item>
                <Item onSelect={() => go('/assistant')} icon={<MessageSquareText className="size-4" />}>Ask the assistant</Item>
              </Command.Group>
              <Command.Group heading="Go to">
                {PAGES.map((p) => (
                  <Item key={p.to} onSelect={() => go(p.to)} icon={<p.icon className="size-4" />} hint={p.hint}>
                    {p.label}
                  </Item>
                ))}
              </Command.Group>
              {!!tasks.data?.length && (
                <Command.Group heading="Tasks">
                  {tasks.data.slice(0, 50).map((t) => (
                    <Item key={t.id} value={`task ${t.title}`} onSelect={() => go(`/tasks?open=${t.id}`)} icon={<CheckSquare className="size-4" />}>
                      {t.title}
                    </Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Item({ children, onSelect, icon, hint, value }: { children: React.ReactNode; onSelect: () => void; icon: React.ReactNode; hint?: string; value?: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-ink-2 data-[selected=true]:bg-bg-subtle data-[selected=true]:text-ink">
      <span className="text-muted">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {hint && <Kbd>{hint}</Kbd>}
    </Command.Item>
  );
}
