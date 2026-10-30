import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Cpu, Download, ExternalLink, HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiStream, errorMessage } from '../../lib/api';
import { openExternal } from '../../lib/platform';
import { Badge, Banner, Button, Card, CardHeader, Spinner } from '../../ui';

interface Status {
  running: boolean;
  version: string | null;
  downloadUrl: string;
  installed: { name: string; diskGB: number }[];
  recommended: { id: string; name: string; diskGB: number; minRamGB: number; note: string }[];
  inUse: string | null;
}

/** Free, private AI on this computer through the Ollama app: no account, no key, no cost. */
export function LocalAISetup({ onConnected }: { onConnected?: () => void }) {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ['local-ai'], queryFn: () => api<Status>('/api/ai/local/status'), refetchInterval: (q) => (q.state.data?.running ? false : 5000) });
  const [progress, setProgress] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['local-ai'] }), qc.invalidateQueries({ queryKey: ['ai-providers'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
  };

  const download = async (id: string) => {
    setProgress((p) => ({ ...p, [id]: 0 }));
    try {
      let failed: string | null = null;
      await apiStream<{ fraction?: number | null; done?: boolean; error?: string }>('/api/ai/local/pull', { model: id }, (e) => {
        if (e.error) failed = e.error;
        else if (typeof e.fraction === 'number') setProgress((p) => ({ ...p, [id]: e.fraction! }));
      });
      if (failed) throw new Error(failed);
      await use(id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setProgress((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
      await refresh();
    }
  };

  const use = async (id: string) => {
    setBusy(id);
    try {
      await api('/api/ai/local/use', { method: 'POST', body: { model: id } });
      toast.success('Local AI is on — free and private');
      await refresh();
      onConnected?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string, gb: number) => {
    if (!window.confirm(`Delete ${name} and free about ${gb} GB?`)) return;
    try {
      await api(`/api/ai/local/models/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast.success(`Deleted — ${gb} GB freed`);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (st.isLoading) return <Spinner />;
  const s = st.data;
  if (!s) return null;

  if (!s.running)
    return (
      <div className="flex flex-col gap-4">
        <ol className="flex flex-col gap-3 text-[13.5px]">
          <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-text">1</span>
            <div>
              Install the free <b>Ollama</b> app (about 0.5 GB).
              <div className="mt-2">
                <Button size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => void openExternal(s.downloadUrl)}>
                  Download Ollama
                </Button>
              </div>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-text">2</span>
            <div>Open it once. It runs quietly in the menu bar.</div>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-text">3</span>
            <div>Come back here — Secretary detects it automatically.</div>
          </li>
        </ol>
        <div className="flex items-center gap-2 text-[12.5px] text-muted">
          <Spinner className="size-3.5" /> Looking for Ollama…
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void st.refetch()}>
            Check now
          </Button>
        </div>
      </div>
    );

  const installed = new Map(s.installed.map((m) => [m.name, m.diskGB]));
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-[12.5px] text-ok">
        <Check className="size-3.5" /> Ollama {s.version} is running.
      </p>
      {s.recommended.map((m) => {
        const have = installed.has(m.id);
        const p = progress[m.id];
        const downloading = m.id in progress;
        return (
          <div key={m.id} className="rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold">{m.name}</span>
              <Badge>
                <HardDrive className="size-3" />
                {have ? `${installed.get(m.id)} GB on disk` : `${m.diskGB} GB download`}
              </Badge>
              <Badge>
                <Cpu className="size-3" />
                {m.minRamGB} GB RAM+
              </Badge>
              {s.inUse === m.id && <Badge tone="ok">In use</Badge>}
            </div>
            <p className="mt-1 text-[12.5px] text-muted">{m.note}</p>
            {downloading ? (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-bg-subtle">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round((p ?? 0) * 100)}%` }} />
                </div>
                <div className="mt-1 text-[12px] text-muted tabular">{p === null || p === undefined ? 'Starting…' : `Downloading… ${Math.round(p * 100)}%`}</div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {!have && (
                  <Button size="sm" variant="primary" icon={<Download className="size-3.5" />} onClick={() => void download(m.id)}>
                    Download & use ({m.diskGB} GB)
                  </Button>
                )}
                {have && s.inUse !== m.id && (
                  <Button size="sm" variant="primary" loading={busy === m.id} onClick={() => void use(m.id)}>
                    Use this model
                  </Button>
                )}
                {have && (
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove(m.id, installed.get(m.id) ?? m.diskGB)}>
                    Delete (frees {installed.get(m.id)} GB)
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[12px] text-faint">
        Want to save space on your Mac? In Ollama’s settings you can move models to an external drive (it must be plugged in for AI to work). Secretary’s briefings still work without AI.
      </p>
    </div>
  );
}

export function LocalAICard() {
  return (
    <Card>
      <CardHeader title="Free AI on this computer" subtitle="No account, no API key, no cost. Your data never leaves this machine." icon={<Cpu className="size-4" />} />
      <div className="px-5 pb-5">
        <LocalAISetup />
      </div>
    </Card>
  );
}

export function LocalAIExplainer() {
  return (
    <Banner tone="info" title="How local AI compares">
      Local models are free and private but less sharp than GPT or Claude. Deadlines, conflicts and priorities are always calculated from your data either way.
    </Banner>
  );
}
