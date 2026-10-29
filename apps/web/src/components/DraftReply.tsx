import { useState } from 'react';
import { Link } from 'react-router';
import { Mail, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useApiMutation, useIntegrations, type PendingAction } from '../lib/queries';
import { Banner, Button, Dialog, Field, Input, ProvenanceBadge, Textarea } from '../ui';
import { ActionCard } from './Approvals';

interface Draft {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  notes: string | null;
  connectionId: string;
  itemId: string;
}

/**
 * Draft → review/edit → choose "save draft" or "send" → explicit approval.
 * The AI never sends anything itself.
 */
export function DraftReplyDialog({ open, onOpenChange, itemId, connectionId, defaultTo, subject }: { open: boolean; onOpenChange: (v: boolean) => void; itemId: string; connectionId: string; defaultTo: string[]; subject: string }) {
  const integ = useIntegrations();
  const conn = integ.data?.connections.find((c) => c.id === connectionId);
  const [instructions, setInstructions] = useState('');
  const [draft, setDraft] = useState<Draft>({ to: defaultTo, cc: [], subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, body: '', notes: null, connectionId, itemId });
  const [aiUsed, setAiUsed] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const gen = useApiMutation(() => api<Draft>('/api/assistant/draft-reply', { method: 'POST', body: { itemId, instructions } }));
  const create = useApiMutation((type: 'create_draft' | 'send_email') =>
    api<PendingAction>('/api/actions', { method: 'POST', body: { type, connectionId, origin: 'user', payload: { itemId, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body } } }),
  [['actions']]);

  const tier = conn?.tier ?? 'read';
  const isDemo = conn?.provider === 'demo';
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Reply" description="Write or generate a reply. You review everything before it leaves Secretary." wide>
      {pending ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted">One more step — approve to {pending.type === 'send_email' ? 'send this email' : 'save this draft in your mailbox'}.</p>
          <ActionCard action={pending} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3 sm:flex-row sm:items-end">
            <Field label="What should the reply say?" className="flex-1">
              {(id) => <Input id={id} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Accept the annual option and ask for the contract" />}
            </Field>
            <Button
              icon={<Sparkles className="size-4" />}
              loading={gen.isPending}
              onClick={async () => {
                try {
                  const d = await gen.mutateAsync(undefined);
                  setDraft((cur) => ({ ...cur, subject: d.subject || cur.subject, body: d.body, notes: d.notes, to: d.to.length ? d.to : cur.to }));
                  setAiUsed(true);
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Draft with AI
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="To">{(id) => <Input id={id} value={draft.to.join(', ')} onChange={(e) => setDraft({ ...draft, to: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />}</Field>
            <Field label="Subject">{(id) => <Input id={id} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />}</Field>
          </div>
          <Field label={<span className="inline-flex items-center gap-2">Message {aiUsed && <ProvenanceBadge kind="suggestion" />}</span>}>
            {(id) => <Textarea id={id} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} className="min-h-[200px]" />}
          </Field>
          {draft.notes && <Banner tone="warn" title="Check before sending">{draft.notes}</Banner>}
          {isDemo ? (
            <Banner tone="warn">This is demo data. Replies can be written but not saved or sent.</Banner>
          ) : tier === 'read' ? (
            <Banner tone="info">
              This account is connected read-only. To save drafts or send, change its permissions in <Link to="/settings/integrations" className="underline">Integrations</Link>. You can still copy this text.
            </Banner>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(draft.body).then(() => toast.success('Copied'))} disabled={!draft.body}>
              Copy text
            </Button>
            <Button
              icon={<Mail className="size-4" />}
              disabled={isDemo || tier === 'read' || !draft.body || !draft.to.length}
              loading={create.isPending && create.variables === 'create_draft'}
              onClick={async () => {
                try {
                  setPending(await create.mutateAsync('create_draft'));
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Save as draft
            </Button>
            <Button
              variant="primary"
              icon={<Send className="size-4" />}
              disabled={isDemo || tier !== 'write' || !draft.body || !draft.to.length}
              title={tier !== 'write' ? 'Sending requires the “Send & make changes” permission' : undefined}
              loading={create.isPending && create.variables === 'send_email'}
              onClick={async () => {
                try {
                  setPending(await create.mutateAsync('send_email'));
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Send…
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
