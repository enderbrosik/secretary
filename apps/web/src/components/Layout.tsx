import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import * as Popover from '@radix-ui/react-popover';
import { Bell, CalendarDays, CheckSquare, FolderKanban, Inbox, Menu, MessageSquareText, NotebookPen, Plus, Search, Settings, ShieldCheck, Sun, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { setTrayBadge, showSystemNotification } from '../lib/platform';
import { useActions, useMe, useNotifications } from '../lib/queries';
import { Avatar, Banner, Button, cn, IconButton, Kbd } from '../ui';
import { ApprovalsDialog } from './Approvals';
import { CommandPalette } from './CommandPalette';
import { QuickAddDialog } from './QuickAdd';
import { initials } from '../lib/format';

const NAV = [
  { to: '/', label: 'Today', icon: Sun, key: 't' },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare, key: 'k' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, key: 'c' },
  { to: '/inbox', label: 'Inbox', icon: Inbox, key: 'i' },
  { to: '/reviews', label: 'Reviews', icon: NotebookPen, key: 'r' },
  { to: '/projects', label: 'Projects', icon: FolderKanban, key: 'p' },
  { to: '/assistant', label: 'Assistant', icon: MessageSquareText, key: 'a' },
  { to: '/settings/general', label: 'Settings', icon: Settings, key: 's' },
];

export function Layout() {
  const me = useMe();
  const nav = useNavigate();
  const loc = useLocation();
  const [palette, setPalette] = useState(false);
  const [quickAdd, setQuickAdd] = useState(false);
  const [approvals, setApprovals] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const pending = useActions('pending');
  const pendingCount = pending.data?.length ?? 0;

  useEffect(() => setDrawer(false), [loc.pathname]);

  // Global keyboard shortcuts: ⌘K palette, "c" quick add, "g" + letter navigation.
  useEffect(() => {
    let g = false;
    let timer: ReturnType<typeof setTimeout>;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (g) {
        const hit = NAV.find((n) => n.key === e.key.toLowerCase());
        g = false;
        if (hit) {
          e.preventDefault();
          nav(hit.to);
        }
        return;
      }
      if (e.key === 'g') {
        g = true;
        clearTimeout(timer);
        timer = setTimeout(() => (g = false), 1200);
      } else if (e.key === 'n' || e.key === 'q') {
        e.preventDefault();
        setQuickAdd(true);
      } else if (e.key === '/') {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav]);

  const user = me.data?.user;
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr]">
      {/* Sidebar (desktop) */}
      <aside className="hidden lg:flex sticky top-0 h-screen flex-col border-r border-line bg-bg-subtle/60 px-3 py-4">
        <SidebarContent pendingCount={pendingCount} onPalette={() => setPalette(true)} onQuickAdd={() => setQuickAdd(true)} onApprovals={() => setApprovals(true)} userName={user?.displayName ?? ''} email={user?.email ?? ''} />
      </aside>

      {/* Top bar (mobile/tablet) */}
      <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-line bg-bg/90 backdrop-blur px-3 h-14 pt-safe">
        <IconButton label="Open navigation" onClick={() => setDrawer(true)}>
          <Menu className="size-5" />
        </IconButton>
        <span className="font-display text-[19px]">Secretary</span>
        <div className="flex items-center">
          <NotificationsButton />
          <IconButton label="Add task" onClick={() => setQuickAdd(true)}>
            <Plus className="size-5" />
          </IconButton>
        </div>
      </header>
      <AnimatePresence>
        {drawer && (
          <motion.div className="lg:hidden fixed inset-0 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/30" onClick={() => setDrawer(false)} />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'tween', duration: 0.18 }}
              className="absolute inset-y-0 left-0 w-[260px] flex flex-col bg-bg border-r border-line px-3 py-4 pt-safe"
            >
              <div className="flex justify-end -mt-1 mb-1">
                <IconButton label="Close navigation" size="sm" onClick={() => setDrawer(false)}>
                  <X className="size-4" />
                </IconButton>
              </div>
              <SidebarContent pendingCount={pendingCount} onPalette={() => setPalette(true)} onQuickAdd={() => setQuickAdd(true)} onApprovals={() => setApprovals(true)} userName={user?.displayName ?? ''} email={user?.email ?? ''} />
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="min-w-0">
        <div className="mx-auto w-full max-w-[1180px] px-4 sm:px-6 lg:px-10 py-6 lg:py-9 pb-safe">
          {me.data?.demoMode && (
            <div className="mb-5">
              <Banner tone="warn" title="Demo workspace" action={<Button size="sm" onClick={() => nav('/settings/integrations')}>Connect real accounts</Button>}>
                You’re viewing sample data. Nothing here comes from your real accounts, and nothing can be sent.
              </Banner>
            </div>
          )}
          <Outlet context={{ openQuickAdd: () => setQuickAdd(true), openApprovals: () => setApprovals(true) }} />
        </div>
      </main>

      <CommandPalette open={palette} onOpenChange={setPalette} onQuickAdd={() => setQuickAdd(true)} />
      <QuickAddDialog open={quickAdd} onOpenChange={setQuickAdd} />
      <ApprovalsDialog open={approvals} onOpenChange={setApprovals} />
      <NotificationBridge />
    </div>
  );
}

