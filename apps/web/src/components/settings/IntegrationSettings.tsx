import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, CheckSquare, Mail, MessageSquare, RefreshCw, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../../lib/api';
import { fmtRelative } from '../../lib/format';
import { isDesktop, openExternal } from '../../lib/platform';
import { useApiMutation, useIntegrations, type Connection, type ProviderInfo } from '../../lib/queries';
import { Badge, Banner, Button, Card, CardHeader, Checkbox, Dialog, Spinner, type Tone } from '../../ui';
import { ProviderSetupDialog } from './ProviderSetup';

type Tier = 'read' | 'draft' | 'write';
const TIER_LABEL: Record<Tier, string> = { read: 'Read only', draft: 'Read + drafts', write: 'Send & make changes' };
const TIER_HELP: Record<Tier, string> = {
  read: 'Secretary can read and summarize. It cannot create or change anything.',
  draft: 'Secretary can also save reply drafts in your mailbox — after you approve each one.',
  write: 'Secretary can also send emails, add calendar events and complete tasks — only after you approve each action.',
};
const FEATURE: { key: keyof Connection['features']; label: string; icon: React.ReactNode }[] = [
  { key: 'calendar', label: 'Calendar', icon: <CalendarDays className="size-4" /> },
  { key: 'email', label: 'Email', icon: <Mail className="size-4" /> },
  { key: 'messages', label: 'Messages', icon: <MessageSquare className="size-4" /> },
  { key: 'tasks', label: 'Tasks', icon: <CheckSquare className="size-4" /> },
];

