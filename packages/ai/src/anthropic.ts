import Anthropic from '@anthropic-ai/sdk';
import { AIError, type AIProvider, type GenerateJSONRequest, type GenerateJSONResult, type ModelInfo, type StreamChatRequest, type StreamChatResult } from './types.js';
import { extractJson, toStrictJsonSchema } from './schema.js';

export function mapAnthropicError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AIError('invalid_key', 'Invalid Anthropic API key');
  if (err instanceof Anthropic.PermissionDeniedError) return new AIError('permission_denied', 'Permission denied');
  if (err instanceof Anthropic.NotFoundError) return new AIError('model_not_found', 'Model not found');
  if (err instanceof Anthropic.RateLimitError) return new AIError('rate_limited', 'Rate limited', true);
  if (err instanceof Anthropic.BadRequestError) return new AIError('bad_request', 'Bad request');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AIError('timeout', 'Timed out', true);
  if (err instanceof Anthropic.InternalServerError) return new AIError('unavailable', 'Provider error', true);
  if (err instanceof Anthropic.APIConnectionError) return new AIError('unavailable', 'Connection failed', true);
  if (err instanceof Anthropic.APIError) {
    return err.status === 529 || (err.status ?? 0) >= 500 ? new AIError('unavailable', 'Provider overloaded', true) : new AIError('bad_request', `Provider error ${err.status}`);
  }
  return new AIError('unavailable', 'Unexpected AI provider error', true);
}

export interface AnthropicOptions {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  private client: Anthropic;

  constructor(opts: AnthropicOptions) {
    // Explicit baseURL/authToken so ambient env credentials (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
    // on-disk profiles) are never used in place of, or alongside, the user's own key.
    this.client = new Anthropic({ apiKey: opts.apiKey, authToken: null, baseURL: opts.baseURL ?? 'https://api.anthropic.com', timeout: opts.timeoutMs ?? 120_000, maxRetries: opts.maxRetries ?? 2 });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = [];
      for await (const m of this.client.models.list({ limit: 100 })) {
        const lifecycle = (m as { lifecycle?: string }).lifecycle;
        if (lifecycle === 'retired') continue;
        out.push({ id: m.id, displayName: m.display_name, createdAt: m.created_at ?? null, deprecated: lifecycle === 'deprecated' });
      }
      return out;
    } catch (e) {
      throw mapAnthropicError(e);
    }
  }

  async generateJSON<T>(req: GenerateJSONRequest<T>): Promise<GenerateJSONResult<T>> {
    const schema = toStrictJsonSchema(req.schema);
    const base = {
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: 'user' as const, content: req.user }],
    };
    let resp: Anthropic.Message;
    try {
      resp = await this.client.messages.create(
        { ...base, output_config: { format: { type: 'json_schema', schema } } },
        { signal: req.signal },
      );
    } catch (e) {
      // Older models without structured-output support: fall back to instructed JSON + validation.
      if (e instanceof Anthropic.BadRequestError && /output_config|format|schema/i.test(e.message)) {
        try {
          resp = await this.client.messages.create(
            { ...base, system: `${req.system}\n\nReturn ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` },
            { signal: req.signal },
          );
        } catch (e2) {
          throw mapAnthropicError(e2);
        }
      } else throw mapAnthropicError(e);
    }
    if (resp.stop_reason === 'refusal') throw new AIError('refused', 'Request declined by provider');
    if (resp.stop_reason === 'max_tokens') throw new AIError('invalid_output', 'Response was truncated', true);
    const text = resp.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      throw new AIError('invalid_output', 'Response was not valid JSON', true);
    }
    const result = req.schema.safeParse(parsed);
    if (!result.success) throw new AIError('invalid_output', 'Response did not match the expected schema', true);
    return { data: result.data, usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens }, model: resp.model };
  }

  async streamChat(req: StreamChatRequest): Promise<StreamChatResult> {
    try {
      const stream = this.client.messages.stream(
        { model: req.model, max_tokens: req.maxTokens ?? 8000, system: req.system, messages: req.messages },
        { signal: req.signal },
      );
      let text = '';
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          req.onText(ev.delta.text);
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') throw new AIError('refused', 'Request declined by provider');
      return { text, usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens }, model: final.model };
    } catch (e) {
      throw mapAnthropicError(e);
    }
  }
}
