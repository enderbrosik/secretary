import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { setProviderFactory } from '../src/services/ai.js';
import { createProvider } from '@secretary/ai';
import { createTestApp, signup, type Session, type TestApp } from './helpers.js';

const O = 'http://127.0.0.1:11434';
const mock = setupServer();
let t: TestApp;
let s: Session;
let installed: { name: string; size: number }[] = [];

beforeAll(async () => {
  mock.listen({ onUnhandledRequest: 'bypass' });
  t = await createTestApp();
  s = await signup(t);
  setProviderFactory((provider, apiKey) => createProvider({ provider, apiKey, baseURL: provider === 'ollama' ? O : undefined }));
});
afterEach(() => mock.resetHandlers());
afterAll(async () => { mock.close(); await t.close(); });

const api = (method: string, url: string, payload?: object) => t.app.inject({ method: method as 'GET', url, headers: s.headers, payload });
const ollamaUp = () =>
  mock.use(
    http.get(`${O}/api/version`, () => HttpResponse.json({ version: '0.12.0' })),
    http.get(`${O}/api/tags`, () => HttpResponse.json({ models: installed })),
    http.post(`${O}/api/pull`, () => {
      installed = [{ name: 'qwen3:4b', size: 2_500_000_000 }];
      return new HttpResponse(['{"status":"pulling manifest"}', '{"status":"downloading","total":10,"completed":5}', '{"status":"success","total":10,"completed":10}'].join('\n') + '\n');
    }),
    http.delete(`${O}/api/delete`, () => { installed = []; return new HttpResponse(null, { status: 200 }); }),
    http.post(`${O}/api/chat`, () => HttpResponse.json({ model: 'qwen3:4b', message: { content: '{"overview":"Local summary.","priorities":[],"emails":[],"meetings":[],"messages":[],"tips":[],"suggestedTasks":[],"suspiciousRefs":[]}' }, prompt_eval_count: 1, eval_count: 1 })),
  );

describe('local AI (Ollama)', () => {
  it('reports when Ollama is not running', async () => {
    mock.use(http.get(`${O}/api/version`, () => HttpResponse.error()));
    const r = (await api('GET', '/api/ai/local/status')).json();
    expect(r).toMatchObject({ running: false, installed: [], inUse: null });
    expect(r.recommended.map((m: { id: string }) => m.id)).toEqual(['qwen3:4b', 'qwen3:8b']);
  });

  it('downloads only recommended models, with streamed progress', async () => {
    ollamaUp();
    expect((await api('POST', '/api/ai/local/pull', { model: 'some/huge-model:405b' })).statusCode).toBe(400);
    const r = await api('POST', '/api/ai/local/pull', { model: 'qwen3:4b' });
    const lines = r.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.fraction ?? (l.done ? 'done' : null))).toEqual([null, 0.5, 1, 'done']);
    expect((await api('GET', '/api/ai/local/status')).json().installed).toEqual([{ name: 'qwen3:4b', diskGB: 2.5 }]);
  });

  it('switches to the local model and the briefing uses it, at zero cost', async () => {
    ollamaUp();
    expect((await api('POST', '/api/ai/local/use', { model: 'qwen3:8b' })).statusCode).toBe(409); // not downloaded
    expect((await api('POST', '/api/ai/local/use', { model: 'qwen3:4b' })).json()).toEqual({ ok: true, model: 'qwen3:4b' });
    const b = (await api('POST', '/api/briefings/generate')).json().briefing;
    expect(b.mode).toBe('ai');
    expect(b.model).toBe('qwen3:4b');
    expect(b.overview.summary).toBe('Local summary.');
    const usage = (await api('GET', '/api/ai/usage')).json();
    expect(usage.monthToDateUsd).toBe(0);
  });

  it('deleting the model frees it and turns local AI off (briefings fall back to rules)', async () => {
    ollamaUp();
    expect((await api('DELETE', '/api/ai/local/models/qwen3%3A4b')).statusCode).toBe(200);
    const st = (await api('GET', '/api/ai/local/status')).json();
    expect(st.installed).toEqual([]);
    expect(st.inUse).toBeNull();
    const b = (await api('POST', '/api/briefings/generate')).json().briefing;
    expect(b.mode).toBe('rules');
  });
});
