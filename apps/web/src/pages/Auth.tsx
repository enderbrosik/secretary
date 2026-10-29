import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, setBearer, setCsrf } from '../lib/api';
import { browserTimezone } from '../lib/format';
import { isDesktop, saveSessionToken } from '../lib/platform';
import { useMe } from '../lib/queries';
import { Banner, Button, Field, Input } from '../ui';

export function AuthPage({ mode, serverError }: { mode: 'login' | 'signup'; serverError?: unknown }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = useMe();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signupAllowed = me.data?.signupAllowed !== false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const client = isDesktop ? 'desktop' : 'web';
      const body = mode === 'signup' ? { email, password, displayName: name, timezone: browserTimezone(), client } : { email, password, client };
      const r = await api<{ csrfToken: string; token?: string }>(`/api/auth/${mode}`, { method: 'POST', body });
      if (r.token) {
        await saveSessionToken(r.token);
        setBearer(r.token);
      }
      setCsrf(r.csrfToken);
      await qc.invalidateQueries();
      nav(mode === 'signup' ? '/onboarding' : '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div className="hidden lg:flex flex-col justify-between bg-bg-subtle border-r border-line p-12">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7 rounded-lg" />
          <span className="font-display text-[22px]">Secretary</span>
        </div>
        <div className="max-w-md">
          <p className="font-display text-[34px] leading-[1.2] tracking-[-0.01em]">Start every day knowing exactly what matters.</p>
          <p className="mt-4 text-[15px] text-muted leading-relaxed">
            A calm morning briefing, an inbox that tells you what needs a reply, meeting prep, and an honest end-of-day review — powered by the AI provider you choose, using only the accounts you connect.
          </p>
        </div>
        <p className="text-[12.5px] text-faint">Your API key, your accounts, your data. Nothing is sent or changed without your approval.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="lg:hidden mb-8 flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="size-7 rounded-lg" />
            <span className="font-display text-[22px]">Secretary</span>
          </div>
          <h1 className="font-display text-[28px] tracking-[-0.01em]">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
          <p className="mt-1 text-muted">{mode === 'login' ? 'Sign in to see today’s briefing.' : 'It takes about three minutes to set up.'}</p>
          {serverError ? (
            <div className="mt-5">
              <Banner tone="danger" title="Can’t reach the server">{errorMessage(serverError)}</Banner>
            </div>
          ) : null}
          <div className="mt-7 flex flex-col gap-4">
            {mode === 'signup' && <Field label="Your name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} />}</Field>}
            <Field label="Email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />}</Field>
            <Field label="Password" hint={mode === 'signup' ? 'At least 10 characters.' : undefined}>
              {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'signup' ? 10 : 1} />}
            </Field>
            {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
            <Button variant="primary" type="submit" loading={busy} className="mt-1 h-10">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </div>
          {signupAllowed && (
            <p className="mt-6 text-center text-[13px] text-muted">
              {mode === 'login' ? (
                <>
                  New here?{' '}
                  <Link to="/signup" className="text-accent-text hover:underline">
                    Create an account
                  </Link>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <Link to="/login" className="text-accent-text hover:underline">
                    Sign in
                  </Link>
                </>
              )}
            </p>
          )}
          {isDesktop && (
            <p className="mt-3 text-center text-[12.5px]">
              <Link to="/desktop-setup" className="text-muted hover:text-ink">
                Server settings
              </Link>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
