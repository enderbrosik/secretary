import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../../lib/api';
import { openExternal } from '../../lib/platform';
import type { ProviderInfo } from '../../lib/queries';
import { Banner, Button, Dialog, Field, Input, Select } from '../../ui';

/** Slack app manifest: creates the app with exactly the read-only user scopes Secretary needs. */
const SLACK_MANIFEST = `display_information:
  name: Secretary
  description: Personal secretary — reads your DMs and mentions (read-only)
oauth_config:
  scopes:
    user:
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - users:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false`;

function CopyBox({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-line bg-surface-2">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[11.5px] text-muted">
        {label}
        <button
          type="button"
          className="inline-flex items-center gap-1 text-accent-text hover:underline"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={`overflow-x-auto px-3 py-2 font-mono text-[12px] ${multiline ? 'max-h-48' : 'whitespace-nowrap'}`}>{value}</pre>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-text">{n}</span>
      <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed">{children}</div>
    </li>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={() => void openExternal(href)} className="inline-flex items-center gap-0.5 font-medium text-accent-text hover:underline">
      {children}
      <ExternalLink className="size-3" />
    </button>
  );
}

/** Step-by-step, one-time setup for a provider, written for non-developers. */
export function ProviderSetupDialog({ provider, onClose, onReady }: { provider: ProviderInfo; onClose: () => void; onReady: () => void }) {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [tenant, setTenant] = useState('common');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const p = provider.provider;
  const redirect = provider.redirectUri ?? '';

  const saveApp = async () => {
    setBusy(true);
    try {
      await api(`/api/integrations/${p}/app`, { method: 'PUT', body: { clientId: clientId.trim(), clientSecret: secret.trim(), ...(p === 'microsoft' ? { tenant } : {}) } });
      await qc.invalidateQueries({ queryKey: ['integrations'] });
      toast.success('Saved. Now sign in to connect your account.');
      onReady();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const connectToken = async () => {
    setBusy(true);
    try {
      const r = await api<{ accountLabel: string }>(`/api/integrations/${p}/token`, { method: 'POST', body: { token: token.trim(), tier: p === 'todoist' ? 'write' : 'read' } });
      await Promise.all([qc.invalidateQueries({ queryKey: ['integrations'] }), qc.invalidateQueries({ queryKey: ['tasks'] }), qc.invalidateQueries({ queryKey: ['inbox'] })]);
      toast.success(`Connected ${r.accountLabel}. Syncing now…`);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const appFields = (idLabel: string, secretLabel: string) => (
    <div className="mt-4 grid gap-3">
      <Field label={idLabel}>{(id) => <Input id={id} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />}</Field>
      <Field label={secretLabel} hint="Stored encrypted on this computer.">
        {(id) => <Input id={id} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />}
      </Field>
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      wide
      title={`Set up ${provider.name}`}
      description={p === 'slack' || p === 'todoist' ? 'One-time setup — about 2 minutes. No password is shared with Secretary.' : 'One-time setup — about 5–10 minutes. You only do this once per service.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {p === 'slack' || p === 'todoist' ? (
            <Button variant="primary" loading={busy} disabled={token.trim().length < 10} onClick={connectToken}>
              Connect
            </Button>
          ) : (
            <Button variant="primary" loading={busy} disabled={clientId.trim().length < 8 || secret.trim().length < 8} onClick={saveApp}>
              Save & continue
            </Button>
          )}
        </>
      }
    >
      {p === 'todoist' && (
        <ol className="flex flex-col gap-4">
          <Step n={1}>
            Open <Link href="https://app.todoist.com/app/settings/integrations/developer">Todoist → Settings → Integrations → Developer</Link>.
          </Step>
          <Step n={2}>
            Click <b>Copy API token</b> and paste it here.
            <div className="mt-2">
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="40-character API token" type="password" autoComplete="off" spellCheck={false} aria-label="Todoist API token" />
            </div>
          </Step>
          <Banner tone="info">Secretary can read your tasks and, when you tick one off here, also complete it in Todoist (you’re asked first).</Banner>
        </ol>
      )}

      {p === 'slack' && (
        <ol className="flex flex-col gap-4">
          <Step n={1}>
            Go to <Link href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</Link>, choose <b>Create New App → From a manifest</b>, and pick your workspace.
          </Step>
          <Step n={2}>
            Switch the format to <b>YAML</b>, replace everything with this, then click <b>Next → Create</b>:
            <CopyBox label="App manifest (read-only permissions)" value={SLACK_MANIFEST} multiline />
          </Step>
          <Step n={3}>
            Click <b>Install to Workspace</b> and then <b>Allow</b>. (Some company workspaces need an admin to approve.)
          </Step>
          <Step n={4}>
            Open <b>OAuth & Permissions</b>, copy the <b>User OAuth Token</b> (it starts with <code>xoxp-</code>) and paste it here.
            <div className="mt-2">
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="xoxp-…" type="password" autoComplete="off" spellCheck={false} aria-label="Slack user token" />
            </div>
          </Step>
          <Banner tone="info">Read-only: Secretary sees your DMs and messages that mention you. It can’t post or change anything in Slack.</Banner>
        </ol>
      )}

      {p === 'google' && (
        <ol className="flex flex-col gap-4">
          <Step n={1}>
            Open <Link href="https://console.cloud.google.com/projectcreate">Google Cloud Console</Link> and create a project named <b>Secretary</b> (free, no billing needed).
          </Step>
          <Step n={2}>
            Enable <Link href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Gmail API</Link> and{' '}
            <Link href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Google Calendar API</Link> (click <b>Enable</b> on each).
          </Step>
          <Step n={3}>
            Open the <Link href="https://console.cloud.google.com/auth/overview">Google Auth Platform</Link> and click <b>Get started</b>: app name <b>Secretary</b>, your email, Audience <b>External</b>.
          </Step>
          <Step n={4}>
            Under <b>Audience</b>, click <b>Publish app</b> and confirm. (In “Testing” mode Google disconnects you every 7 days. Publishing a personal app is fine — you’ll just see an “unverified app” notice when signing in.)
          </Step>
          <Step n={5}>
            Under <b>Clients</b>, click <b>Create client</b> → type <b>Web application</b> → under <b>Authorized redirect URIs</b> click <b>Add URI</b> and paste:
            <CopyBox label="Redirect URI" value={redirect} />
            Click <b>Create</b>.
          </Step>
          <Step n={6}>
            Copy the <b>Client ID</b> and <b>Client secret</b> into the boxes below.
            {appFields('Client ID', 'Client secret')}
          </Step>
        </ol>
      )}

      {p === 'microsoft' && (
        <ol className="flex flex-col gap-4">
          <Step n={1}>
            Open <Link href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">Microsoft Entra → App registrations</Link> and sign in. (If it asks you to create a free Azure account first, do that — there’s no charge.)
          </Step>
          <Step n={2}>
            Click <b>New registration</b>: name <b>Secretary</b>; supported accounts <b>“Any Entra ID tenant + personal Microsoft accounts”</b>; redirect URI platform <b>Web</b>, value:
            <CopyBox label="Redirect URI" value={redirect} />
            Click <b>Register</b>, then copy the <b>Application (client) ID</b> from the overview page.
          </Step>
          <Step n={3}>
            Open <b>Certificates & secrets → New client secret</b> → Add, then copy the secret’s <b>Value</b> right away (it’s shown only once — not the “Secret ID”).
          </Step>
          <Step n={4}>
            Open <b>API permissions → Add a permission → Microsoft Graph → Delegated</b> and add <b>Calendars.Read</b>, <b>Mail.Read</b>, <b>offline_access</b> and <b>User.Read</b>.
          </Step>
          <Step n={5}>
            Paste the values below.
            {appFields('Application (client) ID', 'Client secret value')}
            <div className="mt-3">
              <Field label="Which accounts will you connect?">
                {(id) => (
                  <Select id={id} value={tenant} onChange={(e) => setTenant(e.target.value)}>
                    <option value="common">Work, school or personal (recommended)</option>
                    <option value="consumers">Personal only (Outlook.com, Hotmail)</option>
                    <option value="organizations">Work or school only</option>
                  </Select>
                )}
              </Field>
            </div>
          </Step>
        </ol>
      )}
    </Dialog>
  );
}
