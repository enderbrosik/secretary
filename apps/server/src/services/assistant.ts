import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AI_ERROR_MESSAGES, AIError } from '@secretary/ai';
import {
  buildBriefingContext,
  buildRefRegistry,
  formatTime,
  personaInstructions,
  sanitizeText,
  UNTRUSTED_CONTENT_POLICY,
  untrusted,
  type EmailItem,
  type EventItem,
  type Item,
  type MessageItem,
  type SourceRef,
  type Task,
} from '@secretary/core';
import { schema } from '@secretary/db';
import type { AuthedUser, Deps } from '../lib/context.js';
import { AppError, notFound } from '../lib/errors.js';
import { toItem } from '../lib/mappers.js';
import { checkBudget, getActiveAI, recordUsage, runJSON } from './ai.js';
import { getSettings, toPreferences } from './settings.js';
import { loadWorkspace } from './workspace.js';

export type AssistantEvent =
  | { type: 'start'; threadId: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; citations: SourceRef[]; model: string }
  | { type: 'error'; code: string; message: string };

async function searchItems(deps: Deps, userId: string, q: string): Promise<Item[]> {
  const query = q.replace(/[^\p{L}\p{N}\s@.-]/gu, ' ').trim();
  if (!query) return [];
  const rows = await deps.db
    .select()
    .from(schema.items)
    .where(and(eq(schema.items.userId, userId), sql`${schema.items.searchText} @@ websearch_to_tsquery('english', ${query})`))
    .orderBy(desc(sql`ts_rank(${schema.items.searchText}, websearch_to_tsquery('english', ${query}))`))
    .limit(8);
  return rows.map(toItem);
}

function describeRecord(ref: string, it: Item | Task, tz: string): string {
  if ('kind' in it) {
    if (it.kind === 'event') {
      const e = it as EventItem;
      return `[${ref}] EVENT “${sanitizeText(e.title, 120)}” ${e.data.start} → ${formatTime(e.data.end, tz)} | attendees: ${e.data.attendees.filter((a) => !a.self).map((a) => a.name ?? a.email).slice(0, 8).join(', ') || 'none'} | your response: ${e.data.selfResponse}${e.data.description ? `\n${untrusted(ref, 'event_description', e.data.description, 400)}` : ''}`;
    }
    if (it.kind === 'email') {
      const e = it as EmailItem;
      return `[${ref}] EMAIL from ${sanitizeText(e.data.from.name ?? '', 50)} <${e.data.from.email ?? ''}> at ${e.occurredAt} | ${e.data.lastMessageFromMe ? 'you replied last' : 'awaiting your reply'} | messages in thread: ${e.data.messageCount}\n${untrusted(ref, 'email', `Subject: ${e.title}\n${e.data.bodyText || e.data.snippet}`, 900)}`;
    }
    const m = it as MessageItem;
    return `[${ref}] CHAT ${m.data.channelType}${m.data.channelName ? ` #${m.data.channelName}` : ''} from ${sanitizeText(m.data.author.name ?? m.data.author.id, 50)} at ${m.occurredAt}\n${untrusted(ref, 'chat_message', m.data.text, 500)}`;
  }
  const t = it as Task;
  return `[${ref}] TASK “${sanitizeText(t.title, 140)}” | ${t.status} | priority ${t.priority} | due ${t.dueAt ?? 'none'} | ${t.origin === 'ai_suggested' && !t.confirmed ? 'UNCONFIRMED AI suggestion' : 'confirmed'}${t.waitingOn ? ` | waiting on ${t.waitingOn}` : ''}`;
}

