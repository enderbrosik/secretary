import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Inbox as InboxIcon, ListPlus, Mail, MessageSquare, Reply } from 'lucide-react';
import { EMAIL_CATEGORIES, EMAIL_CATEGORY_LABELS, type EmailItem, type MessageItem } from '@secretary/core';
import { api, errorMessage } from '../lib/api';
import { fmtDateTime, fmtRelative, initials } from '../lib/format';
import { useApiMutation, useInbox, useIntegrations, useMe, type InboxEntry } from '../lib/queries';
import { DraftReplyDialog } from '../components/DraftReply';
import { useMediaQuery } from '../lib/useMedia';
import { Avatar, Badge, Banner, Button, Card, cn, Dialog, EmptyState, ErrorState, PageHeader, ProvenanceBadge, Segmented, SkeletonList, SourceChip, type Tone } from '../ui';

const CAT_TONE: Record<string, Tone> = { urgent: 'danger', needs_reply: 'accent', waiting_for_me: 'warn', informational: 'neutral', can_wait: 'neutral' };

export default function InboxPage() {
  const [kind, setKind] = useState<'all' | 'email' | 'message'>('all');
  const [cat, setCat] = useState<string>('attention');
  const [selected, setSelected] = useState<string | null>(null);
  const q = useInbox(kind);
  const integ = useIntegrations();
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  const connected = integ.data?.connections.some((c) => c.features.email || c.features.messages);
  const wide = useMediaQuery('(min-width: 1024px)');

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of q.data ?? []) c[e.category] = (c[e.category] ?? 0) + 1;
    return c;
  }, [q.data]);
  const list = (q.data ?? []).filter((e) => (cat === 'all' ? true : cat === 'attention' ? ['urgent', 'needs_reply', 'waiting_for_me'].includes(e.category) : e.category === cat));
  const current = list.find((e) => e.item.id === selected) ?? null;

  return (
    <div>
      <PageHeader title="Inbox" subtitle="What needs you across email and chat, sorted by how much it matters — not by when it arrived." />
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Segmented
          value={cat}
          onChange={setCat}
          options={[
            { value: 'attention', label: 'Needs attention', count: (counts.urgent ?? 0) + (counts.needs_reply ?? 0) + (counts.waiting_for_me ?? 0) },
            ...EMAIL_CATEGORIES.map((c) => ({ value: c, label: EMAIL_CATEGORY_LABELS[c], count: counts[c] ?? 0 })),
            { value: 'all', label: 'All' },
          ]}
        />
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'All' },
            { value: 'email', label: 'Email' },
            { value: 'message', label: 'Chat' },
          ]}
        />
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card className="overflow-hidden">
          {q.isLoading ? (
            <SkeletonList rows={7} />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : !connected ? (
            <EmptyState icon={<InboxIcon className="size-5" />} title="No email or chat connected" body="Connect Gmail, Outlook or Slack in Settings → Integrations." />
          ) : !list.length ? (
            <EmptyState icon={<InboxIcon className="size-5" />} title="Nothing in this view" body="You’re on top of it." />
          ) : (
            <ul className="max-h-[calc(100vh-260px)] overflow-y-auto scrollbar-thin">
              {list.map((e) => (
                <Row key={e.item.id} e={e} active={selected === e.item.id} onClick={() => setSelected(e.item.id)} />
              ))}
            </ul>
          )}
        </Card>
        <div className="hidden lg:block">
          {current ? (
            <Detail e={current} tz={tz} />
          ) : (
            <Card>
              <EmptyState title="Select a message" body="See the full text, why it matters, and reply or turn it into a task." />
            </Card>
          )}
        </div>
      </div>
      {/* Mobile detail (portal-based dialog, so gate it in JS rather than with CSS) */}
      <div>
        {current && !wide && (
          <Dialog open onOpenChange={(v) => !v && setSelected(null)} title={current.item.title} wide>
            <Detail e={current} tz={tz} bare />
          </Dialog>
        )}
      </div>
    </div>
  );
}

function who(e: InboxEntry) {
  if (e.item.kind === 'email') {
    const d = (e.item as EmailItem).data;
    return d.from.name ?? d.from.email ?? 'Unknown';
  }
  const d = (e.item as MessageItem).data;
  return d.author.name ?? d.author.id;
}