export function IntegrationSettings({ compact }: { compact?: boolean }) {
  const q = useIntegrations();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const [connecting, setConnecting] = useState<ProviderInfo | null>(null);
  const [settingUp, setSettingUp] = useState<ProviderInfo | null>(null);

  useEffect(() => {
    const ok = params.get('connected');
    const err = params.get('error');
    if (ok) toast.success('Account connected. The first sync is running.');
    if (err) toast.error(err);
    if (ok || err) {
      params.delete('connected');
      params.delete('error');
      setParams(params, { replace: true });
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    }
  }, [params, setParams, qc]);

  // While a desktop OAuth flow is open in the browser, poll for the new connection.
  useEffect(() => {
    if (!isDesktop) return;
    const t = setInterval(() => void q.refetch(), 4000);
    return () => clearInterval(t);
  }, [q]);

  if (q.isLoading) return <Spinner />;
  if (!q.data) return null;
  const real = q.data.providers.filter((p) => p.provider !== 'demo');
  const demoProvider = q.data.providers.find((p) => p.provider === 'demo');
  const demoConn = q.data.connections.find((c) => c.provider === 'demo');
  return (
    <div className="flex flex-col gap-5">
      {q.data.connections.filter((c) => c.provider !== 'demo').map((c) => (
        <ConnectionCard key={c.id} c={c} />
      ))}
      <Card>
        <CardHeader title={compact ? 'Connect your accounts' : 'Add an account'} subtitle="Official sign-in with each provider. You choose what Secretary can access." />
        <ul className="grid gap-3 px-5 pb-5 sm:grid-cols-2">
          {real.map((p) => (
            <li key={p.provider} className="flex flex-col rounded-xl border border-line p-4">
              <div className="text-[14px] font-semibold">{p.name}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {FEATURE.filter((f) => p.supports[f.key]).map((f) => (
                  <Badge key={f.key}>
                    {f.icon}
                    {f.label}
                  </Badge>
                ))}
              </div>
              <div className="mt-auto pt-3">
                {p.tokenConnect ? (
                  <Button size="sm" onClick={() => setSettingUp(p)}>
                    Connect
                  </Button>
                ) : p.configured ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => setConnecting(p)}>
                      Connect
                    </Button>
                    {p.appSource === 'app' && (
                      <button className="text-[12px] text-faint hover:text-muted" onClick={() => setSettingUp(p)}>
                        Change app settings
                      </button>
                    )}
                  </div>
                ) : p.canConfigureApp ? (
                  <div className="flex flex-col items-start gap-1.5">
                    <Button size="sm" onClick={() => setSettingUp(p)}>
                      Set up
                    </Button>
                    <span className="text-[12px] text-muted">One-time, about 5–10 minutes.</span>
                  </div>
                ) : isDesktop ? (
                  <p className="text-[12.5px] text-muted">Coming soon</p>
                ) : (
                  <div className="text-[12.5px] text-muted">
                    <p>Not available on this server yet — it needs {p.name.split(' ')[0]} app credentials.</p>
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[12px] text-faint hover:text-muted">Setup details for administrators</summary>
                      <p className="mt-1 text-[12px]">
                        Follow <code>{p.setupDoc}</code> and register this redirect URI: <code className="break-all text-[11.5px]">{p.redirectUri}</code>
                      </p>
                    </details>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      {demoProvider?.configured && (
        <Card>
          <CardHeader title="Demo workspace" subtitle="Try Secretary with realistic sample data. Clearly labelled, never mixed with real accounts, and nothing can be sent." />
          <div className="px-5 pb-5">
            {demoConn ? <ConnectionActions c={demoConn} /> : <DemoButton />}
          </div>
        </Card>
      )}
      {connecting && <ConnectDialog provider={connecting} onClose={() => setConnecting(null)} />}
      {settingUp && (
        <ProviderSetupDialog
          provider={settingUp}
          onClose={() => setSettingUp(null)}
          onReady={() => {
            const p = settingUp;
            setSettingUp(null);
            setConnecting({ ...p, configured: true });
          }}
        />
      )}
    </div>
  );
}

function DemoButton() {
  const enable = useApiMutation(() => api('/api/integrations/demo/connect', { method: 'POST', body: { features: { calendar: true, email: true, messages: true, tasks: true } } }), [['integrations'], ['me'], ['tasks'], ['briefing']]);
  return (
    <Button loading={enable.isPending} onClick={() => enable.mutate(undefined, { onSuccess: () => toast.success('Demo data loaded'), onError: (e) => toast.error(errorMessage(e)) })}>
      Load sample data
    </Button>
  );
}

function ConnectDialog({ provider, onClose }: { provider: ProviderInfo; onClose: () => void }) {
  const [features, setFeatures] = useState({ ...provider.supports });
  const [tier, setTier] = useState<Tier>('read');
  const [preview, setPreview] = useState<{ scopes: string[]; descriptions: { scope: string; why: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const writable = provider.supports.email || provider.supports.calendar || provider.supports.tasks;
  useEffect(() => {
    void api<typeof preview>(`/api/integrations/${provider.provider}/preview`, { method: 'POST', body: { features, tier } }).then(setPreview, () => setPreview(null));
  }, [features, tier, provider.provider]);
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Connect ${provider.name}`}
      description="You’ll sign in on the provider’s own page. Secretary never sees your password."
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!Object.values(features).some(Boolean)}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ authUrl: string }>(`/api/integrations/${provider.provider}/connect`, { method: 'POST', body: { features, tier, client: isDesktop ? 'desktop' : 'web' } });
                if (isDesktop) {
                  await openExternal(r.authUrl);
                  toast.info('Finish signing in in your browser, then return here.');
                  onClose();
                } else window.location.assign(r.authUrl);
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Continue to {provider.name.split(' ')[0]}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div>
          <div className="mb-2 text-[12.5px] font-medium text-ink-2">What should Secretary use?</div>
          <div className="flex flex-wrap gap-4">
            {FEATURE.filter((f) => provider.supports[f.key]).map((f) => (
              <label key={f.key} className="inline-flex items-center gap-2 text-[13.5px]">
                <Checkbox checked={features[f.key]} onCheckedChange={(v) => setFeatures((s) => ({ ...s, [f.key]: v }))} label={f.label} />
                {f.label}
              </label>
            ))}
          </div>
        </div>
        {writable && provider.provider !== 'slack' && (
          <div>
            <div className="mb-2 text-[12.5px] font-medium text-ink-2">Permission level</div>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
              {(['read', 'draft', 'write'] as const)
                .filter((t) => (provider.provider === 'todoist' ? t !== 'draft' : true))
                .map((t) => (
                  <button key={t} role="radio" aria-checked={tier === t} onClick={() => setTier(t)} className={`rounded-xl border p-3 text-left ${tier === t ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong'}`}>
                    <div className="text-[13px] font-semibold">{TIER_LABEL[t]}</div>
                    <div className="mt-0.5 text-[12px] text-muted">{TIER_HELP[t]}</div>
                  </button>
                ))}
            </div>
          </div>
        )}
        {preview && (
          <div className="rounded-xl bg-bg-subtle p-4">
            <div className="mb-2 text-[12.5px] font-medium text-ink-2">Permissions that will be requested</div>
            <ul className="space-y-1.5 text-[13px]">
              {preview.descriptions.map((d) => (
                <li key={d.scope}>
                  <code className="text-[12px] text-accent-text">{d.scope}</code> — {d.why}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ConnectionCard({ c }: { c: Connection }) {
  const tone: Tone = c.status === 'active' ? 'ok' : c.status === 'reauth_required' ? 'danger' : 'warn';
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {c.name}
            <Badge tone={tone}>{c.status === 'active' ? 'Connected' : c.status === 'reauth_required' ? 'Reconnect needed' : 'Sync error'}</Badge>
            <Badge>{TIER_LABEL[c.tier]}</Badge>
          </span>
        }
        subtitle={`${c.accountLabel} · last synced ${fmtRelative(c.lastSyncAt)}`}
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        {c.lastSyncError && (
          <Banner tone={c.status === 'reauth_required' ? 'danger' : 'warn'} icon={<AlertTriangle className="size-4" />}>
            {c.lastSyncError}
          </Banner>
        )}
        <div className="flex flex-wrap gap-1.5">
          {FEATURE.filter((f) => c.features[f.key]).map((f) => (
            <Badge key={f.key}>
              {f.icon}
              {f.label}
            </Badge>
          ))}
        </div>
        <details className="rounded-lg bg-bg-subtle px-3 py-2 text-[13px]">
          <summary className="cursor-pointer text-[12.5px] font-medium text-muted">Granted permissions ({c.scopes.length})</summary>
          <ul className="mt-2 space-y-1">
            {c.scopeDescriptions.map((d) => (
              <li key={d.scope}>
                <code className="text-[12px] text-accent-text">{d.scope}</code> — {d.why}
              </li>
            ))}
          </ul>
        </details>
        <ConnectionActions c={c} />
      </div>
    </Card>
  );
}

function ConnectionActions({ c }: { c: Connection }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const sync = useApiMutation(() => api<{ items: number; tasks: number }>(`/api/integrations/${c.id}/sync`, { method: 'POST', body: {} }), [['integrations'], ['inbox'], ['calendar'], ['tasks']]);
  const del = useApiMutation(() => api<{ revokedAtProvider: boolean; note?: string }>(`/api/integrations/${c.id}`, { method: 'DELETE' }), [['integrations'], ['me'], ['inbox'], ['calendar'], ['tasks'], ['briefing']]);
  const setTier = async (tier: Tier) => {
    try {
      const r = await api<{ requiresReconsent: boolean }>(`/api/integrations/${c.id}`, { method: 'PATCH', body: { tier } });
      if (r.requiresReconsent) {
        const a = await api<{ authUrl: string }>(`/api/integrations/${c.provider}/connect`, { method: 'POST', body: { features: c.features, tier, client: isDesktop ? 'desktop' : 'web' } });
        toast.info('This needs additional permission from the provider.');
        if (isDesktop) await openExternal(a.authUrl);
        else window.location.assign(a.authUrl);
        return;
      }
      await qc.invalidateQueries({ queryKey: ['integrations'] });
      toast.success(`Permissions set to “${TIER_LABEL[tier]}”`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={sync.isPending} onClick={() => sync.mutate(undefined, { onSuccess: (r) => toast.success(`Synced ${r.items} items${r.tasks ? ` and ${r.tasks} tasks` : ''}`), onError: (e) => toast.error(errorMessage(e)) })}>
        Sync now
      </Button>
      {c.provider !== 'demo' && c.provider !== 'slack' && (
        <select aria-label="Permission level" value={c.tier} onChange={(e) => void setTier(e.target.value as Tier)} className="h-7 rounded-lg border border-line bg-surface px-2 text-[12.5px]">
          {(['read', 'draft', 'write'] as const)
            .filter((t) => (c.provider === 'todoist' ? t !== 'draft' : true))
            .map((t) => (
              <option key={t} value={t}>
                {TIER_LABEL[t]}
              </option>
            ))}
        </select>
      )}
      {c.status === 'reauth_required' && (
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            try {
              const a = await api<{ authUrl: string }>(`/api/integrations/${c.provider}/connect`, { method: 'POST', body: { features: c.features, tier: c.tier, client: isDesktop ? 'desktop' : 'web' } });
              if (isDesktop) await openExternal(a.authUrl);
              else window.location.assign(a.authUrl);
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        >
          Reconnect
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={<Unplug className="size-3.5" />} onClick={() => setConfirm(true)}>
        Disconnect
      </Button>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${c.name}?`}
        description="Secretary will revoke its access where the provider supports it, delete the stored tokens, and delete all emails, events, messages and tasks synced from this account."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={async () => {
                try {
                  const r = await del.mutateAsync(undefined);
                  setConfirm(false);
                  toast.success(r.note ?? (r.revokedAtProvider ? 'Disconnected and access revoked' : 'Disconnected and data deleted'));
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Disconnect & delete data
            </Button>
          </>
        }
      />
    </div>
  );
}