export async function streamAssistant(
  deps: Deps,
  user: AuthedUser,
  input: { threadId?: string | null; message: string },
  emit: (e: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const settings = await getSettings(deps, user.id);
  const prefs = toPreferences(settings, user.email);
  const tz = settings.timezone;
  const threadId = input.threadId ?? crypto.randomUUID();
  emit({ type: 'start', threadId });

  const ai = await getActiveAI(deps, user);
  if (!ai) {
    emit({ type: 'error', code: 'not_configured', message: AI_ERROR_MESSAGES.not_configured });
    return;
  }
  const history = await deps.db
    .select()
    .from(schema.chatMessages)
    .where(and(eq(schema.chatMessages.userId, user.id), eq(schema.chatMessages.threadId, threadId)))
    .orderBy(asc(schema.chatMessages.createdAt))
    .limit(20);
  await deps.db.insert(schema.chatMessages).values({ userId: user.id, threadId, role: 'user', content: input.message.slice(0, 8000) });

  // Retrieval: today's deterministic context + full-text matches for the question.
  const ws = await loadWorkspace(deps, user.id, tz);
  const ctx = buildBriefingContext({ now: deps.now(), prefs, ...ws }, { limitEmails: 10, limitMessages: 8 });
  const found = await searchItems(deps, user.id, input.message);
  const events = uniq([...ctx.todayEvents, ...ctx.tomorrowEvents, ...(found.filter((f) => f.kind === 'event') as EventItem[])]);
  const emails = uniq([...ctx.importantEmails, ...(found.filter((f) => f.kind === 'email') as EmailItem[])]);
  const messages = uniq([...ctx.importantMessages, ...(found.filter((f) => f.kind === 'message') as MessageItem[])]);
  const openTasks = ws.tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled');
  const ranked = ctx.ranking.slice(0, 15).map((r) => openTasks.find((t) => t.id === r.taskId)!).filter(Boolean);
  const tasks = uniq([...ranked, ...openTasks.filter((t) => t.status === 'waiting'), ...ws.tasks.filter((t) => t.status === 'done').slice(0, 10)]);
  const refs = buildRefRegistry({ events, emails, messages, tasks });

  const connected = ws.freshness.map((f) => `${f.label}${f.stale ? ' (may be out of date)' : ''}`);
  const records = [
    ...events.map((e) => describeRecord(refs.byId.get(e.id)!.ref, e, tz)),
    ...tasks.map((t) => describeRecord(refs.byId.get(t.id)!.ref, t, tz)),
    ...emails.map((e) => describeRecord(refs.byId.get(e.id)!.ref, e, tz)),
    ...messages.map((m) => describeRecord(refs.byId.get(m.id)!.ref, m, tz)),
  ];
  const facts = [
    `Now: ${deps.now().toISOString()} (user timezone ${tz}, local time ${formatTime(deps.now().toISOString(), tz)}).`,
    `Free focus time left today: ${ctx.focusMinutes} min. Conflicts today: ${ctx.conflicts.length}. Overdue tasks: ${ctx.overdue.length}.`,
    `Task ranking is computed from deadlines, priority and dependencies; top refs in order: ${ctx.ranking.slice(0, 5).map((r) => refs.byId.get(r.taskId)?.ref).filter(Boolean).join(', ') || 'none'}. Reasons: ${ctx.ranking.slice(0, 5).map((r) => `${refs.byId.get(r.taskId)?.ref}: ${r.reasons.join('; ')}`).join(' | ')}`,
  ];

  const system = [
    personaInstructions(prefs),
    UNTRUSTED_CONTENT_POLICY,
    [
      'How to answer:',
      '- Answer from the RECORDS and FACTS below only. Cite every record you rely on inline with its ref in square brackets, e.g. [E2] or [T1].',
      `- Connected sources: ${connected.join('; ') || 'none'}. If the user asks about something not covered by these records or sources, say you don't have access to it rather than guessing.`,
      '- Distinguish facts from your suggestions. Never invent meetings, deadlines, people or commitments.',
      '- You cannot send, post, schedule or change anything. When asked to draft a reply, write the draft; the user can save or send it from the Inbox after reviewing it.',
      '- Unconfirmed AI-suggested tasks are only suggestions; say so if you mention them.',
      '- Use short paragraphs or bullet lists. Use Markdown.',
    ].join('\n'),
    `FACTS:\n${facts.join('\n')}`,
    `RECORDS:\n${records.join('\n') || '(no records)'}`,
  ].join('\n\n');

  const messagesForModel = [...history.map((h) => ({ role: h.role, content: h.content })), { role: 'user' as const, content: input.message }];
  try {
    await checkBudget(deps, ai, user.id, tz);
    const r = await ai.provider.streamChat({ model: ai.model, system, messages: messagesForModel, onText: (d) => emit({ type: 'delta', text: d }), signal });
    await recordUsage(deps, user.id, ai, 'chat', { model: r.model, ...r.usage }, null);
    const cited = Array.from(new Set([...r.text.matchAll(/\[([CEMT]\d{1,3})\]/g)].map((m) => m[1]!)))
      .map((ref) => refs.byRef.get(ref))
      .filter((x): x is SourceRef => !!x);
    const [saved] = await deps.db.insert(schema.chatMessages).values({ userId: user.id, threadId, role: 'assistant', content: r.text, citations: cited, model: r.model }).returning();
    emit({ type: 'done', messageId: saved!.id, citations: cited, model: r.model });
  } catch (e) {
    const err = e instanceof AIError ? e : new AIError('unavailable', 'failed', true);
    await recordUsage(deps, user.id, ai, 'chat', null, err);
    emit({ type: 'error', code: err.code, message: AI_ERROR_MESSAGES[err.code] });
  }
}

function uniq<T extends { id: string }>(xs: T[]): T[] {
  const s = new Set<string>();
  return xs.filter((x) => (s.has(x.id) ? false : (s.add(x.id), true)));
}

export async function listThreads(deps: Deps, userId: string) {
  const rows = await deps.db
    .select({
      threadId: schema.chatMessages.threadId,
      first: sql<string>`(array_agg(${schema.chatMessages.content} order by ${schema.chatMessages.createdAt}))[1]`,
      updatedAt: sql<string>`max(${schema.chatMessages.createdAt})`,
    })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.userId, userId))
    .groupBy(schema.chatMessages.threadId)
    .orderBy(desc(sql`max(${schema.chatMessages.createdAt})`))
    .limit(30);
  return rows.map((r) => ({ threadId: r.threadId, title: r.first.slice(0, 80), updatedAt: new Date(r.updatedAt).toISOString() }));
}

