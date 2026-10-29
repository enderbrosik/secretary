import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, KeyRound, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../../lib/api';
import { openExternal } from '../../lib/platform';
import { fmtRelative } from '../../lib/format';
import { useAIProviders, useApiMutation, type AIProviderDto } from '../../lib/queries';
import { Badge, Banner, Button, Card, CardHeader, cn, Field, Input, Select, Spinner, Switch } from '../../ui';

type ProviderId = 'openai' | 'anthropic';

/** Connect / manage the user's own AI provider key. Keys are verified, encrypted server-side and never shown again. */
export function AIProviderSetup({ onConnected }: { onConnected?: () => void }) {
  const q = useAIProviders();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [key, setKey] = useState('');
  const info = q.data?.available[provider];
  const save = useApiMutation(() => api<{ provider: AIProviderDto }>('/api/ai/providers', { method: 'POST', body: { provider, apiKey: key } }), [['ai-providers'], ['me']]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="AI provider">
        {(['anthropic', 'openai'] as const).map((p) => (
          <button
            key={p}
            role="radio"
            aria-checked={provider === p}
            onClick={() => setProvider(p)}
            className={cn('rounded-xl border p-4 text-left transition-colors', provider === p ? 'border-accent bg-accent-soft/50 ring-2 ring-accent/20' : 'border-line bg-surface hover:border-line-strong')}
          >
            <div className="text-[14px] font-semibold">{p === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI (GPT)'}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">{p === 'anthropic' ? 'API key from the Claude Console' : 'API key from the OpenAI Platform'}</div>
          </button>
        ))}
      </div>
      {info && (
        <Banner tone="info" title="Separate API billing">
          {info.billingNote} Usage is charged by {info.name} to your API account.
        </Banner>
      )}
      <Field
        label="API key"
        hint={
          <span>
            Create a key at{' '}
            <button type="button" className="text-accent-text hover:underline" onClick={() => info && void openExternal(info.keyUrl)}>
              {info?.keyUrl.replace('https://', '')} <ExternalLink className="inline size-3" />
            </button>
            . It’s verified, encrypted and stored on the server — never in your browser.
          </span>
        }
      >
        {(id) => <Input id={id} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={`${info?.keyPrefix ?? ''}…`} />}
      </Field>
      <div>
        <Button
          variant="primary"
          icon={<KeyRound className="size-4" />}
          disabled={key.trim().length < 10}
          loading={save.isPending}
          onClick={async () => {
            try {
              const r = await save.mutateAsync(undefined);
              setKey('');
              toast.success(`Connected — using ${r.provider.model}`);
              await qc.invalidateQueries({ queryKey: ['ai-models'] });
              onConnected?.();
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        >
          Verify & connect
        </Button>
      </div>
      <p className="text-[12px] text-faint">Secretary never asks for your ChatGPT or Claude password. Consumer subscriptions (ChatGPT Plus, Claude Pro) don’t include API access.</p>
    </div>
  );
}

export function AISettings() {
  const q = useAIProviders();
  const active = q.data?.configured.find((p) => p.active);
  const others = q.data?.configured.filter((p) => !p.active) ?? [];
  const [adding, setAdding] = useState(false);
  if (q.isLoading) return <Spinner />;
  return (
    <div className="flex flex-col gap-6">
      {active ? <ProviderCard p={active} /> : null}
      {others.map((p) => (
        <ProviderCard key={p.provider} p={p} />
      ))}
      <Card>
        <CardHeader title={active ? 'Add or replace a provider' : 'Connect an AI provider'} subtitle="Bring your own key. Switch providers at any time." />
        <div className="px-5 pb-5">{active && !adding ? <Button onClick={() => setAdding(true)}>Add another key</Button> : <AIProviderSetup onConnected={() => setAdding(false)} />}</div>
      </Card>
      <UsageCard />
    </div>
  );
}

function ProviderCard({ p }: { p: AIProviderDto }) {
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ['ai-models', p.provider], queryFn: () => api<{ models: { id: string; displayName: string; deprecated: boolean }[] }>(`/api/ai/providers/${p.provider}/models`), enabled: p.active, retry: false });
  const [budget, setBudget] = useState(p.monthlyBudgetUsd?.toString() ?? '');
  const [inPrice, setInPrice] = useState(p.inputPricePerMTok?.toString() ?? '');
  const [outPrice, setOutPrice] = useState(p.outputPricePerMTok?.toString() ?? '');
  useEffect(() => setBudget(p.monthlyBudgetUsd?.toString() ?? ''), [p.monthlyBudgetUsd]);
  const patch = useApiMutation((body: Record<string, unknown>) => api(`/api/ai/providers/${p.provider}`, { method: 'PATCH', body }), [['ai-providers']]);
  const test = useApiMutation(() => api<{ ok: boolean; message?: string; modelCount?: number }>(`/api/ai/providers/${p.provider}/test`, { method: 'POST', body: {} }), [['ai-providers']]);
  const remove = useApiMutation(() => api(`/api/ai/providers/${p.provider}`, { method: 'DELETE' }), [['ai-providers']]);
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            {p.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}
            {p.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}
          </span>
        }
        subtitle={`Key ${p.keyHint} · last checked ${fmtRelative(p.lastTestedAt)}`}
        actions={
          <>
            <Button size="sm" loading={test.isPending} onClick={async () => { const r = await test.mutateAsync(undefined); r.ok ? toast.success(`Connection works · ${r.modelCount} models available`) : toast.error(r.message ?? 'Test failed'); }}>
              Test
            </Button>
            {!p.active && <Button size="sm" onClick={() => patch.mutate({ active: true })}>Make active</Button>}
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={async () => { await remove.mutateAsync(undefined); await qc.invalidateQueries({ queryKey: ['me'] }); toast.success('Key deleted'); }}>
              Remove
            </Button>
          </>
        }
      />
      <div className="grid gap-4 px-5 pb-5 sm:grid-cols-2">
        {p.lastError && <div className="sm:col-span-2"><Banner tone="danger">{p.lastError}</Banner></div>}
        <Field label="Model" hint="Models are listed from your account. The default is chosen from what your key can access.">
          {(id) =>
            models.isLoading ? (
              <Spinner />
            ) : models.isError ? (
              <p className="text-[13px] text-danger">{errorMessage(models.error)}</p>
            ) : (
              <Select id={id} value={p.model ?? ''} onChange={(e) => patch.mutate({ model: e.target.value }, { onSuccess: () => toast.success('Model updated') })}>
                {models.data?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                    {m.deprecated ? ' (deprecated)' : ''}
                  </option>
                ))}
              </Select>
            )
          }
        </Field>
        <Field label="Monthly spending limit (USD)" hint="AI features pause when the estimated cost reaches this. Leave empty for no limit.">
          {(id) => <Input id={id} type="number" min={0} step={1} value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={() => patch.mutate({ monthlyBudgetUsd: num(budget) })} placeholder="No limit" />}
        </Field>
        <Field label="Input price per 1M tokens (USD)" hint={p.defaultPrice ? `Default estimate: $${p.defaultPrice.input}` : 'No built-in price for this model — set one to see cost estimates.'}>
          {(id) => <Input id={id} type="number" min={0} step="0.01" value={inPrice} onChange={(e) => setInPrice(e.target.value)} onBlur={() => patch.mutate({ inputPricePerMTok: num(inPrice), outputPricePerMTok: num(outPrice) })} placeholder={p.defaultPrice ? String(p.defaultPrice.input) : '—'} />}
        </Field>
        <Field label="Output price per 1M tokens (USD)" hint={p.defaultPrice ? `Default estimate: $${p.defaultPrice.output}` : undefined}>
          {(id) => <Input id={id} type="number" min={0} step="0.01" value={outPrice} onChange={(e) => setOutPrice(e.target.value)} onBlur={() => patch.mutate({ inputPricePerMTok: num(inPrice), outputPricePerMTok: num(outPrice) })} placeholder={p.defaultPrice ? String(p.defaultPrice.output) : '—'} />}
        </Field>
        <div className="sm:col-span-2">
          <Switch
            checked={p.sendEmailBodies}
            onCheckedChange={(v) => patch.mutate({ sendEmailBodies: v })}
            label="Include email body text"
            description="When off, only senders, subjects and short previews are synced and sent to the AI provider."
          />
        </div>
      </div>
    </Card>
  );
}

