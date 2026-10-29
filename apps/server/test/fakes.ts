import { AIError, type AIProvider, type GenerateJSONRequest } from '@secretary/ai';

/** Scriptable AI provider for integration tests (never calls a network). */
export class FakeProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  calls: { system: string; user: string }[] = [];
  constructor(public behavior: { json?: (req: GenerateJSONRequest<unknown>) => unknown; error?: AIError; chat?: string; models?: string[] } = {}) {}
  async listModels() {
    if (this.behavior.error) throw this.behavior.error;
    return (this.behavior.models ?? ['claude-opus-5-5']).map((id) => ({ id, displayName: id, createdAt: null, deprecated: false }));
  }
  async generateJSON<T>(req: GenerateJSONRequest<T>) {
    this.calls.push({ system: req.system, user: req.user });
    if (this.behavior.error) throw this.behavior.error;
    const out = this.behavior.json!(req as GenerateJSONRequest<unknown>);
    const parsed = req.schema.safeParse(out);
    if (!parsed.success) throw new AIError('invalid_output', 'bad');
    return { data: parsed.data, usage: { inputTokens: 1000, outputTokens: 200 }, model: req.model };
  }
  async streamChat(req: { onText: (d: string) => void; system: string; model: string }) {
    this.calls.push({ system: req.system, user: '' });
    if (this.behavior.error) throw this.behavior.error;
    const text = this.behavior.chat ?? 'Hello';
    for (const part of text.split(/(?<= )/)) req.onText(part);
    return { text, usage: { inputTokens: 10, outputTokens: 5 }, model: req.model };
  }
}