export async function threadMessages(deps: Deps, userId: string, threadId: string) {
  return deps.db
    .select()
    .from(schema.chatMessages)
    .where(and(eq(schema.chatMessages.userId, userId), eq(schema.chatMessages.threadId, threadId)))
    .orderBy(asc(schema.chatMessages.createdAt));
}

const draftSchema = z.object({ subject: z.string(), body: z.string(), notes: z.string().nullable().describe('Anything the user should check before sending, e.g. facts you could not verify.') });

export async function draftReply(deps: Deps, user: AuthedUser, itemId: string, instructions: string) {
  const [row] = await deps.db.select().from(schema.items).where(and(eq(schema.items.id, itemId), eq(schema.items.userId, user.id)));
  if (!row || row.kind !== 'email') throw notFound('Email');
  const email = toItem(row) as EmailItem;
  const settings = await getSettings(deps, user.id);
  const ai = await getActiveAI(deps, user);
  if (!ai) throw new AppError(409, 'ai_not_configured', AI_ERROR_MESSAGES.not_configured);
  try {
    const r = await runJSON(deps, user, ai, settings.timezone, 'draft', {
      system: [
        personaInstructions(toPreferences(settings, user.email)),
        UNTRUSTED_CONTENT_POLICY,
        'Write a reply email on behalf of the user. Do not promise anything the user has not asked you to promise; leave placeholders like [confirm date] where a fact is unknown. Sign off with the user’s first name.',
      ].join('\n\n'),
      user: `Email to reply to (from ${email.data.from.name ?? ''} <${email.data.from.email ?? ''}>):\n${untrusted('E1', 'email', `Subject: ${email.title}\n${email.data.bodyText || email.data.snippet}`, 3000)}\n\nUser's instructions for the reply: ${sanitizeText(instructions || 'Reply appropriately and concisely.', 1000)}`,
      schema: draftSchema,
      schemaName: 'email_draft',
    });
    const subject = /^re:/i.test(email.title) ? email.title : `Re: ${email.title}`;
    return { to: email.data.from.email ? [email.data.from.email] : [], cc: [], subject: r.data.subject || subject, body: r.data.body, notes: r.data.notes, connectionId: row.connectionId, itemId: row.id, model: r.model };
  } catch (e) {
    if (e instanceof AIError) throw new AppError(e.code === 'rate_limited' ? 429 : 502, `ai_${e.code}`, AI_ERROR_MESSAGES[e.code]);
    throw e;
  }
}
