import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { dayBounds, localDate, projectInputSchema, taskInputSchema, taskPatchSchema } from '@secretary/core';
import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';
import { requireUser } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { taskDto, toItem } from '../lib/mappers.js';
import { parse } from '../lib/validate.js';
import { approveAction, createAction } from '../services/actions.js';
import { audit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';

const filterSchema = z.object({
  filter: z.enum(['all', 'today', 'overdue', 'upcoming', 'completed', 'waiting', 'suggested', 'open']).default('open'),
  projectId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
});

export async function taskRoutes(app: FastifyInstance, deps: Deps) {
  const own = async (userId: string, id: string) => {
    const [t] = await deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)));
    if (!t) throw notFound('Task');
    return t;
  };
  const assertOwnRefs = async (userId: string, projectId: string | null | undefined, deps2: string[] | undefined, selfId?: string) => {
    if (projectId) {
      const [p] = await deps.db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)));
      if (!p) throw badRequest('Unknown project');
    }
    if (deps2?.length) {
      if (selfId && deps2.includes(selfId)) throw badRequest('A task cannot depend on itself');
      const rows = await deps.db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.userId, userId), inArray(schema.tasks.id, deps2)));
      if (rows.length !== new Set(deps2).size) throw badRequest('Unknown dependency');
    }
  };

  app.get('/api/tasks', async (req) => {
    const user = requireUser(req);
    const f = parse(filterSchema, req.query);
    const s = await getSettings(deps, user.id);
    const { start, end } = dayBounds(localDate(deps.now(), s.timezone), s.timezone);
    const open = and(ne(schema.tasks.status, 'done'), ne(schema.tasks.status, 'canceled'));
    const conds = [eq(schema.tasks.userId, user.id)];
    const confirmed = eq(schema.tasks.confirmed, true);
    switch (f.filter) {
      case 'today':
        conds.push(open!, confirmed, isNotNull(schema.tasks.dueAt), sql`${schema.tasks.dueAt} < ${end.toUTC().toISO()}`);
        break;
      case 'overdue':
        conds.push(open!, confirmed, sql`(case when ${schema.tasks.dueIsAllDay} then ${schema.tasks.dueAt} + interval '1 day' else ${schema.tasks.dueAt} end) < ${start.toUTC().toISO()}`);
        break;
      case 'upcoming':
        conds.push(open!, confirmed, sql`${schema.tasks.dueAt} >= ${end.toUTC().toISO()}`);
        break;
      case 'completed':
        conds.push(eq(schema.tasks.status, 'done'));
        break;
      case 'waiting':
        conds.push(confirmed, or(eq(schema.tasks.status, 'waiting'), eq(schema.tasks.status, 'blocked'))!);
        break;
      case 'suggested':
        conds.push(eq(schema.tasks.confirmed, false), eq(schema.tasks.origin, 'ai_suggested'), ne(schema.tasks.status, 'canceled'));
        break;
      case 'open':
        conds.push(open!, confirmed);
        break;
      case 'all':
        conds.push(ne(schema.tasks.status, 'canceled'));
        break;
    }
    if (f.projectId) conds.push(eq(schema.tasks.projectId, f.projectId));
    if (f.q) conds.push(sql`${schema.tasks.title} ilike ${'%' + f.q.replace(/[%_\\]/g, (c) => '\\' + c) + '%'}`);
    const rows = await deps.db
      .select()
      .from(schema.tasks)
      .where(and(...conds))
      .orderBy(f.filter === 'completed' ? desc(schema.tasks.completedAt) : asc(sql`coalesce(${schema.tasks.dueAt}, '9999-01-01')`), desc(schema.tasks.createdAt))
      .limit(500);
    // Attach source records so every task links to its origin.
    const srcIds = rows.map((r) => r.sourceItemId).filter((x): x is string => !!x);
    const src = srcIds.length ? await deps.db.select().from(schema.items).where(and(eq(schema.items.userId, user.id), inArray(schema.items.id, srcIds))) : [];
    const srcMap = new Map(src.map((s) => [s.id, toItem(s)]));
    const conns = await deps.db.select({ id: schema.connections.id, provider: schema.connections.provider, tier: schema.connections.tier }).from(schema.connections).where(eq(schema.connections.userId, user.id));
    const cMap = new Map(conns.map((c) => [c.id, c]));
    return rows.map((r) => {
      const si = r.sourceItemId ? srcMap.get(r.sourceItemId) : undefined;
      const c = r.connectionId ? cMap.get(r.connectionId) : undefined;
      return {
        ...taskDto(r),
        sourceItem: si ? { id: si.id, kind: si.kind, title: si.title, url: si.url, source: si.source } : null,
        canCompleteExternally: !!c && c.tier === 'write' && c.provider !== 'demo',
      };
    });
  });

  app.post('/api/tasks', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(taskInputSchema, req.body);
    await assertOwnRefs(user.id, body.projectId, body.dependsOn);
    const [t] = await deps.db
      .insert(schema.tasks)
      .values({ ...body, userId: user.id, origin: 'user', confirmed: true, source: 'internal', completedAt: body.status === 'done' ? deps.now().toISOString() : null })
      .returning();
    await deps.db.insert(schema.taskEvents).values({ userId: user.id, taskId: t!.id, type: 'created' });
    return reply.code(201).send(taskDto(t!));
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const cur = await own(user.id, id);
    const body = parse(taskPatchSchema, req.body);
    await assertOwnRefs(user.id, body.projectId, body.dependsOn, id);
    const now = deps.now().toISOString();
    const patch: Partial<typeof schema.tasks.$inferInsert> = { ...body, updatedAt: now };
    const events: { type: string; fromValue: string | null; toValue: string | null }[] = [];
    if (body.status && body.status !== cur.status) {
      events.push({ type: 'status', fromValue: cur.status, toValue: body.status });
      if (body.status === 'done') patch.completedAt = now;
      else patch.completedAt = null;
      if (body.status === 'in_progress' && !cur.startedAt) patch.startedAt = now;
    }
    if (body.dueAt !== undefined && cur.dueAt && body.dueAt && Date.parse(body.dueAt) > Date.parse(cur.dueAt)) {
      patch.postponeCount = cur.postponeCount + 1;
      events.push({ type: 'postponed', fromValue: cur.dueAt, toValue: body.dueAt });
    }
    const [t] = await deps.db.update(schema.tasks).set(patch).where(eq(schema.tasks.id, id)).returning();
    for (const e of events) await deps.db.insert(schema.taskEvents).values({ userId: user.id, taskId: id, ...e });
    return taskDto(t!);
  });

  /** Confirms an AI-suggested task, optionally editing it first. */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/accept', async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const cur = await own(user.id, id);
    if (cur.origin !== 'ai_suggested') throw badRequest('Only suggestions can be accepted');
    const body = parse(taskPatchSchema, req.body ?? {});
    const [t] = await deps.db.update(schema.tasks).set({ ...body, confirmed: true, status: 'todo', updatedAt: deps.now().toISOString() }).where(eq(schema.tasks.id, id)).returning();
    await audit(deps, user.id, 'task.suggestion_accepted', { target: id });
    return taskDto(t!);
  });

  /** Dismissed suggestions are kept as canceled so the same suggestion is not proposed again. */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/dismiss', async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const cur = await own(user.id, id);
    if (cur.origin !== 'ai_suggested' || cur.confirmed) throw badRequest('Only pending suggestions can be dismissed');
    await deps.db.update(schema.tasks).set({ status: 'canceled', updatedAt: deps.now().toISOString() }).where(eq(schema.tasks.id, id));
    return { ok: true };
  });

  /** Completes a synced task in its source app. The click is the explicit approval for this single write. */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/complete-external', async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const cur = await own(user.id, id);
    if (!cur.connectionId) throw badRequest('This task is not linked to a connected app');
    const action = await createAction(deps, user, { type: 'complete_task', connectionId: cur.connectionId, payload: { taskId: id }, origin: 'user' });
    return approveAction(deps, user, action.id, req.ip);
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const cur = await own(user.id, id);
    if (cur.connectionId) throw badRequest('Synced tasks are managed in their source app. Mark it canceled instead.');
    await deps.db.delete(schema.tasks).where(eq(schema.tasks.id, id));
    // Remove the id from other tasks' dependency lists.
    await deps.db.execute(sql`update tasks set depends_on = array_remove(depends_on, ${id}::uuid) where user_id = ${user.id}`);
    return { ok: true };
  });

  // ---- projects -----------------------------------------------------------

  app.get('/api/projects', async (req) => {
    const user = requireUser(req);
    const projects = await deps.db.select().from(schema.projects).where(eq(schema.projects.userId, user.id)).orderBy(asc(schema.projects.name));
    const stats = await deps.db
      .select({
        projectId: schema.tasks.projectId,
        total: sql<number>`count(*) filter (where ${schema.tasks.status} <> 'canceled')::int`,
        done: sql<number>`count(*) filter (where ${schema.tasks.status} = 'done')::int`,
        overdue: sql<number>`count(*) filter (where ${schema.tasks.status} not in ('done','canceled') and ${schema.tasks.dueAt} < ${deps.now().toISOString()})::int`,
      })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.userId, user.id), isNotNull(schema.tasks.projectId)))
      .groupBy(schema.tasks.projectId);
    const m = new Map(stats.map((s) => [s.projectId, s]));
    return projects.map((p) => ({ ...p, stats: m.get(p.id) ?? { total: 0, done: 0, overdue: 0 } }));
  });

  app.post('/api/projects', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(projectInputSchema, req.body);
    const [p] = await deps.db.insert(schema.projects).values({ ...body, userId: user.id }).returning();
    return reply.code(201).send(p);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const [p] = await deps.db.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.userId, user.id)));
    if (!p) throw notFound('Project');
    const tasks = await deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.userId, user.id), eq(schema.tasks.projectId, id), ne(schema.tasks.status, 'canceled'))).orderBy(asc(schema.tasks.status));
    // Related conversations: full-text match on the project name over synced items.
    const since = DateTime.fromJSDate(deps.now()).minus({ days: 30 }).toUTC().toISO()!;
    const related = await deps.db
      .select()
      .from(schema.items)
      .where(and(eq(schema.items.userId, user.id), sql`${schema.items.occurredAt} >= ${since}`, sql`${schema.items.searchText} @@ plainto_tsquery('english', ${p.name})`))
      .orderBy(desc(schema.items.occurredAt))
      .limit(15);
    return { project: p, tasks: tasks.map(taskDto), related: related.map(toItem) };
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = parse(projectInputSchema.partial(), req.body);
    const [p] = await deps.db.update(schema.projects).set({ ...body, updatedAt: deps.now().toISOString() }).where(and(eq(schema.projects.id, id), eq(schema.projects.userId, user.id))).returning();
    if (!p) throw notFound('Project');
    return p;
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const user = requireUser(req);
    const id = z.string().uuid().parse(req.params.id);
    await deps.db.delete(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.userId, user.id)));
    return { ok: true };
  });
}
