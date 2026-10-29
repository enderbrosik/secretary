import { randomBytes } from 'node:crypto';
import { migrateDatabase, openDatabase, type DatabaseHandle } from '@secretary/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Deps } from '../src/lib/context.js';

export interface TestApp {
  app: FastifyInstance;
  deps: Deps;
  handle: DatabaseHandle;
  clock: { now: Date };
  close(): Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}, start = new Date('2026-10-29T12:00:00Z')): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    MASTER_KEY: randomBytes(32).toString('base64'),
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'pglite:memory',
    PUBLIC_URL: 'http://localhost:8787',
    APP_URL: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    JOBS_ENABLED: 'false',
    ...env,
  } as NodeJS.ProcessEnv);
  const handle = await openDatabase(config.DATABASE_URL);
  await migrateDatabase(handle);
  const clock = { now: start };
  const { app, deps } = await buildApp({ config, db: handle.db, now: () => clock.now, logger: false });
  await app.ready();
  return { app, deps, handle, clock, close: async () => { await app.close(); await handle.close(); } };
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
  headers: Record<string, string>;
}

let n = 0;
export async function signup(t: TestApp, opts: { email?: string; timezone?: string } = {}): Promise<Session> {
  const email = opts.email ?? `user${++n}-${Date.now()}@example.com`;
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'correct horse battery', displayName: 'Alex Rivera', timezone: opts.timezone ?? 'America/New_York' } });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const body = res.json();
  return { cookie, csrf: body.csrfToken, userId: body.user.id, headers: { cookie, 'x-csrf-token': body.csrfToken } };
}

export async function completeOnboarding(t: TestApp, s: Session) {
  await t.app.inject({ method: 'PATCH', url: '/api/settings', headers: s.headers, payload: { onboardingCompleted: true } });
}
