import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@secretary/db';
import { getConnector, IntegrationError } from '@secretary/integrations';
import type { AuthedUser, Deps } from '../lib/context.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';
import { connectionContext, getConnection } from './sync.js';

/**
 * Permission model:
 *   read  – sync only. No external writes of any kind.
 *   draft – may save email drafts in the user's mailbox.
 *   write – may send email, create calendar events and complete external tasks.
 * Every external write is first stored as a pending action and executes only
 * after the user approves that specific action.
 */
const email = z.string().trim().email().max(254);
export const actionPayloads = {
  create_draft: z.object({ itemId: z.string().uuid().nullable().default(null), to: z.array(email).min(1).max(20), cc: z.array(email).max(20).default([]), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) }),
  send_email: z.object({ itemId: z.string().uuid().nullable().default(null), to: z.array(email).min(1).max(20), cc: z.array(email).max(20).default([]), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) }),
  create_events: z.object({
    events: z.array(z.object({ title: z.string().min(1).max(200), start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), description: z.string().max(2000).default('') })).min(1).max(20),
  }),
  complete_task: z.object({ taskId: z.string().uuid() }),
} as const;
export type ActionType = keyof typeof actionPayloads;

const REQUIRED: Record<ActionType, { tier: 'draft' | 'write'; feature: 'email' | 'calendar' | 'tasks' }> = {
  create_draft: { tier: 'draft', feature: 'email' },
  send_email: { tier: 'write', feature: 'email' },
  create_events: { tier: 'write', feature: 'calendar' },
  complete_task: { tier: 'write', feature: 'tasks' },
};

const TIER_RANK = { read: 0, draft: 1, write: 2 } as const;

type ConnRow = typeof schema.connections.$inferSelect;

export function assertPermitted(conn: ConnRow, type: ActionType) {
  if (conn.provider === 'demo') throw forbidden('This is the demo workspace — nothing can be sent or changed in real accounts.');
  const req = REQUIRED[type];
  if (!conn.features[req.feature]) throw forbidden(`This connection does not have ${req.feature} access enabled.`);
  if (TIER_RANK[conn.tier] < TIER_RANK[req.tier]) {
    throw forbidden(`This connection is set to “${conn.tier}” permissions. ${req.tier === 'draft' ? 'Allow drafts' : 'Allow sending and changes'} in Settings → Integrations to do this.`);
  }
}

function summarize(type: ActionType, p: Record<string, unknown>): string {
  switch (type) {
    case 'create_draft':
      return `Save a draft to ${(p.to as string[]).join(', ')}: “${p.subject}”`;
    case 'send_email':
      return `Send an email to ${(p.to as string[]).join(', ')}: “${p.subject}”`;
    case 'create_events': {
      const n = (p.events as unknown[]).length;
      return `Add ${n} block${n > 1 ? 's' : ''} to your calendar`;
    }
    case 'complete_task':
      return 'Mark the task complete in the connected task app';
  }
}

export async function createAction(deps: Deps, user: AuthedUser, input: { type: string; connectionId: string; payload: unknown; origin: 'user' | 'assistant' | 'plan' }) {
  if (!(input.type in actionPayloads)) throw badRequest('Unknown action type');
  const type = input.type as ActionType;
  const payload = parse(actionPayloads[type] as z.ZodType<Record<string, unknown>>, input.payload);
  const conn = await getConnection(deps, user.id, input.connectionId);
  assertPermitted(conn, type);
  if (type === 'complete_task') {
    const [t] = await deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.id, payload.taskId as string), eq(schema.tasks.userId, user.id)));
    if (!t || t.connectionId !== conn.id || !t.externalId) throw badRequest('Task does not belong to this connection');
  }
  const [row] = await deps.db
    .insert(schema.pendingActions)
    .values({ userId: user.id, connectionId: conn.id, type, payload, summary: summarize(type, payload), origin: input.origin })
    .returning();
  await audit(deps, user.id, 'action.requested', { target: row!.id, detail: { type, connection: conn.provider, origin: input.origin } });
  return row!;
}

