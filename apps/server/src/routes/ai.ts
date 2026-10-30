import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { AI_ERROR_MESSAGES, AIError, pickDefaultModel, priceFor, PROVIDER_INFO, type ProviderId } from '@secretary/ai';
import { aiProviderInputSchema, aiProviderPatchSchema } from '@secretary/core';
import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';
import { requireUser } from '../lib/auth.js';
import { keyHint } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { monthToDateCost, providerFactory } from '../services/ai.js';
import { audit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';

const providerParam = z.object({ provider: z.enum(['openai', 'anthropic', 'ollama']) });
const aiLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

function aiHttpError(e: unknown): AppError {
  if (e instanceof AIError) {
    const status = e.code === 'invalid_key' ? 400 : e.code === 'rate_limited' ? 429 : e.code === 'permission_denied' ? 403 : 502;
    return new AppError(status, `ai_${e.code}`, AI_ERROR_MESSAGES[e.code]);
  }
  return new AppError(502, 'ai_unavailable', AI_ERROR_MESSAGES.unavailable);
}

export async function aiRoutes(app: FastifyInstance, deps: Deps) {
  const rowFor = async (userId: string, provider: ProviderId) => {
    const [row] = await deps.db.select().from(schema.aiProviders).where(and(eq(schema.aiProviders.userId, userId), eq(schema.aiProviders.provider, provider)));
    return row;
  };
  const dto = (r: typeof schema.aiProviders.$inferSelect) => ({
    provider: r.provider,
    keyHint: r.keyHint,
    model: r.model,
    active: r.active,
    monthlyBudgetUsd: r.monthlyBudgetUsd,
    inputPricePerMTok: r.inputPricePerMTok,
    outputPricePerMTok: r.outputPricePerMTok,
    defaultPrice: r.model ? priceFor(r.provider, r.model) : null,
    sendEmailBodies: r.sendEmailBodies,
    lastTestedAt: r.lastTestedAt,
    lastError: r.lastError ? AI_ERROR_MESSAGES[r.lastError as keyof typeof AI_ERROR_MESSAGES] ?? r.lastError : null,
    createdAt: r.createdAt,
  });

  app.get('/api/ai/providers', async (req) => {
    const user = requireUser(req);
    const rows = await deps.db.select().from(schema.aiProviders).where(eq(schema.aiProviders.userId, user.id));
    return { available: PROVIDER_INFO, configured: rows.map(dto) };
  });

  /** Saves a key only after verifying it against the provider's model list. The key is never returned. */
  app.post('/api/ai/providers', { config: aiLimit }, async (req) => {
    const user = requireUser(req);
    const body = parse(aiProviderInputSchema, req.body);
    let models;
    try {
      models = await providerFactory(body.provider, body.apiKey).listModels();
    } catch (e) {
      throw aiHttpError(e);
    }
    const model = body.model && models.some((m) => m.id === body.model) ? body.model : pickDefaultModel(body.provider, models);
    const encryptedKey = deps.keys.encrypt(user, `ai:${body.provider}`, body.apiKey);
    await deps.db.update(schema.aiProviders).set({ active: false }).where(eq(schema.aiProviders.userId, user.id));
    await deps.db
      .insert(schema.aiProviders)
      .values({ userId: user.id, provider: body.provider, encryptedKey, keyHint: keyHint(body.apiKey), model, active: true, lastTestedAt: deps.now().toISOString() })
      .onConflictDoUpdate({
        target: [schema.aiProviders.userId, schema.aiProviders.provider],
        set: { encryptedKey, keyHint: keyHint(body.apiKey), model, active: true, lastTestedAt: deps.now().toISOString(), lastError: null },
      });
    await audit(deps, user.id, 'ai.provider_connected', { detail: { provider: body.provider }, ip: req.ip });
    return { provider: dto((await rowFor(user.id, body.provider))!), models };
  });

  app.get('/api/ai/providers/:provider/models', { config: aiLimit }, async (req) => {
    const user = requireUser(req);
    const { provider } = providerParam.parse(req.params);
    const row = await rowFor(user.id, provider);
    if (!row) throw notFound('AI provider');
    try {
      return { models: await providerFactory(provider, deps.keys.decrypt(user, `ai:${provider}`, row.encryptedKey)).listModels() };
    } catch (e) {
      throw aiHttpError(e);
    }
  });

  app.post('/api/ai/providers/:provider/test', { config: aiLimit }, async (req) => {
    const user = requireUser(req);
    const { provider } = providerParam.parse(req.params);
    const row = await rowFor(user.id, provider);
    if (!row) throw notFound('AI provider');
    const p = providerFactory(provider, deps.keys.decrypt(user, `ai:${provider}`, row.encryptedKey));
    try {
      const models = await p.listModels();
      if (row.model && !models.some((m) => m.id === row.model)) throw new AIError('model_not_found', 'Selected model not available');
      await deps.db.update(schema.aiProviders).set({ lastTestedAt: deps.now().toISOString(), lastError: null }).where(eq(schema.aiProviders.id, row.id));
      return { ok: true, modelCount: models.length, model: row.model };
    } catch (e) {
      const err = aiHttpError(e);
      await deps.db.update(schema.aiProviders).set({ lastTestedAt: deps.now().toISOString(), lastError: e instanceof AIError ? e.code : 'unavailable' }).where(eq(schema.aiProviders.id, row.id));
      return { ok: false, code: err.code, message: err.message };
    }
  });

  app.patch('/api/ai/providers/:provider', async (req) => {
    const user = requireUser(req);
    const { provider } = providerParam.parse(req.params);
    const body = parse(aiProviderPatchSchema, req.body);
    const row = await rowFor(user.id, provider);
    if (!row) throw notFound('AI provider');
    if (body.active) await deps.db.update(schema.aiProviders).set({ active: false }).where(eq(schema.aiProviders.userId, user.id));
    await deps.db.update(schema.aiProviders).set(body).where(eq(schema.aiProviders.id, row.id));
    await audit(deps, user.id, 'ai.provider_updated', { detail: { provider, keys: Object.keys(body) } });
    return dto((await rowFor(user.id, provider))!);
  });

  app.delete('/api/ai/providers/:provider', async (req) => {
    const user = requireUser(req);
    const { provider } = providerParam.parse(req.params);
    await deps.db.delete(schema.aiProviders).where(and(eq(schema.aiProviders.userId, user.id), eq(schema.aiProviders.provider, provider)));
    await audit(deps, user.id, 'ai.provider_deleted', { detail: { provider }, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/ai/usage', async (req) => {
    const user = requireUser(req);
    const s = await getSettings(deps, user.id);
    const start = DateTime.fromJSDate(deps.now()).setZone(s.timezone).startOf('month').toUTC().toISO()!;
    const byPurpose = await deps.db
      .select({
        purpose: schema.aiUsage.purpose,
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${schema.aiUsage.inputTokens}),0)::int`,
        outputTokens: sql<number>`coalesce(sum(${schema.aiUsage.outputTokens}),0)::int`,
        costUsd: sql<number>`coalesce(sum(${schema.aiUsage.costUsd}),0)::float`,
        unpriced: sql<number>`count(*) filter (where ${schema.aiUsage.costUsd} is null and ${schema.aiUsage.success})::int`,
      })
      .from(schema.aiUsage)
      .where(and(eq(schema.aiUsage.userId, user.id), gte(schema.aiUsage.createdAt, start)))
      .groupBy(schema.aiUsage.purpose);
    const recent = await deps.db.select().from(schema.aiUsage).where(eq(schema.aiUsage.userId, user.id)).orderBy(desc(schema.aiUsage.createdAt)).limit(25);
    return { monthToDateUsd: await monthToDateCost(deps, user.id, s.timezone), byPurpose, recent, note: 'Costs are estimates from list prices (or your overrides). Your provider’s billing dashboard is authoritative.' };
  });
}
