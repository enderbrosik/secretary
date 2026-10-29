import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, ShieldCheck, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import type { Settings } from '@secretary/core';
import { api, errorMessage } from '../lib/api';
import { useAIProviders, useIntegrations, useMe } from '../lib/queries';
import { AIProviderSetup } from '../components/settings/AISettings';
import { IntegrationSettings } from '../components/settings/IntegrationSettings';
import { ScheduleFields, StyleFields } from '../components/settings/PreferenceSettings';
import { Badge, Banner, Button, Card, cn } from '../ui';

const STEPS = ['Welcome', 'AI provider', 'Connect', 'Accounts', 'Permissions', 'Schedule', 'Style', 'First briefing'];

export default function OnboardingPage() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const ai = useAIProviders();
  const integ = useIntegrations();
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [prefs, setPrefs] = useState<Settings>(() => me.data!.settings!);
  const [busy, setBusy] = useState(false);
  const hasAI = ai.data?.configured.some((p) => p.active);
  const connections = integ.data?.connections ?? [];

  const finish = async () => {
    setBusy(true);
    try {
      await api('/api/settings', { method: 'PATCH', body: { ...prefs, onboardingCompleted: true } });
      await api('/api/briefings/generate', { method: 'POST', body: { trigger: 'onboarding' } });
      await qc.invalidateQueries();
      nav('/');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-14">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="size-7 rounded-lg" />
            <span className="font-display text-[21px]">Secretary</span>
          </div>
          <span className="text-[12.5px] text-muted">
            Step {step + 1} of {STEPS.length}
          </span>
        </div>
        <div className="mb-8 flex gap-1" aria-hidden>
          {STEPS.map((s, i) => (
            <div key={s} className={cn('h-1 flex-1 rounded-full transition-colors', i <= step ? 'bg-accent' : 'bg-line')} />
          ))}
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }}>
            {step === 0 && (
              <Step title={`Welcome${me.data?.user?.displayName ? `, ${me.data.user.displayName.split(' ')[0]}` : ''}.`} subtitle="Secretary prepares a calm, honest picture of your day — what matters, what needs a reply, what to prepare for — and helps you wrap up each evening.">
                <ul className="grid gap-3 sm:grid-cols-3">
                  {[
                    ['Your AI, your key', 'Choose OpenAI or Anthropic and use your own API key.'],
                    ['Your accounts', 'Connect calendar, email, Slack and tasks with official sign-in.'],
                    ['You approve everything', 'Nothing is sent or changed without your explicit approval.'],
                  ].map(([t, d]) => (
                    <Card key={t} className="p-4">
                      <div className="text-[13.5px] font-semibold">{t}</div>
                      <div className="mt-1 text-[12.5px] text-muted">{d}</div>
                    </Card>
                  ))}
                </ul>
              </Step>
            )}
            {step === 1 && (
              <Step title="Choose your AI provider" subtitle="Secretary uses an AI model for summaries, prioritization and suggestions. Deadlines and conflicts are always computed from your data directly.">
                <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
                  {(['anthropic', 'openai'] as const).map((p) => (
                    <button key={p} role="radio" aria-checked={provider === p} onClick={() => setProvider(p)} className={cn('rounded-xl border p-5 text-left', provider === p ? 'border-accent bg-accent-soft/50 ring-2 ring-accent/20' : 'border-line bg-surface hover:border-line-strong')}>
                      <div className="text-[15px] font-semibold">{p === 'anthropic' ? 'Anthropic' : 'OpenAI'}</div>
                      <div className="mt-1 text-[13px] text-muted">{p === 'anthropic' ? 'Claude models via the Claude API' : 'GPT models via the OpenAI API'}</div>
                    </button>
                  ))}
                </div>
                <p className="mt-4 text-[12.5px] text-muted">You can skip this — Secretary still works with rule-based briefings, and you can add a key later in Settings.</p>
              </Step>
            )}
            {step === 2 && (
              <Step title="Connect your AI provider" subtitle="Paste an API key. It’s verified with the provider and stored encrypted on the server.">
                {hasAI ? (
                  <Banner tone="ok" title="Connected" icon={<Check className="size-4" />}>
                    {ai.data!.configured.find((p) => p.active)!.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} is connected using {ai.data!.configured.find((p) => p.active)!.model}.
                  </Banner>
                ) : (
                  <AIProviderSetup onConnected={next} key={provider} />
                )}
              </Step>
            )}
            {step === 3 && (
              <Step title="Connect your accounts" subtitle="Pick the services Secretary should help you with. All optional — you can also try the demo workspace.">
                <IntegrationSettings compact />
              </Step>
            )}
            {step === 4 && (
              <Step title="Review what Secretary can access" subtitle="Each connection only gets the permissions you chose. You can lower or raise them at any time in Settings → Integrations.">
                {!connections.length ? (
                  <Banner tone="info">No accounts connected yet. Secretary will use only the tasks you add yourself until you connect something.</Banner>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {connections.map((c) => (
                      <Card key={c.id} className="p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[14px] font-semibold">{c.name}</span>
                          <Badge>{c.accountLabel}</Badge>
                          <Badge tone={c.tier === 'read' ? 'ok' : 'warn'}>{c.tier === 'read' ? 'Read only' : c.tier === 'draft' ? 'Read + drafts' : 'Can send & change (with approval)'}</Badge>
                        </div>
                        <ul className="mt-2 space-y-1 text-[12.5px] text-muted">
                          {c.scopeDescriptions.map((d) => (
                            <li key={d.scope}>• {d.why}</li>
                          ))}
                        </ul>
                      </Card>
                    ))}
                  </ul>
                )}
                <div className="mt-4 flex items-start gap-2 rounded-xl bg-bg-subtle p-4 text-[13px] text-ink-2">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" />
                  Content from emails and messages is treated as untrusted data. Instructions hidden inside them can’t make the assistant act, and any external action waits for your approval.
                </div>
              </Step>
            )}
            {step === 5 && (
              <Step title="Your working hours" subtitle="Used to find focus time and to schedule your briefing and review.">
                <Card className="p-5">
                  <ScheduleFields value={prefs} onChange={(v) => setPrefs({ ...prefs, ...v })} />
                </Card>
              </Step>
            )}
            {step === 6 && (
              <Step title="How should your assistant sound?" subtitle="This shapes summaries, tips and drafts.">
                <Card className="p-5">
                  <StyleFields value={prefs} onChange={(v) => setPrefs({ ...prefs, ...v })} />
                </Card>
              </Step>
            )}
            {step === 7 && (
              <Step title="Ready for your first briefing" subtitle="Secretary will sync your accounts and prepare today’s overview. After this, it arrives automatically every work day.">
                <Card className="p-5 text-[13.5px]">
                  <ul className="space-y-1.5">
                    <li>AI provider: {hasAI ? <Badge tone="ok">connected</Badge> : <Badge>not connected — rule-based briefing</Badge>}</li>
                    <li>Accounts: {connections.length ? connections.map((c) => c.name).join(', ') : 'none yet'}</li>
                    <li>
                      Briefing at {prefs.briefingTime}, review at {prefs.reviewTime} ({prefs.timezone})
                    </li>
                  </ul>
                </Card>
              </Step>
            )}
          </motion.div>
        </AnimatePresence>
        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={back} disabled={step === 0}>
            Back
          </Button>
          <div className="flex gap-2">
            {(step === 2 || step === 3) && (
              <Button variant="ghost" onClick={next}>
                Skip for now
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={next}>
                Continue <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button variant="primary" loading={busy} icon={<Sparkles className="size-4" />} onClick={finish}>
                Prepare my briefing
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="font-display text-[30px] leading-tight tracking-[-0.01em]">{title}</h1>
      <p className="mt-2 max-w-2xl text-[14.5px] text-muted">{subtitle}</p>
      <div className="mt-7">{children}</div>
    </div>
  );
}