function SidebarContent({ pendingCount, onPalette, onQuickAdd, onApprovals, userName, email }: { pendingCount: number; onPalette: () => void; onQuickAdd: () => void; onApprovals: () => void; userName: string; email: string }) {
  const { pathname } = useLocation();
  return (
    <>
      <div className="flex items-center justify-between px-2 mb-4">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-6 rounded-md" />
          <span className="font-display text-[20px] tracking-[-0.01em]">Secretary</span>
        </div>
        <div className="hidden lg:block">
          <NotificationsButton />
        </div>
      </div>
      <button onClick={onPalette} className="mx-1 mb-2 flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-faint hover:border-line-strong hover:text-muted shadow-card">
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search or jump to…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <button onClick={onQuickAdd} className="mx-1 mb-4 flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium text-accent-text hover:bg-accent-soft">
        <Plus className="size-4" />
        New task
        <span className="ml-auto">
          <Kbd>N</Kbd>
        </span>
      </button>
      <nav className="flex flex-col gap-0.5" aria-label="Main">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              cn(
                'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
                isActive || (n.to.startsWith('/settings') && pathname.startsWith('/settings')) ? 'bg-surface text-ink font-medium shadow-card' : 'text-ink-2 hover:bg-surface/70 hover:text-ink',
              )
            }
          >
            <n.icon className="size-4 text-muted group-hover:text-ink" />
            {n.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-2 pt-4">
        {pendingCount > 0 && (
          <button onClick={onApprovals} className="mx-1 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-2.5 py-2 text-left text-[12.5px] text-accent-text">
            <ShieldCheck className="size-4 shrink-0" />
            <span className="flex-1">
              {pendingCount} action{pendingCount > 1 ? 's' : ''} awaiting your approval
            </span>
          </button>
        )}
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <Avatar label={initials(userName)} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{userName}</div>
            <div className="truncate text-[11.5px] text-faint">{email}</div>
          </div>
        </div>
      </div>
    </>
  );
}

function NotificationsButton() {
  const n = useNotifications();
  const nav = useNavigate();
  const unread = n.data?.notifications.filter((x) => !x.readAt).length ?? 0;
  const markAll = async () => {
    await api('/api/notifications/read-all', { method: 'POST', body: {} });
    await n.refetch();
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label={`Notifications${unread ? ` (${unread} unread)` : ''}`} className="relative">
          <Bell className="size-[18px]" />
          {unread > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent ring-2 ring-bg" />}
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-[340px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-[13px] font-semibold">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="text-[12px] text-accent-text hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[420px] overflow-y-auto scrollbar-thin">
            {!n.data?.notifications.length ? (
              <div className="px-4 py-8 text-center text-[13px] text-muted">You’re all caught up.</div>
            ) : (
              n.data.notifications.map((x) => (
                <button
                  key={x.id}
                  onClick={async () => {
                    await api(`/api/notifications/${x.id}/read`, { method: 'POST', body: {} });
                    void n.refetch();
                    if (x.link) nav(x.link);
                  }}
                  className={cn('flex w-full flex-col items-start gap-0.5 border-b border-line/70 px-4 py-2.5 text-left last:border-0 hover:bg-bg-subtle', !x.readAt && 'bg-accent-soft/40')}
                >
                  <span className="text-[13px] font-medium">{x.title}</span>
                  {x.body && <span className="text-[12.5px] text-muted line-clamp-2">{x.body}</span>}
                  <span className="text-[11.5px] text-faint">{fmtRelative(x.createdAt)}</span>
                </button>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Forwards new notifications to the OS (desktop) or browser, respecting the preview setting. */
function NotificationBridge() {
  const n = useNotifications();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const list = n.data?.notifications;
    if (!list) return;
    const unread = list.filter((x) => !x.readAt);
    void setTrayBadge(unread.length);
    if (!seen.current) {
      seen.current = new Set(list.map((x) => x.id));
      return;
    }
    for (const x of list) {
      if (seen.current.has(x.id)) continue;
      seen.current.add(x.id);
      if (n.data?.desktop && !x.readAt) void showSystemNotification(x.title, n.data.showPreviews ? x.body : undefined);
    }
  }, [n.data]);
  return null;
}

