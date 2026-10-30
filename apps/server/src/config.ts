import { z } from 'zod';

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8787),
  /** Public base URL of the API (used for OAuth redirect URIs). */
  PUBLIC_URL: z.string().url().default('http://localhost:8787'),
  /** Comma-separated allowed browser origins (web app, desktop webview). */
  WEB_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173,tauri://localhost,http://tauri.localhost,https://tauri.localhost'),
  /** URL the OAuth callback redirects the browser back to. */
  APP_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1).default('postgres://secretary:secretary@localhost:5432/secretary'),
  /** 32-byte key, base64. Encrypts per-user data keys (envelope encryption). */
  MASTER_KEY: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SESSION_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(false),
  SERVE_WEB_DIR: z.string().optional(),
  JOBS_ENABLED: bool(true),
  JOB_TICK_SECONDS: z.coerce.number().int().min(5).default(30),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(15),
  ALLOW_SIGNUP: bool(true),
  ALLOW_DEMO: bool(true),
  /** Desktop local mode: single-user sidecar bound to loopback. */
  LOCAL_MODE: bool(false),
  /** Local AI via the free Ollama app (no key). */
  OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
  /**
   * Developer option (local mode): register your own OAuth apps or paste provider tokens in
   * Settings. Off in releases, where the app's built-in OAuth apps are used.
   */
  CUSTOM_OAUTH_APPS: bool(false),
  /**
   * HTTPS page that forwards OAuth redirects to this loopback server, for providers that
   * only accept HTTPS redirect URLs (Slack, Todoist). Used in local mode only.
   */
  OAUTH_RELAY_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default('common'),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  TODOIST_CLIENT_ID: z.string().optional(),
  TODOIST_CLIENT_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof schema> & { webOrigins: string[]; masterKey: Buffer };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const c = parsed.data;
  if (!c.MASTER_KEY) throw new Error('MASTER_KEY is required (32 random bytes, base64). Generate one with: pnpm --filter @secretary/server exec tsx src/genkey.ts');
  const masterKey = Buffer.from(c.MASTER_KEY, 'base64');
  if (masterKey.length !== 32) throw new Error('MASTER_KEY must decode to exactly 32 bytes');
  if (c.NODE_ENV === 'production' && !c.COOKIE_SECURE && !c.LOCAL_MODE) {
    throw new Error('COOKIE_SECURE must be true in production (serve the app over HTTPS)');
  }
  return { ...c, masterKey, webOrigins: c.WEB_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) };
}

export function oauthCredentials(c: Config, provider: string): { clientId: string; clientSecret: string; tenant?: string } | null {
  const pick = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : null);
  switch (provider) {
    case 'google':
      return pick(c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET);
    case 'microsoft':
      // A public client ("Mobile and desktop" platform) has no secret and relies on PKCE.
      return c.MICROSOFT_CLIENT_ID ? { clientId: c.MICROSOFT_CLIENT_ID, clientSecret: c.MICROSOFT_CLIENT_SECRET ?? '', tenant: c.MICROSOFT_TENANT } : null;
    case 'slack':
      return pick(c.SLACK_CLIENT_ID, c.SLACK_CLIENT_SECRET);
    case 'todoist':
      return pick(c.TODOIST_CLIENT_ID, c.TODOIST_CLIENT_SECRET);
    default:
      return null;
  }
}
