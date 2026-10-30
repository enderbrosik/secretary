import { eq } from 'drizzle-orm';
import { schema } from '@secretary/db';
import { oauthCredentials } from '../config.js';
import type { Deps } from '../lib/context.js';

export interface OAuthCreds {
  clientId: string;
  clientSecret: string;
  tenant?: string;
}

/**
 * OAuth app credentials: environment variables win (hosted servers). In desktop local mode the
 * single user can also enter them in Settings, stored encrypted with the master key.
 */
export async function getOAuthCredentials(deps: Deps, provider: string): Promise<(OAuthCreds & { source: 'env' | 'app' }) | null> {
  const env = oauthCredentials(deps.config, provider);
  if (env) return { ...env, source: 'env' };
  if (!deps.config.LOCAL_MODE) return null;
  const [row] = await deps.db.select().from(schema.oauthApps).where(eq(schema.oauthApps.provider, provider));
  if (!row) return null;
  return {
    clientId: row.clientId,
    clientSecret: deps.keys.decryptSystem(`oauth-app:${provider}`, row.encryptedSecret),
    tenant: row.tenant ?? (provider === 'microsoft' ? deps.config.MICROSOFT_TENANT : undefined),
    source: 'app',
  };
}

export async function saveOAuthApp(deps: Deps, provider: string, creds: OAuthCreds): Promise<void> {
  const values = {
    provider,
    clientId: creds.clientId,
    encryptedSecret: deps.keys.encryptSystem(`oauth-app:${provider}`, creds.clientSecret),
    tenant: creds.tenant ?? null,
    updatedAt: deps.now().toISOString(),
  };
  await deps.db.insert(schema.oauthApps).values(values).onConflictDoUpdate({ target: schema.oauthApps.provider, set: values });
}

export async function deleteOAuthApp(deps: Deps, provider: string): Promise<void> {
  await deps.db.delete(schema.oauthApps).where(eq(schema.oauthApps.provider, provider));
}
