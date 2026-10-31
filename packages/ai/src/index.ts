import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import type { AIProvider, ProviderId } from './types.js';

export * from './types.js';
export * from './schema.js';
export * from './pricing.js';
export * from './defaults.js';
export { AnthropicProvider, OllamaProvider, OpenAIProvider };
export { DEFAULT_OLLAMA_URL, RECOMMENDED_LOCAL_MODELS, SLOW_LOCAL_MODELS, type OllamaModel } from './ollama.js';

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Registry of provider adapters. Add new vendors here. */
export function createProvider(cfg: ProviderConfig): AIProvider {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAIProvider(cfg);
    case 'anthropic':
      return new AnthropicProvider(cfg);
    case 'ollama':
      return new OllamaProvider({ baseURL: cfg.baseURL, timeoutMs: cfg.timeoutMs });
  }
}

export const PROVIDER_INFO: Record<ProviderId, { name: string; keyUrl: string; billingNote: string; keyPrefix: string }> = {
  ollama: {
    name: 'Local AI (Ollama)',
    keyUrl: 'https://ollama.com/download',
    keyPrefix: '',
    billingNote: 'Runs on your own computer with the free Ollama app. No account, no API key and no cost — your data never leaves the machine.',
  },
  openai: {
    name: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    billingNote:
      'Uses the OpenAI API, which is billed separately from ChatGPT Plus/Pro subscriptions. A ChatGPT subscription does not include API access.',
  },
  anthropic: {
    name: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    billingNote:
      'Uses the Claude API (Anthropic Console), which is billed separately from Claude Pro/Max subscriptions. A Claude subscription does not include API access.',
  },
};
