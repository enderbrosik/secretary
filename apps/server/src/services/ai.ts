import { and, eq, gte, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { AIError, createProvider, estimateCostUsd, type AIProvider, type GenerateJSONRequest, type ProviderId } from '@secretary/ai';
import { schema } from '@secretary/db';
import type { AuthedUser, Deps } from '../lib/context.js';

type ProviderRow = typeof schema.aiProviders.$inferSelect;

/** Test seam: lets integration tests substitute a provider factory. */
let ollamaUrl: string | undefined;
/** Where the local Ollama server listens (set from config at startup). */
export function setOllamaUrl(url: string) {
  ollamaUrl = url;
}
export let providerFactory: (p: ProviderId, apiKey: string) => AIProvider = (provider, apiKey) =>
  createProvider({ provider, apiKey, baseURL: provider === 'ollama' ? ollamaUrl : undefined });
export function setProviderFactory(f: typeof providerFactory) {
  providerFactory = f;
}

export interface ActiveAI {
  row: ProviderRow;
  provider: AIProvider;
  model: string;
}

export async function getActiveAI(deps: Deps, user: AuthedUser): Promise<ActiveAI | null> {
  const [row] = await deps.db
    .select()
    .from(schema.aiProviders)
    .where(and(eq(schema.aiProviders.userId, user.id), eq(schema.aiProviders.active, true)))
    .limit(1);
  if (!row || !row.model) return null;
  const apiKey = deps.keys.decrypt(user, `ai:${row.provider}`, row.encryptedKey);
  return { row, provider: providerFactory(row.provider, apiKey), model: row.model };
}

export async function monthToDateCost(deps: Deps, userId: string, tz: string): Promise<number> {
  const start = DateTime.fromJSDate(deps.now()).setZone(tz).startOf('month').toUTC().toISO()!;
  const [r] = await deps.db
    .select({ total: sql<number>`coalesce(sum(${schema.aiUsage.costUsd}), 0)::float` })
    .from(schema.aiUsage)
    .where(and(eq(schema.aiUsage.userId, userId), gte(schema.aiUsage.createdAt, start)));
  return Number(r?.total ?? 0);
}

async function checkBudget(deps: Deps, ai: ActiveAI, userId: string, tz: string) {
  if (ai.row.monthlyBudgetUsd == null) return;
  const spent = await monthToDateCost(deps, userId, tz);
  if (spent >= ai.row.monthlyBudgetUsd) throw new AIError('budget_exceeded', 'Monthly AI budget reached');
}

export async function recordUsage(
  deps: Deps,
  userId: string,
  ai: ActiveAI,
  purpose: string,
  r: { model: string; inputTokens: number; outputTokens: number } | null,
  err: AIError | null,
) {
  const cost = r
    ? estimateCostUsd(ai.row.provider, r.model, { inputTokens: r.inputTokens, outputTokens: r.outputTokens }, {
        inputPricePerMTok: ai.row.inputPricePerMTok,
        outputPricePerMTok: ai.row.outputPricePerMTok,
      })
    : null;
  await deps.db.insert(schema.aiUsage).values({
    userId,
    provider: ai.row.provider,
    model: r?.model ?? ai.model,
    purpose,
    inputTokens: r?.inputTokens ?? 0,
    outputTokens: r?.outputTokens ?? 0,
    costUsd: cost,
    success: !err,
    errorCode: err?.code ?? null,
  });
  await deps.db
    .update(schema.aiProviders)
    .set({ lastError: err ? err.code : null })
    .where(eq(schema.aiProviders.id, ai.row.id));
}

/** Runs a structured AI call with budget enforcement and usage accounting. */
export async function runJSON<T>(
  deps: Deps,
  user: AuthedUser,
  ai: ActiveAI,
  tz: string,
  purpose: string,
  req: Omit<GenerateJSONRequest<T>, 'model'>,
): Promise<{ data: T; model: string }> {
  await checkBudget(deps, ai, user.id, tz);
  try {
    const r = await ai.provider.generateJSON({ ...req, model: ai.model });
    await recordUsage(deps, user.id, ai, purpose, { model: r.model, ...r.usage }, null);
    return { data: r.data, model: r.model };
  } catch (e) {
    const err = e instanceof AIError ? e : new AIError('unavailable', 'AI call failed', true);
    await recordUsage(deps, user.id, ai, purpose, null, err);
    throw err;
  }
}

export { checkBudget };
