import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { AIError, createProvider, estimateCostUsd, pickDefaultModel, toStrictJsonSchema } from '../src/index.js';

const schema = z.object({ summary: z.string(), refs: z.array(z.string()), note: z.string().nullable() });
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const noRetry = { 'retry-after-ms': '1' };

describe('schema conversion', () => {
  it('closes objects and requires every key', () => {
    const js = toStrictJsonSchema(schema) as any;
    expect(js.additionalProperties).toBe(false);
    expect(js.required).toEqual(['summary', 'refs', 'note']);
    expect(js.$schema).toBeUndefined();
  });
});

describe('Anthropic adapter', () => {
  // Construct lazily: SDKs capture global fetch at construction time, after MSW patches it.
  let p: ReturnType<typeof createProvider>;
  beforeAll(() => { p = createProvider({ provider: 'anthropic', apiKey: 'sk-ant-test-123456' }); });

  it('lists models, skipping retired ones', async () => {
    server.use(
      http.get('https://api.anthropic.com/v1/models', () =>
        HttpResponse.json({
          data: [
            { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', type: 'model', lifecycle: 'active' },
            { id: 'claude-old', display_name: 'Old', created_at: '2024-01-01T00:00:00Z', type: 'model', lifecycle: 'retired' },
          ],
          has_more: false,
          first_id: 'claude-opus-5-5',
          last_id: 'claude-old',
        }),
      ),
    );
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5-5']);
    expect(pickDefaultModel('anthropic', models)).toBe('claude-opus-5-5');
  });

  it('sends structured output config and validates JSON', async () => {
    let body: any;
    let headers: Headers | undefined;
    server.use(
      http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
        body = await request.json();
        headers = new Headers(request.headers);
        return HttpResponse.json({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: JSON.stringify({ summary: 'ok', refs: ['E1'], note: null }) }],
          usage: { input_tokens: 1200, output_tokens: 300 },
        });
      }),
    );
    const r = await p.generateJSON({ model: 'claude-opus-5-5', system: 'sys', user: 'u', schema, schemaName: 'x' });
    expect(r.data).toEqual({ summary: 'ok', refs: ['E1'], note: null });
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.temperature).toBeUndefined();
    expect(headers!.get('authorization') ?? headers!.get('x-api-key')).toMatch(/sk-ant-test-123456$/);
    expect(estimateCostUsd('anthropic', r.model, r.usage)).toBeCloseTo((1200 * 4 + 300 * 20) / 1e6);
  });

  it('maps 401 to invalid_key and never leaks the response body', async () => {
    server.use(http.post('https://api.anthropic.com/v1/messages', () => HttpResponse.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-test-123456' } }, { status: 401 })));
    const err = await p.generateJSON({ model: 'm', system: 's', user: 'u', schema, schemaName: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AIError);
    expect(err.code).toBe('invalid_key');
    expect(String(err.message)).not.toContain('sk-ant');
  });

  it('maps 429 to retryable rate_limited', async () => {
    p = createProvider({ provider: 'anthropic', apiKey: 'sk-ant-test-123456', maxRetries: 0 });
    let calls = 0;
    server.use(http.post('https://api.anthropic.com/v1/messages', () => { calls++; return HttpResponse.json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429, headers: noRetry }); }));
    const err = await p.generateJSON({ model: 'm', system: 's', user: 'u', schema, schemaName: 'x' }).catch((e) => e);
    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(calls).toBe(1);
  });

  it('rejects output that does not match the schema', async () => {
    server.use(http.post('https://api.anthropic.com/v1/messages', () => HttpResponse.json({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: '{"summary": 5}' }], usage: { input_tokens: 1, output_tokens: 1 },
    })));
    const err = await p.generateJSON({ model: 'm', system: 's', user: 'u', schema, schemaName: 'x' }).catch((e) => e);
    expect(err.code).toBe('invalid_output');
  });

  it('treats refusals as errors', async () => {
    server.use(http.post('https://api.anthropic.com/v1/messages', () => HttpResponse.json({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'refusal', stop_sequence: null, content: [], usage: { input_tokens: 1, output_tokens: 0 },
    })));
    const err = await p.generateJSON({ model: 'm', system: 's', user: 'u', schema, schemaName: 'x' }).catch((e) => e);
    expect(err.code).toBe('refused');
  });

  it('maps 5xx/overloaded to unavailable', async () => {
    p = createProvider({ provider: 'anthropic', apiKey: 'sk-ant-test-123456', maxRetries: 0 });
    server.use(http.post('https://api.anthropic.com/v1/messages', () => HttpResponse.json({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }, { status: 529, headers: noRetry })));
    const err = await p.generateJSON({ model: 'm', system: 's', user: 'u', schema, schemaName: 'x' }).catch((e) => e);
    expect(err.code).toBe('unavailable');
  });
});

describe('OpenAI adapter', () => {
  let p: ReturnType<typeof createProvider>;
  beforeAll(() => { p = createProvider({ provider: 'openai', apiKey: 'sk-test-abcdef123' }); });

  it('filters non-chat models and picks a default', async () => {
    server.use(http.get('https://api.openai.com/v1/models', () => HttpResponse.json({ object: 'list', data: [
      { id: 'gpt-5', object: 'model', created: 1750000000, owned_by: 'openai' },
      { id: 'text-embedding-3-large', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-4o', object: 'model', created: 1700000000, owned_by: 'openai' },
    ] })));
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-5']);
    expect(pickDefaultModel('openai', models)).toBe('gpt-5');
  });

  it('uses strict json_schema response format', async () => {
    let body: any;
    server.use(http.post('https://api.openai.com/v1/chat/completions', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-5', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: 'hi', refs: [], note: 'n' }), refusal: null } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }));
    const r = await p.generateJSON({ model: 'gpt-5', system: 's', user: 'u', schema, schemaName: 'briefing' });
    expect(r.data.summary).toBe('hi');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.max_completion_tokens).toBe(16000);
  });

  it('maps insufficient_quota to budget_exceeded', async () => {
    const p = createProvider({ provider: 'openai', apiKey: 'sk-test-abcdef123', maxRetries: 0 });
    server.use(http.post('https://api.openai.com/v1/chat/completions', () => HttpResponse.json({ error: { message: 'quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, { status: 429, headers: noRetry })));
    const err = await p.generateJSON({ model: 'gpt-5', system: 's', user: 'u', schema, schemaName: 'x' }).catch((e) => e);
    expect(err.code).toBe('budget_exceeded');
  });

  it('streams chat text', async () => {
    server.use(http.post('https://api.openai.com/v1/chat/completions', () => {
      const enc = new TextEncoder();
      const chunks = [
        { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-5', choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }] },
        { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-5', choices: [{ index: 0, delta: { content: 'there' }, finish_reason: 'stop' }] },
        { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-5', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      ];
      const stream = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`)); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } });
      return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
    }));
    const deltas: string[] = [];
    const r = await p.streamChat({ model: 'gpt-5', system: 's', messages: [{ role: 'user', content: 'hi' }], onText: (d) => deltas.push(d) });
    expect(r.text).toBe('Hello there');
    expect(deltas).toEqual(['Hello ', 'there']);
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });
});
