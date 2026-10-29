import { createHash, randomBytes } from 'node:crypto';
import { IntegrationError } from './types.js';

export interface RequestOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
}

/**
 * Minimal JSON HTTP client for provider APIs. Error messages never include
 * response bodies or tokens; only status-derived, user-safe descriptions.
 */
export async function request<T>(provider: string, url: string, opts: RequestOptions = {}): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  let res: Response;
  try {
    res = await fetch(u, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  } catch {
    throw new IntegrationError('unavailable', `${provider} could not be reached`);
  }
  if (res.status === 401) throw new IntegrationError('auth_expired', `${provider} authorization expired or was revoked`);
  if (res.status === 403) throw new IntegrationError('insufficient_scope', `${provider} denied access (missing permission)`);
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new IntegrationError('rate_limited', `${provider} rate limit reached`, Number.isFinite(ra) ? ra : 60);
  }
  if (res.status >= 500) throw new IntegrationError('unavailable', `${provider} is temporarily unavailable`);
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw new IntegrationError('bad_response', `${provider} request failed (${res.status})`);
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new IntegrationError('bad_response', `${provider} returned an unexpected response`);
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function expiresAtFrom(now: Date, expiresInSeconds: number | undefined | null): string | null {
  return expiresInSeconds ? new Date(now.getTime() + expiresInSeconds * 1000).toISOString() : null;
}

/** Run async tasks with bounded concurrency (respecting provider rate limits). */
export async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (i < xs.length) {
      const idx = i++;
      out[idx] = await fn(xs[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Converts simple HTML to readable text for summarization. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Drops quoted history ("On … wrote:") so only the newest message is summarized. */
export function stripQuoted(text: string): string {
  const cut = text.search(/\n(On .{5,120} wrote:|-{2,} ?Original Message ?-{2,}|From: .+\nSent: )/i);
  return (cut > 0 ? text.slice(0, cut) : text).replace(/^>.*$/gm, '').trim();
}

export function parseAddress(raw: string): { name: string | null; email: string | null } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: m[1]!.trim() || null, email: m[2]!.trim().toLowerCase() };
  const e = raw.trim();
  return { name: null, email: e.includes('@') ? e.toLowerCase() : null };
}

export function parseAddressList(raw: string | undefined): { name: string | null; email: string | null }[] {
  if (!raw) return [];
  // split on commas not inside quotes
  return raw
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseAddress);
}

export const BULK_SENDER = /(no-?reply|do-?not-?reply|notifications?@|newsletter|mailer-daemon|bounce)/i;
