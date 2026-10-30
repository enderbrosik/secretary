import { useEffect, useState } from 'react';
import { HardDrive, Server } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { getServerConfig, setServerConfig, type ServerConfig } from '../lib/platform';
import { Banner, Button, Card, cn, Field, Input } from '../ui';

/** Desktop only: choose between the bundled local server and a hosted/self-hosted server. */
export default function DesktopSetupPage({ error }: { error?: unknown }) {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getServerConfig().then((c) => {
      setCfg(c);
      if (c?.mode === 'remote') setUrl(c.url);
    });
  }, []);
  const apply = async (next: ServerConfig) => {
    setBusy(true);
    await setServerConfig(next);
    window.location.reload();
  };
  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-xl">
        <h1 className="font-display text-[28px]">Where should Secretary run?</h1>
        <p className="mt-1 text-muted">You can change this later.</p>
        {error ? (
          <div className="mt-4">
            <Banner tone="danger" title="Secretary couldn’t start its local server">
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-[12.5px]">{errorMessage(error)}</pre>
            </Banner>
          </div>
        ) : null}
        <div className="mt-6 grid gap-3">
          <button onClick={() => void apply({ mode: 'local', url: '' })} disabled={busy} className={cn('rounded-xl border p-4 text-left', cfg?.mode === 'local' ? 'border-accent bg-accent-soft/50' : 'border-line bg-surface hover:border-line-strong')}>
            <div className="flex items-center gap-2 text-[14px] font-semibold"><HardDrive className="size-4" /> On this computer (local mode)</div>
            <p className="mt-1 text-[13px] text-muted">Your data and credentials stay on this machine, protected by the system keychain. Scheduled briefings run while Secretary is running — enable launch at login.</p>
          </button>
          <Card className={cn('p-4', cfg?.mode === 'remote' && 'border-accent')}>
            <div className="flex items-center gap-2 text-[14px] font-semibold"><Server className="size-4" /> On a server</div>
            <p className="mt-1 text-[13px] text-muted">Connect to a hosted or self-hosted Secretary server. Briefings run on schedule even when this computer is off.</p>
            <div className="mt-3 flex gap-2">
              <Field label="Server URL" className="flex-1">{(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://secretary.example.com" />}</Field>
              <Button className="self-end" disabled={!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(url)} loading={busy} onClick={() => void apply({ mode: 'remote', url })}>
                Use server
              </Button>
            </div>
            <p className="mt-1.5 text-[12px] text-faint">HTTPS is required for remote servers.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
