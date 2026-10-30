import { clearSessionToken, getServerConfig, isDesktop, loadSessionToken } from './platform';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let base = import.meta.env.VITE_API_URL ?? '';
let bearer: string | null = null;
let csrf: string | null = null;
let onUnauthorized: (() => void) | null = null;

export async function initApi(): Promise<void> {
  if (isDesktop) {
    const cfg = await getServerConfig();
    if (cfg) base = cfg.url.replace(/\/$/, '');
    bearer = await loadSessionToken();
  }
}
export const apiBase = () => base;
export const setBearer = (t: string | null) => (bearer = t);
export const setCsrf = (t: string | null | undefined) => (csrf = t ?? null);
export const setUnauthorizedHandler = (f: () => void) => (onUnauthorized = f);
export const usesBearer = () => isDesktop;

function headers(json: boolean): HeadersInit {
  const h: Record<string, string> = { accept: 'application/json' };
  if (json) h['content-type'] = 'application/json';
  if (bearer) h.authorization = `Bearer ${bearer}`;
  else if (csrf) h['x-csrf-token'] = csrf;
  return h;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: headers(opts.body !== undefined),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: bearer ? 'omit' : 'include',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Can’t reach the Secretary server. Check your connection.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      if (isDesktop) await clearSessionToken();
      onUnauthorized?.();
    }
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? (res.status === 429 ? 'Too many requests — try again shortly.' : 'Request failed'), err?.details);
  }
  return data as T;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Reads a newline-delimited JSON stream (assistant responses). */
export async function apiStream<E>(path: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: headers(true), body: JSON.stringify(body), credentials: bearer ? 'omit' : 'include', signal });
  if (!res.ok || !res.body) {
    const data = safeJson(await res.text()) as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Request failed');
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line) as E);
    }
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === 'string' && e) return e; // errors from the desktop shell arrive as strings
  return 'Something went wrong';
}
