import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { AIProvider, ProviderId } from './types.js';

export * from './types.js';
export * from './schema.js';
export * from './pricing.js';
export * from './defaults.js';
export { AnthropicProvider, OpenAIProvider };

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
  }
}

export const PROVIDER_INFO: Record<ProviderId, { name: string; keyUrl: string; billingNote: string; keyPrefix: string }> = {
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
