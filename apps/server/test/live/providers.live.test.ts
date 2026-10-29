/**
 * Live tests against real provider APIs. Never run in normal CI.
 *   LIVE_TESTS=1 ANTHROPIC_API_KEY_LIVE=... OPENAI_API_KEY_LIVE=... pnpm test:live
 * Integrations (Google/Microsoft/Slack/Todoist) need an interactive OAuth consent and are verified
 * manually — see docs/SETUP-INTEGRATIONS.md → "Verifying a connection".
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createProvider, pickDefaultModel } from '@secretary/ai';

const live = process.env.LIVE_TESTS === '1';
const cases = [
  ['anthropic', process.env.ANTHROPIC_API_KEY_LIVE],
  ['openai', process.env.OPENAI_API_KEY_LIVE],
] as const;

describe.skipIf(!live)('live AI providers', () => {
  for (const [provider, key] of cases) {
    it.skipIf(!key)(`${provider}: lists models and returns schema-valid JSON`, async () => {
      const p = createProvider({ provider, apiKey: key! });
      const models = await p.listModels();
      expect(models.length).toBeGreaterThan(0);
      const model = pickDefaultModel(provider, models)!;
      const r = await p.generateJSON({
        model,
        system: 'Reply with JSON only.',
        user: 'Give a one-word greeting and the number 3.',
        schema: z.object({ greeting: z.string(), n: z.number() }),
        schemaName: 'probe',
        maxTokens: 2000,
      });
      expect(r.data.n).toBe(3);
    }, 120_000);
  }
});
