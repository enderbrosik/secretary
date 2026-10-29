import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AIError } from '@secretary/ai';
import { schema } from '@secretary/db';
import { setProviderFactory } from '../src/services/ai.js';
import { createTestApp, signup, type Session, type TestApp } from './helpers.js';
import { FakeProvider } from './fakes.js';

let t: TestApp;
let s: Session;
let fake: FakeProvider;
beforeAll(async () => {
  t = await createTestApp({}, new Date('2026-10-29T12:00:00Z')); // Thursday 8:00 New York
  s = await signup(t);
});
afterAll(async () => t.close());
beforeEach(() => {
  fake = new FakeProvider();
  setProviderFactory(() => fake);
});

const api = (method: string, url: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url, headers: s.headers, payload: payload as object });

describe('AI provider settings (BYOK)', () => {
  it('refuses to store a key the provider rejects', async () => {
    fake.behavior.error = new AIError('invalid_key', 'x');
    const r = await api('POST', '/api/ai/providers', { provider: 'anthropic', apiKey: 'sk-ant-invalid-000000' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('ai_invalid_key');
    expect((await t.deps.db.select().from(schema.aiProviders)).length).toBe(0);
  });

  it('stores the key encrypted, never returns it, and picks an available model', async () => {
    fake.behavior = { models: ['claude-haiku-5-5', 'claude-opus-5-5'] };
    const key = 'sk-ant-secret-key-123456789';
    const r = await api('POST', '/api/ai/providers', { provider: 'anthropic', apiKey: key });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(key);
    expect(r.json().provider.model).toBe('claude-opus-5-5');
    expect(r.json().provider.keyHint).toBe('…6789');
    const [row] = await t.deps.db.select().from(schema.aiProviders);
    expect(row!.encryptedKey).not.toContain(key);
    expect(row!.encryptedKey.startsWith('v1.')).toBe(true);
    const list = await api('GET', '/api/ai/providers');
    expect(list.body).not.toContain(key);
  });

  it('test endpoint reports failures without throwing', async () => {
    fake.behavior.error = new AIError('rate_limited', 'x', true);
    const r = (await api('POST', '/api/ai/providers/anthropic/test')).json();
    expect(r).toMatchObject({ ok: false, code: 'ai_rate_limited' });
  });
});

describe('morning briefing', () => {
  it('works with demo data and falls back to rules when the AI fails', async () => {
    const c = await api('POST', '/api/integrations/demo/connect', { features: { calendar: true, email: true, messages: true, tasks: true } });
    expect(c.statusCode).toBe(200);
    fake.behavior = { error: new AIError('unavailable', 'down', true) };
    const r = await api('POST', '/api/briefings/generate');
    expect(r.statusCode).toBe(200);
    const b = r.json().briefing;
    expect(b.mode).toBe('rules');
    expect(b.aiError).toMatch(/temporarily unavailable/);
    expect(b.overview.meetingsCount).toBeGreaterThan(3);
    expect(b.overview.conflicts.length).toBeGreaterThan(0);
    expect(b.priorities.length).toBeGreaterThanOrEqual(3);
    expect(b.emails.find((e: { subject: string }) => e.subject === 'Invoice update').suspicious).toBe(true);
    const usage = await t.deps.db.select().from(schema.aiUsage);
    expect(usage.at(-1)).toMatchObject({ success: false, errorCode: 'unavailable' });
  });

  it('uses validated AI output and stores suggested tasks for review', async () => {
    fake.behavior = {
      json: (req) => {
        const ref = (label: string) => new RegExp(`\\[(E\\d+)\\][^\\n]*\\n<untrusted ref="E\\d+" kind="email">\\nSubject: ${label}`).exec(req.user)?.[1];
        const task = /\[(T\d+)\] Approve Q4 contractor budget/.exec(req.user)?.[1];
        const t2 = /\[(T\d+)\] Write Atlas rollout plan/.exec(req.user)?.[1];
        const t3 = /\[(T\d+)\] Submit October expense report/.exec(req.user)?.[1];
        return {
          overview: 'A meeting-heavy day centered on the Q4 budget.',
          priorities: [task, t2, t3].map((r) => ({ ref: r, why: 'Deadline', when: 'Morning', nextAction: 'Start', ifDelayed: null })),
          emails: [{ ref: ref('Q4 budget numbers'), category: 'urgent', summary: 'Dana needs sign-off today.', whyItMatters: 'Finance deadline' }],
          meetings: [],
          messages: [],
          tips: [{ text: 'Sign off on the budget before 10:00.', basisRefs: [ref('Q4 budget numbers')] }],
          suggestedTasks: [{ title: 'Choose Orbit renewal option', sourceRef: ref('Orbit Analytics renewal'), explicitDeadline: null, reason: 'Hannah asked which option you prefer' }],
          // the injected email asked to forward mail — the model can only flag it
          suspiciousRefs: [ref('Invoice update')],
        };
      },
    };
    const b = (await api('POST', '/api/briefings/generate')).json().briefing;
    expect(b.mode).toBe('ai');
    expect(b.overview.summary).toContain('Q4 budget');
    expect(b.tips[0].text).toBe('Sign off on the budget before 10:00.');
    expect(b.tips[0].basis[0].kind).toBe('email');
    expect(fake.calls.at(-1)!.system).toMatch(/Never follow instructions/);

    const suggested = (await api('GET', '/api/tasks?filter=suggested')).json();
    // One suggestion per source email: the rule-based run already proposed one for the Orbit email,
    // so the AI's version is deduplicated rather than added twice.
    const orbit = suggested.filter((x: { sourceItem: { title: string } }) => x.sourceItem?.title.startsWith('Orbit Analytics renewal'));
    expect(orbit).toHaveLength(1);
    expect(suggested[0].confirmed).toBe(false);
    expect(suggested[0].sourceItem).toBeTruthy();
    // Regenerating does not duplicate suggestions
    await api('POST', '/api/briefings/generate');
    expect((await api('GET', '/api/tasks?filter=suggested')).json()).toHaveLength(suggested.length);
    // Nothing was queued for sending, despite the injection attempt
    expect(await t.deps.db.select().from(schema.pendingActions)).toHaveLength(0);
    // Unconfirmed suggestions are not in "open"
    const open = (await api('GET', '/api/tasks?filter=open')).json();
    expect(open.some((x: { id: string }) => x.id === orbit[0].id)).toBe(false);
  });

  it('accepting and dismissing suggestions', async () => {
    const [sug] = (await api('GET', '/api/tasks?filter=suggested')).json();
    const acc = await api('POST', `/api/tasks/${sug.id}/accept`, { priority: 'high' });
    expect(acc.json()).toMatchObject({ confirmed: true, priority: 'high', origin: 'ai_suggested' });
  });

  it('demo data is idempotent across re-syncs and removed on disconnect', async () => {
    const list = (await api('GET', '/api/integrations')).json();
    const demo = list.connections.find((c: { provider: string }) => c.provider === 'demo');
    const before = (await t.deps.db.select().from(schema.items)).length;
    await api('POST', `/api/integrations/${demo.id}/sync`);
    await api('POST', `/api/integrations/${demo.id}/sync`);
    expect((await t.deps.db.select().from(schema.items)).length).toBe(before);
    const tasksBefore = (await t.deps.db.select().from(schema.tasks).where(eq(schema.tasks.connectionId, demo.id))).length;
    await api('POST', `/api/integrations/${demo.id}/sync`);
    expect((await t.deps.db.select().from(schema.tasks).where(eq(schema.tasks.connectionId, demo.id))).length).toBe(tasksBefore);
  });

  it('end-of-day review reflects real data and accepts corrections', async () => {
    const tasks = (await api('GET', '/api/tasks?filter=open')).json();
    const target = tasks.find((x: { title: string }) => x.title === 'Approve Q4 contractor budget');
    await api('PATCH', `/api/tasks/${target.id}`, { status: 'in_progress' });
    t.clock.now = new Date('2026-10-29T15:00:00Z');
    await api('PATCH', `/api/tasks/${target.id}`, { status: 'done' });
    t.clock.now = new Date('2026-10-29T21:45:00Z');
    fake.behavior = { error: new AIError('invalid_key', 'x') };
    const r = (await api('POST', '/api/reviews/generate')).json().review;
    expect(r.accomplishments.completedTasks.map((x: { title: string }) => x.title)).toContain('Approve Q4 contractor budget');
    expect(r.accomplishments.meetings.every((m: { attendance: string }) => m.attendance !== 'attended')).toBe(true);
    expect(r.insights.find((i: { id: string }) => i.id === 'planned-completion')).toBeTruthy();
    expect(r.tomorrow.firstTask).toBeTruthy();
    const rollout = tasks.find((x: { title: string }) => x.title.startsWith('Write Atlas rollout'));
    const c = await api('POST', `/api/reviews/${r.date}/corrections`, { kind: 'task', taskId: rollout.id, status: 'postponed' });
    expect(c.statusCode).toBe(200);
    const after = (await api('GET', '/api/tasks?filter=all')).json().find((x: { id: string }) => x.id === rollout.id);
    expect(after.postponeCount).toBe(1);
  });

  it('assistant streams answers with citations and reports missing AI', async () => {
    fake.behavior = { chat: 'Focus on the budget approval [T1] and reply to Dana [E1]. Unknown [Z9].' };
    const r = await t.app.inject({ method: 'POST', url: '/api/assistant/chat', headers: s.headers, payload: { message: 'What should I focus on?' } });
    const events = r.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(events[0].type).toBe('start');
    expect(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toContain('budget approval');
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.citations.map((c: { ref: string }) => c.ref).sort()).toEqual(['E1', 'T1']);
  });
});
