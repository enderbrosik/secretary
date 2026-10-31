import { AIError, type AIProvider, type GenerateJSONRequest, type GenerateJSONResult, type ModelInfo, type StreamChatRequest, type StreamChatResult } from './types.js';
import { extractJson, toStrictJsonSchema } from './schema.js';

/**
 * Local models through Ollama (https://ollama.com): no account, no key, no cost.
 * Uses Ollama's native API rather than its OpenAI-compatible one, because only the
 * native API lets us raise the context window (Ollama's default is too small for a
 * briefing) and pass a JSON schema for structured output.
 */
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/** Curated models offered in the UI, sized for typical laptops/desktops. */
export const RECOMMENDED_LOCAL_MODELS = [
  { id: 'qwen3:4b-instruct', name: 'Qwen3 4B', diskGB: 2.5, minRamGB: 8, note: 'Fast and light. Answers right away, with no long “thinking”.' },
  { id: 'qwen3:8b', name: 'Qwen3 8B', diskGB: 5.2, minRamGB: 16, note: 'Smarter prioritization, meeting prep and chat.' },
] as const;

/**
 * Models that always "think" before answering, whatever the request says. Ollama's plain
 * `qwen3:4b` tag is the thinking-only 2507 release, so it's replaced by the instruct one.
 */
export const SLOW_LOCAL_MODELS: Record<string, string> = {
  'qwen3:4b': 'qwen3:4b-instruct',
  'qwen3:4b-thinking': 'qwen3:4b-instruct',
};

const CONTEXT_TOKENS = 16_384;

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  modifiedAt: string | null;
}

export class OllamaProvider implements AIProvider {
  readonly id = 'ollama' as const;
  private base: string;
  private timeoutMs: number;

  constructor(opts: { baseURL?: string; timeoutMs?: number } = {}) {
    this.base = (opts.baseURL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
    // Local generation is slower than hosted APIs, especially on first load.
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  private async call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs) });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') throw new AIError('timeout', 'The local model took too long to respond', true);
      if ((e as Error).name === 'AbortError') throw e;
      throw new AIError('unavailable', 'Ollama is not running', true);
    }
    if (res.status === 404) throw new AIError('model_not_found', 'Model is not downloaded');
    if (!res.ok) throw new AIError(res.status >= 500 ? 'unavailable' : 'bad_request', `Ollama error (${res.status})`, res.status >= 500);
    return res;
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.call('/api/version', { timeoutMs: 3000 });
      return ((await r.json()) as { version?: string }).version ?? 'unknown';
    } catch {
      return null;
    }
  }

  async installedModels(): Promise<OllamaModel[]> {
    const r = await this.call('/api/tags', { timeoutMs: 5000 });
    const body = (await r.json()) as { models?: { name: string; size?: number; modified_at?: string }[] };
    return (body.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size ?? 0, modifiedAt: m.modified_at ?? null }));
  }

  async listModels(): Promise<ModelInfo[]> {
    return (await this.installedModels()).map((m) => ({ id: m.name, displayName: m.name, createdAt: m.modifiedAt, deprecated: false, pricing: { input: 0, output: 0 } }));
  }

  /** Downloads a model, reporting progress (0–1). */
  async pull(model: string, onProgress: (p: { status: string; fraction: number | null }) => void, signal?: AbortSignal): Promise<void> {
    const r = await this.call('/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: true }), signal, timeoutMs: 60 * 60_000 });
    await readNdjson(r, (line: { status?: string; total?: number; completed?: number; error?: string }) => {
      if (line.error) throw new AIError('unavailable', 'Download failed');
      onProgress({ status: line.status ?? '', fraction: line.total ? (line.completed ?? 0) / line.total : null });
    });
  }

  async remove(model: string): Promise<void> {
    await this.call('/api/delete', { method: 'DELETE', body: JSON.stringify({ model }), timeoutMs: 30_000 });
  }

  async generateJSON<T>(req: GenerateJSONRequest<T>): Promise<GenerateJSONResult<T>> {
    const schema = toStrictJsonSchema(req.schema);
    const r = await this.call('/api/chat', {
      method: 'POST',
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        stream: false,
        think: false,
        format: schema,
        options: { num_ctx: CONTEXT_TOKENS, temperature: 0.2 },
        messages: [
          { role: 'system', content: `${req.system}\n\nReturn ONLY a JSON object matching the provided schema.` },
          { role: 'user', content: req.user },
        ],
      }),
    });
    const body = (await r.json()) as { model?: string; message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
    if (body.done_reason === 'length') throw new AIError('invalid_output', 'Response was truncated', true);
    let parsed: unknown;
    try {
      parsed = extractJson(body.message?.content ?? '');
    } catch {
      throw new AIError('invalid_output', 'Response was not valid JSON', true);
    }
    const result = req.schema.safeParse(parsed);
    if (!result.success) throw new AIError('invalid_output', 'Response did not match the expected schema', true);
    return { data: result.data, usage: { inputTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 }, model: body.model ?? req.model };
  }

  async streamChat(req: StreamChatRequest): Promise<StreamChatResult> {
    const r = await this.call('/api/chat', {
      method: 'POST',
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        stream: true,
        think: false,
        options: { num_ctx: CONTEXT_TOKENS },
        messages: [{ role: 'system', content: req.system }, ...req.messages],
      }),
    });
    let text = '';
    let usage = { inputTokens: 0, outputTokens: 0 };
    await readNdjson(r, (c: { message?: { content?: string }; done?: boolean; prompt_eval_count?: number; eval_count?: number }) => {
      const d = c.message?.content;
      if (d) {
        text += d;
        req.onText(d);
      }
      if (c.done) usage = { inputTokens: c.prompt_eval_count ?? 0, outputTokens: c.eval_count ?? 0 };
    });
    return { text, usage, model: req.model };
  }
}

async function readNdjson<T>(res: Response, onLine: (v: T) => void): Promise<void> {
  if (!res.body) return;
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
      if (line) onLine(JSON.parse(line) as T);
    }
  }
  if (buf.trim()) onLine(JSON.parse(buf) as T);
}