function Row({ e, active, onClick }: { e: InboxEntry; active: boolean; onClick: () => void }) {
  const isEmail = e.item.kind === 'email';
  const unread = isEmail && (e.item as EmailItem).data.isUnread;
  return (
    <li>
      <button onClick={onClick} className={cn('flex w-full gap-3 border-t border-line px-4 py-3 text-left first:border-t-0 hover:bg-surface-2', active && 'bg-accent-soft/50 hover:bg-accent-soft/50')}>
        <Avatar label={initials(who(e))} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('truncate text-[13.5px]', unread ? 'font-semibold' : 'font-medium')}>{who(e)}</span>
            {isEmail ? <Mail className="size-3 shrink-0 text-faint" /> : <MessageSquare className="size-3 shrink-0 text-faint" />}
            <span className="ml-auto shrink-0 text-[11.5px] text-faint">{fmtRelative(e.item.occurredAt)}</span>
          </div>
          <div className="truncate text-[13px] text-ink">{isEmail ? e.item.title : (e.item as MessageItem).data.channelName ? `#${(e.item as MessageItem).data.channelName}` : 'Direct message'}</div>
          <div className="truncate text-[12.5px] text-muted">{e.summary ?? (isEmail ? (e.item as EmailItem).data.snippet : (e.item as MessageItem).data.text)}</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Badge tone={CAT_TONE[e.category]}>{EMAIL_CATEGORY_LABELS[e.category as keyof typeof EMAIL_CATEGORY_LABELS]}</Badge>
            {e.unansweredDays !== null && e.unansweredDays >= 2 && <Badge tone="warn">No reply for {e.unansweredDays}d</Badge>}
          </div>
        </div>
      </button>
    </li>
  );
}

function Detail({ e, tz, bare }: { e: InboxEntry; tz: string; bare?: boolean }) {
  const [reply, setReply] = useState(false);
  const integ = useIntegrations();
  const conn = integ.data?.connections.find((c) => c.id === e.item.connectionId);
  const toTask = useApiMutation(
    () => api('/api/tasks', { method: 'POST', body: { title: e.item.kind === 'email' ? `Reply: ${e.item.title}` : `Follow up with ${who(e)}`, sourceItemId: e.item.id } }),
    [['tasks']],
  );
  const isEmail = e.item.kind === 'email';
  const ed = isEmail ? (e.item as EmailItem).data : null;
  const md = !isEmail ? (e.item as MessageItem).data : null;
  const body = ed ? ed.bodyText || ed.snippet : md!.text;
  const content = (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Avatar label={initials(who(e))} className="size-9 text-[12px]" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{who(e)}</div>
          <div className="text-[12.5px] text-muted">
            {ed ? ed.from.email : md!.channelName ? `#${md!.channelName}` : 'Direct message'} · {fmtDateTime(e.item.occurredAt, tz)}
          </div>
        </div>
        <SourceChip source={e.item.source} url={e.item.url} label={e.item.source === 'demo' ? 'Demo record' : 'Open original'} />
      </div>
      {!bare && isEmail && <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{e.item.title}</h2>}
      {(e.summary || e.reasons.length > 0) && (
        <div className="rounded-xl bg-bg-subtle p-3.5 text-[13px]">
          {e.summary && (
            <p className="flex flex-wrap items-center gap-1.5 text-ink-2">
              {e.summary} <ProvenanceBadge kind="inference" />
            </p>
          )}
          {e.whyItMatters && <p className="mt-1 text-ink-2"><span className="font-medium text-ink">Why it matters:</span> {e.whyItMatters}</p>}
          {e.reasons.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {e.reasons.map((r) => (
                <Badge key={r}>{r}</Badge>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{body || <span className="text-faint">No preview available.</span>}</div>
      {ed && !ed.bodyText && <p className="text-[12px] text-faint">Only the preview is stored. Full message bodies can be enabled in Settings → AI → Privacy.</p>}
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {isEmail && conn && (
          <Button variant="primary" icon={<Reply className="size-4" />} onClick={() => setReply(true)}>
            Reply
          </Button>
        )}
        <Button
          icon={<ListPlus className="size-4" />}
          loading={toTask.isPending}
          onClick={async () => {
            try {
              await toTask.mutateAsync(undefined);
              toast.success('Task created and linked to this message');
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          Create task
        </Button>
      </div>
      {!isEmail && <Banner tone="neutral">Secretary has read-only access to Slack and can’t post replies. Open the message in Slack to respond.</Banner>}
      {reply && ed && <DraftReplyDialog open={reply} onOpenChange={setReply} itemId={e.item.id} connectionId={e.item.connectionId!} defaultTo={ed.from.email ? [ed.from.email] : []} subject={e.item.title} />}
    </div>
  );
  return bare ? content : <Card className="p-5">{content}</Card>;
}
