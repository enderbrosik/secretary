import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';

/** Append-only record of security-relevant and consequential actions. Never stores secrets. */
export async function audit(
  deps: Deps,
  userId: string | null,
  action: string,
  opts: { target?: string; detail?: Record<string, unknown>; ip?: string | null } = {},
): Promise<void> {
  try {
    await deps.db.insert(schema.auditLog).values({ userId, action, target: opts.target ?? null, detail: opts.detail ?? {}, ip: opts.ip ?? null });
  } catch (e) {
    deps.log.error({ err: e, action }, 'audit write failed');
  }
}
