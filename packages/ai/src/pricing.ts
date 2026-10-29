import type { ProviderId, Usage } from './types.js';

/**
 * Estimated list prices in USD per million tokens, used only to show cost
 * estimates and enforce the user's optional monthly budget. Prices change;
 * users can override them per provider in Settings → AI. Unknown models
 * return null (no estimate) rather than a guess.
 */
const PRICES: Array<{ provider: ProviderId; match: RegExp; input: number; output: number }> = [
  { provider: 'anthropic', match: /^claude-fable-5/, input: 10, output: 50 },
  { provider: 'anthropic', match: /^claude-opus-5-5/, input: 4, output: 20 },
  { provider: 'anthropic', match: /^claude-opus-(5|4-[5-8])/, input: 5, output: 25 },
  { provider: 'anthropic', match: /^claude-sonnet-5/, input: 2, output: 10 },
  { provider: 'anthropic', match: /^claude-sonnet-4/, input: 3, output: 15 },
  { provider: 'anthropic', match: /^claude-haiku-5-5/, input: 0.1, output: 0.5 },
  { provider: 'anthropic', match: /^claude-haiku-4-5/, input: 1, output: 5 },
  { provider: 'openai', match: /^gpt-4o-mini/, input: 0.15, output: 0.6 },
  { provider: 'openai', match: /^gpt-4o/, input: 2.5, output: 10 },
  { provider: 'openai', match: /^gpt-4\.1-mini/, input: 0.4, output: 1.6 },
  { provider: 'openai', match: /^gpt-4\.1/, input: 2, output: 8 },
  { provider: 'openai', match: /^gpt-5-mini/, input: 0.25, output: 2 },
  { provider: 'openai', match: /^gpt-5-nano/, input: 0.05, output: 0.4 },
  { provider: 'openai', match: /^gpt-5/, input: 1.25, output: 10 },
];

export interface PriceOverride {
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
}

export function priceFor(provider: ProviderId, model: string, override?: PriceOverride): { input: number; output: number } | null {
  if (override?.inputPricePerMTok != null && override.outputPricePerMTok != null) {
    return { input: override.inputPricePerMTok, output: override.outputPricePerMTok };
  }
  const p = PRICES.find((x) => x.provider === provider && x.match.test(model));
  return p ? { input: p.input, output: p.output } : null;
}

export function estimateCostUsd(provider: ProviderId, model: string, usage: Usage, override?: PriceOverride): number | null {
  const p = priceFor(provider, model, override);
  if (!p) return null;
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}
