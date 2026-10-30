import { and, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSION_TIERS } from '@secretary/core';
import { schema } from '@secretary/db';
import { CONNECTORS, getConnector, IntegrationError, pkcePair, type Features } from '@secretary/integrations';
import { deleteOAuthApp, getOAuthCredentials, saveOAuthApp } from '../services/oauth-apps.js';
import type { Deps } from '../lib/context.js';
import { requireUser } from '../lib/auth.js';
import { randomToken } from '../lib/crypto.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { getConnection, loadUser, syncConnection, tokenPurpose } from '../services/sync.js';

const featuresSchema = z.object({ calendar: z.boolean(), email: z.boolean(), messages: z.boolean(), tasks: z.boolean() });
const connectSchema = z.object({ features: featuresSchema, tier: z.enum(PERMISSION_TIERS).default('read'), client: z.enum(['web', 'desktop']).default('web') });

const PROVIDER_DOCS: Record<string, string> = {
  google: 'docs/SETUP-INTEGRATIONS.md#google',
  microsoft: 'docs/SETUP-INTEGRATIONS.md#microsoft-365',
  slack: 'docs/SETUP-INTEGRATIONS.md#slack',
  todoist: 'docs/SETUP-INTEGRATIONS.md#todoist',
};

export async function integrationRoutes(app: FastifyInstance, deps: Deps) {
  const redirectUri = (provider: string) => `${deps.config.PUBLIC_URL}/api/integrations/callback/${provider}`;
  const clamp = (f: Features, provider: string): Features => {
    const s = getConnector(provider)!.supports;
    return { calendar: f.calendar && s.calendar, email: f.email && s.email, messages: f.messages && s.messages, tasks: f.tasks && s.tasks };
  };

  app.get('/api/integrations', async (req) => {
    const user = requireUser(req);
    const conns = await deps.db.select().from(schema.connections).where(eq(schema.connections.userId, user.id));
    const providers = await Promise.all(
      Object.values(CONNECTORS).map(async (c) => {
        const creds = c.provider === 'demo' ? null : await getOAuthCredentials(deps, c.provider);
        return {
          provider: c.provider,
          name: c.name,
          supports: c.supports,
          configured: c.provider === 'demo' ? deps.config.ALLOW_DEMO : !!creds,
          appSource: creds?.source ?? null,
          // In desktop local mode the user can register their own OAuth app in Settings.
          canConfigureApp: deps.config.LOCAL_MODE && c.provider !== 'demo' && creds?.source !== 'env',
          tokenConnect: !!c.connectWithToken,
          setupDoc: PROVIDER_DOCS[c.provider] ?? null,
          redirectUri: c.provider === 'demo' ? null : redirectUri(c.provider),
        };
      }),
    );
    return {
      providers,
      connections: conns.map((c) => ({
        id: c.id,
        provider: c.provider,
        name: getConnector(c.provider)?.name ?? c.provider,
        accountLabel: c.accountLabel,
        scopes: c.scopes,
        scopeDescriptions: getConnector(c.provider)?.describeScopes(c.features, c.tier) ?? [],
        tier: c.tier,
        features: c.features,
        status: c.status,
        lastSyncAt: c.lastSyncAt,
        lastSyncError: c.lastSyncError,
        createdAt: c.createdAt,
      })),
    };
  });

  /** Desktop local mode: save the user's own OAuth app registration for a provider. */
  app.put<{ Params: { provider: string } }>('/api/integrations/:provider/app', async (req) => {
    const user = requireUser(req);
    const connector = getConnector(req.params.provider);
    if (!connector || connector.provider === 'demo') throw notFound('Integration');
    if (!deps.config.LOCAL_MODE) throw forbidden('OAuth apps are configured by the server administrator on hosted servers.');
    const body = parse(
      z.object({
        clientId: z.string().trim().min(8).max(300).regex(/^[\w.\-:@]+$/, 'That doesn’t look like a client ID'),
        clientSecret: z.string().trim().min(8).max(500),
        tenant: z.string().trim().max(100).regex(/^[\w.-]+$/).optional(),
      }),
      req.body,
    );
    await saveOAuthApp(deps, connector.provider, body);
    await audit(deps, user.id, 'integration.app_configured', { detail: { provider: connector.provider } });
    return { ok: true };
  });

  app.delete<{ Params: { provider: string } }>('/api/integrations/:provider/app', async (req) => {
    const user = requireUser(req);
    if (!deps.config.LOCAL_MODE) throw forbidden('Not available on hosted servers');
    await deleteOAuthApp(deps, req.params.provider);
    await audit(deps, user.id, 'integration.app_removed', { detail: { provider: req.params.provider } });
    return { ok: true };
  });

  /**
   * Connect with a token the user created in the provider itself (Slack user token, Todoist
   * API token). The token is verified with the provider, then stored encrypted like OAuth tokens.
   */
  app.post<{ Params: { provider: string } }>('/api/integrations/:provider/token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const connector = getConnector(req.params.provider);
    if (!connector?.connectWithToken) throw notFound('Token connection');
    const body = parse(z.object({ token: z.string().trim().min(10).max(500), tier: z.enum(PERMISSION_TIERS).default('read') }), req.body);
    let result;
    try {
      result = await connector.connectWithToken(body.token);
    } catch (e) {
      if (e instanceof IntegrationError) throw new AppError(400, `integration_${e.code}`, e.message);
      throw e;
    }
    const features = connector.supports;
    const purpose = tokenPurpose({ provider: connector.provider, externalAccountId: result.account.externalId });
    const values = {
      userId: user.id,
      provider: connector.provider,
      externalAccountId: result.account.externalId,
      accountLabel: result.account.label,
      scopes: result.tokens.scopes,
      tier: connector.provider === 'slack' ? ('read' as const) : body.tier,
      features,
      encryptedTokens: deps.keys.encrypt(user, purpose, JSON.stringify(result.tokens)),
      tokenExpiresAt: result.tokens.expiresAt,
      status: 'active' as const,
      lastSyncError: null,
    };
    const [conn] = await deps.db
      .insert(schema.connections)
      .values(values)
      .onConflictDoUpdate({ target: [schema.connections.userId, schema.connections.provider, schema.connections.externalAccountId], set: values })
      .returning();
    await audit(deps, user.id, 'integration.connected', { target: conn!.id, detail: { provider: connector.provider, method: 'token', tier: values.tier } });
    void syncConnection(deps, user.id, conn!.id).catch((e) => deps.log.warn({ err: e, provider: connector.provider }, 'initial sync failed'));
    return { connected: true, connectionId: conn!.id, accountLabel: result.account.label };
  });

  /** Preview of exactly which permissions will be requested — shown before redirecting to the provider. */
  app.post<{ Params: { provider: string } }>('/api/integrations/:provider/preview', async (req) => {
    requireUser(req);
    const connector = getConnector(req.params.provider);
    if (!connector) throw notFound('Integration');
    const body = parse(connectSchema, req.body);
    const f = clamp(body.features, connector.provider);
    return { scopes: connector.scopesFor(f, body.tier), descriptions: connector.describeScopes(f, body.tier) };
  });

  app.post<{ Params: { provider: string } }>('/api/integrations/:provider/connect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const connector = getConnector(req.params.provider);
    if (!connector) throw notFound('Integration');
    const body = parse(connectSchema, req.body);
    const features = clamp(body.features, connector.provider);
    if (!Object.values(features).some(Boolean)) throw badRequest('Select at least one kind of data to connect');

    if (connector.provider === 'demo') {
      if (!deps.config.ALLOW_DEMO) throw forbidden('Demo mode is disabled on this server');
      const [conn] = await deps.db
        .insert(schema.connections)
        .values({ userId: user.id, provider: 'demo', externalAccountId: 'demo', accountLabel: 'Sample data', features: { calendar: true, email: true, messages: true, tasks: true }, tier: 'read' })
        .onConflictDoUpdate({ target: [schema.connections.userId, schema.connections.provider, schema.connections.externalAccountId], set: { status: 'active' } })
        .returning();
      await syncConnection(deps, user.id, conn!.id);
      await audit(deps, user.id, 'integration.demo_enabled');
      return { connected: true, connectionId: conn!.id };
    }

    const creds = await getOAuthCredentials(deps, connector.provider);
    if (!creds) {
      throw new AppError(409, 'integration_not_configured', deps.config.LOCAL_MODE ? `${connector.name} needs a one-time setup first. Click “Set up” next to it in Settings → Integrations.` : `${connector.name} isn't configured on this server yet. An administrator needs to register an OAuth app and set its client ID and secret (see ${PROVIDER_DOCS[connector.provider]}).`);
    }
    const state = randomToken(24);
    const { verifier, challenge } = pkcePair();
    await deps.db.delete(schema.oauthStates).where(lt(schema.oauthStates.expiresAt, deps.now().toISOString()));
    await deps.db.insert(schema.oauthStates).values({
      state,
      userId: user.id,
      provider: connector.provider,
      encryptedVerifier: deps.keys.encrypt(user, `pkce:${state}`, verifier),
      redirectUri: redirectUri(connector.provider),
      tier: body.tier,
      features,
      returnTo: body.client === 'desktop' ? 'desktop' : '/settings/integrations',
      expiresAt: new Date(deps.now().getTime() + 10 * 60_000).toISOString(),
    });
    const scopes = connector.scopesFor(features, body.tier);
    return { authUrl: connector.buildAuthUrl({ creds, redirectUri: redirectUri(connector.provider), state, codeChallenge: challenge, scopes }), scopes };
  });

  /**
   * OAuth redirect target. Bound to the user by the single-use, unguessable `state`
   * (10-minute expiry) rather than the cookie, so it also works for the desktop app,
   * which opens consent screens in the system browser.
   */
  app.get<{ Params: { provider: string }; Querystring: Record<string, string> }>('/api/integrations/callback/:provider', async (req, reply) => {
    const q = req.query;
    const finish = (ok: boolean, msg: string, returnTo?: string) => {
      if (returnTo && returnTo !== 'desktop') {
        const u = new URL(returnTo, deps.config.APP_URL);
        u.searchParams.set(ok ? 'connected' : 'error', ok ? req.params.provider : msg);
        return reply.redirect(u.toString());
      }
      return reply.type('text/html').send(resultPage(ok, msg));
    };
    const [st] = q.state ? await deps.db.select().from(schema.oauthStates).where(eq(schema.oauthStates.state, String(q.state))) : [];
    if (!st || st.provider !== req.params.provider || Date.parse(st.expiresAt) < deps.now().getTime()) return finish(false, 'This sign-in link expired or is invalid. Please try connecting again.');
    await deps.db.delete(schema.oauthStates).where(eq(schema.oauthStates.state, st.state)); // single use
    if (q.error) return finish(false, q.error === 'access_denied' ? 'You declined the permission request. Nothing was connected.' : 'The provider returned an error. Nothing was connected.', st.returnTo);
    if (!q.code) return finish(false, 'Missing authorization code.', st.returnTo);
    const connector = getConnector(st.provider)!;
    const creds = await getOAuthCredentials(deps, st.provider);
    if (!creds) return finish(false, 'Integration not configured on server.', st.returnTo);
    const user = await loadUser(deps, st.userId);
    try {
      const verifier = deps.keys.decrypt(user, `pkce:${st.state}`, st.encryptedVerifier);
      const { tokens, account } = await connector.exchangeCode({ creds, code: String(q.code), codeVerifier: verifier, redirectUri: st.redirectUri });
      const purpose = tokenPurpose({ provider: connector.provider, externalAccountId: account.externalId });
      const values = {
        userId: user.id,
        provider: connector.provider,
        externalAccountId: account.externalId,
        accountLabel: account.label,
        scopes: tokens.scopes.length ? tokens.scopes : connector.scopesFor(st.features, st.tier as 'read'),
        tier: st.tier as 'read' | 'draft' | 'write',
        features: st.features,
        encryptedTokens: deps.keys.encrypt(user, purpose, JSON.stringify(tokens)),
        tokenExpiresAt: tokens.expiresAt,
        status: 'active' as const,
        lastSyncError: null,
      };
      const [conn] = await deps.db
        .insert(schema.connections)
        .values(values)
        .onConflictDoUpdate({ target: [schema.connections.userId, schema.connections.provider, schema.connections.externalAccountId], set: values })
        .returning();
      await audit(deps, user.id, 'integration.connected', { target: conn!.id, detail: { provider: connector.provider, tier: st.tier, scopes: values.scopes } });
      // First sync in the background; the UI shows progress via lastSyncAt.
      void syncConnection(deps, user.id, conn!.id).catch((e) => deps.log.warn({ err: e, provider: connector.provider }, 'initial sync failed'));
      return finish(true, `${connector.name} connected. You can close this window and return to the app.`, st.returnTo);
    } catch (e) {
      deps.log.warn({ provider: st.provider, code: e instanceof IntegrationError ? e.code : 'unknown' }, 'oauth exchange failed');
      return finish(false, 'Connecting failed while exchanging the authorization code. Please try again.', st.returnTo);
    }
  });

  app.patch<{ Params: { id: string } }>('/api/integrations/:id', async (req) => {
    const user = requireUser(req);
    const conn = await getConnection(deps, user.id, z.string().uuid().parse(req.params.id));
    const body = parse(z.object({ tier: z.enum(PERMISSION_TIERS).optional(), features: featuresSchema.optional() }), req.body);
    const connector = getConnector(conn.provider)!;
    const tier = body.tier ?? conn.tier;
    const features = body.features ? clamp(body.features, conn.provider) : conn.features;
    const needed = connector.scopesFor(features, tier);
    // Identity scopes are reported back under different names (e.g. userinfo.email); compare API scopes only.
    const IDENTITY = new Set(['openid', 'email', 'profile', 'offline_access', 'User.Read']);
    const short = (x: string) => x.split('/').pop()!.toLowerCase();
    const granted = new Set(conn.scopes.map(short));
    const missing = needed.filter((x) => !IDENTITY.has(x) && !granted.has(short(x)));
    // Personal tokens (Todoist) already carry full access; there is no consent screen to revisit.
    if (missing.length && conn.provider !== 'demo' && !conn.scopes.includes('personal_token')) {
      // Broader access requires going back through the provider's consent screen.
      return { requiresReconsent: true, missingScopes: missing };
    }
    await deps.db.update(schema.connections).set({ tier, features }).where(eq(schema.connections.id, conn.id));
    await audit(deps, user.id, 'integration.permissions_changed', { target: conn.id, detail: { from: conn.tier, to: tier, features } });
    return { requiresReconsent: false };
  });

  app.post<{ Params: { id: string } }>('/api/integrations/:id/sync', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse(req.params.id);
    try {
      return await syncConnection(deps, user.id, id);
    } catch (e) {
      if (e instanceof IntegrationError) throw new AppError(e.code === 'rate_limited' ? 429 : 502, `integration_${e.code}`, e.message);
      throw e;
    }
  });

  /** Disconnect: revoke at the provider (where supported), delete tokens and all data synced from it. */
  app.delete<{ Params: { id: string } }>('/api/integrations/:id', async (req) => {
    const user = requireUser(req);
    const conn = await getConnection(deps, user.id, z.string().uuid().parse(req.params.id));
    const connector = getConnector(conn.provider)!;
    let revoked = false;
    if (conn.encryptedTokens && connector.revoke) {
      const creds = await getOAuthCredentials(deps, conn.provider);
      try {
        await connector.revoke(JSON.parse(deps.keys.decrypt(user, tokenPurpose(conn), conn.encryptedTokens)), creds ?? { clientId: '', clientSecret: '' });
        revoked = true;
      } catch {
        revoked = false;
      }
    }
    await deps.db.delete(schema.connections).where(and(eq(schema.connections.id, conn.id), eq(schema.connections.userId, user.id)));
    await audit(deps, user.id, 'integration.disconnected', { target: conn.id, detail: { provider: conn.provider, revokedAtProvider: revoked }, ip: req.ip });
    return { ok: true, revokedAtProvider: revoked, note: conn.provider === 'microsoft' ? 'Microsoft does not support programmatic revocation. Remove the app at https://myapps.microsoft.com to fully revoke access.' : undefined };
  });
}

function resultPage(ok: boolean, msg: string) {
  const esc = msg.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? 'Connected' : 'Connection failed'}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f6f3;color:#1f1d1a}main{max-width:420px;padding:32px;background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 8px}@media(prefers-color-scheme:dark){body{background:#151413;color:#ecebe8}main{background:#1f1e1c}}</style></head>
<body><main><h1>${ok ? 'Connected' : 'Connection failed'}</h1><p>${esc}</p></main></body></html>`;
}