export async function listActions(deps: Deps, userId: string, status?: string) {
  const conds = [eq(schema.pendingActions.userId, userId)];
  if (status) conds.push(eq(schema.pendingActions.status, status as 'pending'));
  return deps.db.select().from(schema.pendingActions).where(and(...conds)).orderBy(desc(schema.pendingActions.createdAt)).limit(100);
}

export async function rejectAction(deps: Deps, user: AuthedUser, id: string) {
  const [row] = await deps.db
    .update(schema.pendingActions)
    .set({ status: 'rejected', decidedAt: deps.now().toISOString() })
    .where(and(eq(schema.pendingActions.id, id), eq(schema.pendingActions.userId, user.id), eq(schema.pendingActions.status, 'pending')))
    .returning();
  if (!row) throw notFound('Pending action');
  await audit(deps, user.id, 'action.rejected', { target: id, detail: { type: row.type } });
  return row;
}

/** Executes an approved action. The status transition is atomic, so double-clicks cannot run it twice. */
export async function approveAction(deps: Deps, user: AuthedUser, id: string, ip?: string | null) {
  const [row] = await deps.db
    .update(schema.pendingActions)
    .set({ status: 'executing', decidedAt: deps.now().toISOString() })
    .where(and(eq(schema.pendingActions.id, id), eq(schema.pendingActions.userId, user.id), eq(schema.pendingActions.status, 'pending')))
    .returning();
  if (!row) throw notFound('Pending action');
  await audit(deps, user.id, 'action.approved', { target: id, detail: { type: row.type }, ip });
  const type = row.type as ActionType;
  try {
    const conn = await getConnection(deps, user.id, row.connectionId!);
    assertPermitted(conn, type); // permissions may have changed since the request
    const connector = getConnector(conn.provider)!;
    const ctx = await connectionContext(deps, user, conn);
    const p = row.payload as Record<string, unknown>;
    const settings = await getSettings(deps, user.id);
    let result: unknown;

    const replyTo = async () => {
      if (!p.itemId) return null;
      const [it] = await deps.db.select().from(schema.items).where(and(eq(schema.items.id, p.itemId as string), eq(schema.items.userId, user.id)));
      return it && it.connectionId === conn.id ? it.externalId : null;
    };

    if (type === 'create_draft' || type === 'send_email') {
      if (!connector.createDraft) throw new IntegrationError('not_supported', 'This provider cannot create drafts');
      const draft = await connector.createDraft(ctx, { to: p.to as string[], cc: p.cc as string[], subject: p.subject as string, body: p.body as string, replyToExternalId: await replyTo() });
      result = draft;
      if (type === 'send_email') {
        if (!connector.sendDraft) throw new IntegrationError('not_supported', 'This provider cannot send email');
        result = await connector.sendDraft(ctx, draft.draftId);
      }
    } else if (type === 'create_events') {
      if (!connector.createEvent) throw new IntegrationError('not_supported', 'This provider cannot create events');
      const created = [];
      for (const ev of p.events as { title: string; start: string; end: string; description: string }[]) {
        created.push(await connector.createEvent(ctx, { ...ev, timezone: settings.timezone }));
      }
      result = { created };
    } else if (type === 'complete_task') {
      const [t] = await deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.id, p.taskId as string), eq(schema.tasks.userId, user.id)));
      if (!t?.externalId || !connector.completeTask) throw new IntegrationError('not_supported', 'Task cannot be completed in the source');
      result = await connector.completeTask(ctx, t.externalId);
    }
    const [done] = await deps.db
      .update(schema.pendingActions)
      .set({ status: 'done', result: result ?? {}, executedAt: deps.now().toISOString() })
      .where(eq(schema.pendingActions.id, id))
      .returning();
    await audit(deps, user.id, 'action.executed', { target: id, detail: { type, provider: conn.provider } });
    return done!;
  } catch (e) {
    const msg = e instanceof IntegrationError || e instanceof AppError ? e.message : 'The action failed';
    await deps.db.update(schema.pendingActions).set({ status: 'failed', error: msg, executedAt: deps.now().toISOString() }).where(eq(schema.pendingActions.id, id));
    await audit(deps, user.id, 'action.failed', { target: id, detail: { type, error: msg } });
    if (e instanceof AppError) throw e;
    throw new AppError(502, 'action_failed', msg);
  }
}
