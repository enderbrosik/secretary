import type { ModelInfo, ProviderId } from './types.js';

/**
 * Preferred default models, in order. These are only used to pre-select a
 * model from the list the provider actually returns for the user's key —
 * nothing is hard-wired, and the user can choose any listed model.
 */
export const PREFERRED_MODELS: Record<ProviderId, RegExp[]> = {
  anthropic: [/^claude-opus-5-5$/, /^claude-sonnet-5-5$/, /^claude-opus-\d/, /^claude-sonnet-\d/, /^claude-/],
  openai: [/^gpt-5(\.\d+)?$/, /^gpt-5/, /^gpt-4\.1$/, /^gpt-4o$/, /^gpt-/],
  ollama: [/^qwen3:8b/, /^qwen3:/, /./],
};

/** Model families that cannot do chat-style text generation and are hidden from the picker. */
const OPENAI_NON_CHAT = /(embedding|whisper|tts|dall-e|image|audio|realtime|moderation|transcribe|search|computer-use|codex|davinci|babbage)/i;

export function filterChatModels(provider: ProviderId, models: ModelInfo[]): ModelInfo[] {
  if (provider === 'openai') return models.filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !OPENAI_NON_CHAT.test(m.id));
  return models;
}

export function pickDefaultModel(provider: ProviderId, models: ModelInfo[]): string | null {
  const usable = models.filter((m) => !m.deprecated);
  for (const re of PREFERRED_MODELS[provider]) {
    const hit = usable.filter((m) => re.test(m.id)).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
    if (hit) return hit.id;
  }
  return usable[0]?.id ?? models[0]?.id ?? null;
}
