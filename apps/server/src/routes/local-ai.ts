import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_ERROR_MESSAGES, AIError, OllamaProvider, RECOMMENDED_LOCAL_MODELS, SLOW_LOCAL_MODELS } from '@secretary/ai';
import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';
import { requireUser } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { corsHeaders } from './daily.js';

/**
 * Local AI with the free Ollama app: detect it, download a recommended model with progress,
 * switch to it, and delete models to free disk space. No key or account involved.
 */
const allowed = new Set<string>(RECOMMENDED_LOCAL_MODELS.map((m) => m.id));
const modelBody = z.object({ model: z.string().refine((m) => allowed.has(m), 'Choose one of the recommended models') });

export async function localAIRoutes(app: FastifyInstance, deps: Deps) {
  const ollama = () => new OllamaProvider({ baseURL: deps.config.OLLAMA_URL });

  app.get('/api/ai/local/status', async (req) => {
    const user = requireUser(req);
    const o = ollama();
    const version = await o.version();
    const installed = version ? await o.installedModels().catch(() => []) : [];
    const [row] = await deps.db.select().from(schema.aiProviders).where(and(eq(schema.aiProviders.userId, user.id), eq(schema.aiProviders.provider, 'ollama')));
    const inUse = row?.active ? row.model : null;
    // Offer the faster model when the one in use always "thinks" first.
    const slowBytes = inUse && SLOW_LOCAL_MODELS[inUse] ? (installed.find((m) => m.name === inUse)?.sizeBytes ?? 0) : null;
    return {
      running: !!version,
      version,
      downloadUrl: 'https://ollama.com/download',
      installed: installed.map((m) => ({ name: m.name, diskGB: Math.round((m.sizeBytes / 1e9) * 10) / 10 })),
      recommended: RECOMMENDED_LOCAL_MODELS,
      inUse,
      upgrade: inUse && slowBytes !== null ? { from: inUse, to: SLOW_LOCAL_MODELS[inUse]!, freesGB: Math.round((slowBytes / 1e9) * 10) / 10 } : null,
    };
  });

  /** Streams NDJSON progress: {status, fraction} lines, then {done:true} or {error}. */
  app.post('/api/ai/local/pull', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    requireUser(req);
    const { model } = parse(modelBody, req.body);
    const ac = new AbortController();
    // The response closing before we finish means the client disconnected (request 'close' fires after the body is read).
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) ac.abort();
    });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(deps, req.headers.origin) });
    let last = -1;
    try {
      await ollama().pull(
        model,
        (p) => {
          // Throttle to whole percents to keep the stream small.
          const pct = p.fraction === null ? -1 : Math.floor(p.fraction * 100);
          if (pct !== last || p.fraction === null) {
            last = pct;
            reply.raw.write(`${JSON.stringify({ status: p.status, fraction: p.fraction })}\n`);
          }
        },
        ac.signal,
      );
      reply.raw.write(`${JSON.stringify({ done: true })}\n`);
    } catch (e) {
      const msg = e instanceof AIError && e.code === 'unavailable' ? 'Ollama isn’t running. Open the Ollama app and try again.' : 'The download failed. Check your connection and disk space, then try again.';
      reply.raw.write(`${JSON.stringify({ error: msg })}\n`);
    }
    reply.raw.end();
  });

  /** Switches the user's AI to a downloaded local model. */
  app.post('/api/ai/local/use', async (req) => {
    const user = requireUser(req);
    const { model } = parse(modelBody, req.body);
    let installed;
    try {
      installed = await ollama().installedModels();
    } catch {
      throw new AppError(409, 'ollama_not_running', 'Ollama isn’t running. Open the Ollama app and try again.');
    }
    if (!installed.some((m) => m.name === model)) throw new AppError(409, 'model_not_downloaded', 'Download this model first.');
    // Local models have no key; store an encrypted empty marker so the row shape stays uniform.
    const encryptedKey = deps.keys.encrypt(user, 'ai:ollama', '');
    await deps.db.update(schema.aiProviders).set({ active: false }).where(eq(schema.aiProviders.userId, user.id));
    await deps.db
      .insert(schema.aiProviders)
      .values({ userId: user.id, provider: 'ollama', encryptedKey, keyHint: 'local', model, active: true, lastTestedAt: deps.now().toISOString(), inputPricePerMTok: 0, outputPricePerMTok: 0 })
      .onConflictDoUpdate({ target: [schema.aiProviders.userId, schema.aiProviders.provider], set: { model, active: true, lastError: null, lastTestedAt: deps.now().toISOString() } });
    await audit(deps, user.id, 'ai.provider_connected', { detail: { provider: 'ollama', model } });
    return { ok: true, model };
  });

  /** Deletes a downloaded model from disk. If it was in use, local AI is turned off. */
  app.delete<{ Params: { model: string } }>('/api/ai/local/models/:model', async (req) => {
    const user = requireUser(req);
    const model = decodeURIComponent(req.params.model);
    if (!/^[\w.-]+(:[\w.-]+)?$/.test(model)) throw new AppError(400, 'bad_request', 'Invalid model name');
    try {
      await ollama().remove(model);
    } catch (e) {
      throw new AppError(e instanceof AIError && e.code === 'model_not_found' ? 404 : 409, 'ollama_error', e instanceof AIError && e.code === 'unavailable' ? 'Ollama isn’t running.' : AI_ERROR_MESSAGES.unavailable);
    }
    const [row] = await deps.db.select().from(schema.aiProviders).where(and(eq(schema.aiProviders.userId, user.id), eq(schema.aiProviders.provider, 'ollama')));
    if (row?.model === model) await deps.db.delete(schema.aiProviders).where(eq(schema.aiProviders.id, row.id));
    await audit(deps, user.id, 'ai.local_model_deleted', { detail: { model } });
    return { ok: true };
  });
}
