import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { AIError, createProvider, estimateCostUsd, OllamaProvider, pickDefaultModel } from '../src/index.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const B = 'http://127.0.0.1:11434';
const ndjson = (lines: object[]) => new HttpResponse(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });

describe('Ollama (local AI)', () => {
  it('lists installed models with sizes and treats them as free', async () => {
    server.use(http.get(`${B}/api/tags`, () => HttpResponse.json({ models: [{ name: 'qwen3:4b-instruct', size: 2_600_000_000, modified_at: '2026-10-01T00:00:00Z' }] })));
    const p = new OllamaProvider();
    expect((await p.installedModels())[0]).toMatchObject({ name: 'qwen3:4b-instruct', sizeBytes: 2_600_000_000 });
    const models = await p.listModels();
    expect(pickDefaultModel('ollama', models)).toBe('qwen3:4b-instruct');
    expect(estimateCostUsd('ollama', 'qwen3:4b-instruct', { inputTokens: 9999, outputTokens: 9999 })).toBe(0);
  });

  it('sends a JSON schema, a large context window and no thinking; validates the output', async () => {
    let body: any;
    server.use(http.post(`${B}/api/chat`, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ model: 'qwen3:4b-instruct', message: { content: '<think>{not json}</think>{"summary":"ok","n":2}' }, prompt_eval_count: 900, eval_count: 40, done_reason: 'stop' });
    }));
    const p = createProvider({ provider: 'ollama', apiKey: '' });
    const r = await p.generateJSON({ model: 'qwen3:4b-instruct', system: 's', user: 'u', schema: z.object({ summary: z.string(), n: z.number() }), schemaName: 'x' });
    expect(r.data).toEqual({ summary: 'ok', n: 2 });
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 40 });
    expect(body.format.type).toBe('object');
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(16384);
    expect(body.think).toBe(false);
    expect(body.stream).toBe(false);
  });

  it('reports "not running" clearly when Ollama is not reachable', async () => {
    const p = new OllamaProvider({ baseURL: 'http://127.0.0.1:1' });
    expect(await p.version()).toBeNull();
    const err = await p.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(AIError);
    expect(err.code).toBe('unavailable');
  });

  it('maps a missing model to model_not_found and rejects invalid JSON', async () => {
    server.use(http.post(`${B}/api/chat`, () => HttpResponse.json({ error: 'model not found' }, { status: 404 })));
    const p = new OllamaProvider();
    const schema = z.object({ a: z.string() });
    expect((await p.generateJSON({ model: 'nope', system: '', user: '', schema, schemaName: 'x' }).catch((e) => e)).code).toBe('model_not_found');
    server.use(http.post(`${B}/api/chat`, () => HttpResponse.json({ message: { content: 'sorry, here you go: {broken' } })));
    expect((await p.generateJSON({ model: 'm', system: '', user: '', schema, schemaName: 'x' }).catch((e) => e)).code).toBe('invalid_output');
  });

  it('streams chat and model downloads', async () => {
    server.use(
      http.post(`${B}/api/chat`, () => ndjson([{ message: { content: 'Hel' } }, { message: { content: 'lo' } }, { done: true, prompt_eval_count: 5, eval_count: 2 }])),
      http.post(`${B}/api/pull`, () => ndjson([{ status: 'pulling manifest' }, { status: 'downloading', total: 100, completed: 50 }, { status: 'success', total: 100, completed: 100 }])),
    );
    const p = new OllamaProvider();
    const deltas: string[] = [];
    const r = await p.streamChat({ model: 'qwen3:4b-instruct', system: 's', messages: [{ role: 'user', content: 'hi' }], onText: (d) => deltas.push(d) });
    expect(r.text).toBe('Hello');
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    const progress: (number | null)[] = [];
    await p.pull('qwen3:4b-instruct', (x) => progress.push(x.fraction));
    expect(progress).toEqual([null, 0.5, 1]);
  });
});