function UsageCard() {
  const q = useQuery({ queryKey: ['ai-usage'], queryFn: () => api<{ monthToDateUsd: number; byPurpose: { purpose: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number; unpriced: number }[]; recent: { id: string; purpose: string; model: string; success: boolean; errorCode: string | null; createdAt: string; costUsd: number | null }[]; note: string }>('/api/ai/usage') });
  if (!q.data) return null;
  return (
    <Card>
      <CardHeader title="Usage this month" subtitle={q.data.note} actions={<span className="text-[18px] font-semibold tabular">${q.data.monthToDateUsd.toFixed(2)}</span>} />
      <div className="overflow-x-auto px-5 pb-5">
        {!q.data.byPurpose.length ? (
          <p className="text-[13px] text-muted">No AI calls yet this month.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-muted">
              <tr>
                <th className="py-1.5 font-medium">Feature</th>
                <th className="font-medium">Calls</th>
                <th className="font-medium">Tokens in / out</th>
                <th className="text-right font-medium">Est. cost</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {q.data.byPurpose.map((r) => (
                <tr key={r.purpose} className="border-t border-line">
                  <td className="py-1.5 capitalize">{r.purpose}</td>
                  <td>{r.calls}</td>
                  <td>
                    {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                  </td>
                  <td className="text-right">
                    ${r.costUsd.toFixed(3)}
                    {r.unpriced > 0 && <span className="text-faint"> +{r.unpriced} unpriced</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {q.data.recent.some((r) => !r.success) && (
          <p className="mt-3 flex items-center gap-1.5 text-[12px] text-muted">
            <CheckCircle2 className="size-3.5" /> Failed calls are recorded but not billed by Secretary; check your provider dashboard for authoritative billing.
          </p>
        )}
      </div>
    </Card>
  );
}
