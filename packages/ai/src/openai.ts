import OpenAI from 'openai';
import { AIError, type AIProvider, type GenerateJSONRequest, type GenerateJSONResult, type ModelInfo, type StreamChatRequest, type StreamChatResult } from './types.js';
import { extractJson, toStrictJsonSchema } from './schema.js';
import { filterChatModels } from './defaults.js';

export function mapOpenAIError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof OpenAI.AuthenticationError) return new AIError('invalid_key', 'Invalid OpenAI API key');
  if (err instanceof OpenAI.PermissionDeniedError) return new AIError('permission_denied', 'Permission denied');
  if (err instanceof OpenAI.NotFoundError) return new AIError('model_not_found', 'Model not found');
  if (err instanceof OpenAI.RateLimitError) {
    // insufficient_quota is a billing problem, not a transient limit
    const code = (err as { code?: string }).code;
    return code === 'insufficient_quota' ? new AIError('budget_exceeded', 'OpenAI quota exhausted') : new AIError('rate_limited', 'Rate limited', true);
  }
  if (err instanceof OpenAI.BadRequestError) return new AIError('bad_request', 'Bad request');
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new AIError('timeout', 'Timed out', true);
  if (err instanceof OpenAI.InternalServerError) return new AIError('unavailable', 'Provider error', true);
  if (err instanceof OpenAI.APIConnectionError) return new AIError('unavailable', 'Connection failed', true);
  if (err instanceof OpenAI.APIError) return (err.status ?? 0) >= 500 ? new AIError('unavailable', 'Provider error', true) : new AIError('bad_request', `Provider error ${err.status}`);
  return new AIError('unavailable', 'Unexpected AI provider error', true);
}

export interface OpenAIOptions {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  private client: OpenAI;

  constructor(opts: OpenAIOptions) {
    // Explicit values so ambient OPENAI_* env vars are never used with the user's key.
    this.client = new OpenAI({ apiKey: opts.apiKey, organization: null, project: null, baseURL: opts.baseURL ?? 'https://api.openai.com/v1', timeout: opts.timeoutMs ?? 120_000, maxRetries: opts.maxRetries ?? 2 });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = [];
      for await (const m of this.client.models.list()) {
        out.push({ id: m.id, displayName: m.id, createdAt: m.created ? new Date(m.created * 1000).toISOString() : null, deprecated: false });
      }
      return filterChatModels('openai', out).sort((a, b) => a.id.localeCompare(b.id));
    } catch (e) {
      throw mapOpenAIError(e);
    }
  }

  async generateJSON<T>(req: GenerateJSONRequest<T>): Promise<GenerateJSONResult<T>> {
    const schema = toStrictJsonSchema(req.schema);
    let resp: OpenAI.Chat.Completions.ChatCompletion;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ];
    try {
      resp = await this.client.chat.completions.create(
        {
          model: req.model,
          messages,
          max_completion_tokens: req.maxTokens ?? 16000,
          response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema } },
        },
        { signal: req.signal },
      );
    } catch (e) {
      if (e instanceof OpenAI.BadRequestError && /response_format|json_schema/i.test(e.message)) {
        try {
          resp = await this.client.chat.completions.create(
            {
              model: req.model,
              messages: [{ role: 'system', content: `${req.system}\n\nReturn ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` }, messages[1]!],
              max_completion_tokens: req.maxTokens ?? 16000,
              response_format: { type: 'json_object' },
            },
            { signal: req.signal },
          );
        } catch (e2) {
          throw mapOpenAIError(e2);
        }
      } else throw mapOpenAIError(e);
    }
    const choice = resp.choices[0];
    if (!choice) throw new AIError('invalid_output', 'Empty response', true);
    if (choice.message.refusal) throw new AIError('refused', 'Request declined by provider');
    if (choice.finish_reason === 'length') throw new AIError('invalid_output', 'Response was truncated', true);
    let parsed: unknown;
    try {
      parsed = extractJson(choice.message.content ?? '');
    } catch {
      throw new AIError('invalid_output', 'Response was not valid JSON', true);
    }
    const result = req.schema.safeParse(parsed);
    if (!result.success) throw new AIError('invalid_output', 'Response did not match the expected schema', true);
    return {
      data: result.data,
      usage: { inputTokens: resp.usage?.prompt_tokens ?? 0, outputTokens: resp.usage?.completion_tokens ?? 0 },
      model: resp.model,
    };
  }

  async streamChat(req: StreamChatRequest): Promise<StreamChatResult> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: req.model,
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: req.maxTokens ?? 8000,
          messages: [{ role: 'system', content: req.system }, ...req.messages],
        },
        { signal: req.signal },
      );
      let text = '';
      let usage = { inputTokens: 0, outputTokens: 0 };
      let model = req.model;
      for await (const chunk of stream) {
        model = chunk.model || model;
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          text += delta;
          req.onText(delta);
        }
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
      return { text, usage, model };
    } catch (e) {
      throw mapOpenAIError(e);
    }
  }
}
