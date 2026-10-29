import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { DB } from '@secretary/db';
import type { Config } from './config.js';
import { authenticate } from './lib/auth.js';
import type { Deps } from './lib/context.js';
import { KeyRing } from './lib/crypto.js';
import { AppError } from './lib/errors.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { dailyRoutes } from './routes/daily.js';
import { integrationRoutes } from './routes/integrations.js';
import { systemRoutes } from './routes/system.js';
import { taskRoutes } from './routes/tasks.js';

export interface BuildOptions {
  config: Config;
  db: DB;
  now?: () => Date;
  logger?: boolean;
}

/** Paths that work without a session (everything else under /api requires one). */
const PUBLIC = [/^\/api\/auth\/(login|signup|logout|me)$/, /^\/api\/health$/, /^\/api\/integrations\/callback\//];

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; deps: Deps }> {
  const { config } = opts;
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            // Never log credentials or message content.
            redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]', '*.apiKey', '*.password', '*.accessToken', '*.refreshToken', '*.token'], censor: '[redacted]' },
            serializers: { req: (r) => ({ method: r.method, url: r.url.split('?')[0], ip: r.ip }) },
          },
  });
  const deps: Deps = { config, db: opts.db, keys: new KeyRing(config.masterKey), log: app.log, now: opts.now ?? (() => new Date()) };

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.COOKIE_SECURE ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.webOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'authorization'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.user?.id ?? req.ip,
    errorResponseBuilder: (_req, ctx) => new AppError(429, 'rate_limited', `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`),
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('authVia', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const p = req.url.split('?')[0]!;
    const isPublic = PUBLIC.some((r) => r.test(p));
    try {
      await authenticate(deps, req);
    } catch (e) {
      // A stale cookie must not block signing in again.
      if (!isPublic) throw e;
    }
    if (!isPublic && !req.user) throw new AppError(401, 'unauthorized', 'Sign in required');
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err.name === 'ZodError') return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid input' } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } });
  });

  await authRoutes(app, deps);
  await aiRoutes(app, deps);
  await integrationRoutes(app, deps);
  await taskRoutes(app, deps);
  await dailyRoutes(app, deps);
  await systemRoutes(app, deps);

  if (config.SERVE_WEB_DIR && fs.existsSync(config.SERVE_WEB_DIR)) {
    const root = path.resolve(config.SERVE_WEB_DIR);
    await app.register(fastifyStatic, { root, prefix: '/', index: 'index.html', wildcard: false, maxAge: '1h' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.header('cache-control', 'no-cache').sendFile('index.html');
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }));
  }
  return { app, deps };
}
