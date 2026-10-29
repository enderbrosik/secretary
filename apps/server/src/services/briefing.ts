import { and, desc, eq } from 'drizzle-orm';
import { AI_ERROR_MESSAGES, AIError } from '@secretary/ai';
import {
  briefingAIOutputSchema,
  briefingSystemPrompt,
  briefingUserPrompt,
  buildBriefingContext,
  composeBriefing,
  localDate,
  type Briefing,
} from '@secretary/core';
import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';
import { getActiveAI, runJSON } from './ai.js';
import { getSettings, toPreferences } from './settings.js';
import { loadUser } from './sync.js';
import { loadWorkspace } from './workspace.js';

export async function generateBriefing(deps: Deps, userId: string, trigger: 'scheduled' | 'manual' | 'onboarding'): Promise<Briefing> {
  const user = await loadUser(deps, userId);
  const settings = await getSettings(deps, userId);
  const prefs = toPreferences(settings, user.email);
  const ws = await loadWorkspace(deps, userId, settings.timezone);
  const ctx = buildBriefingContext({ now: deps.now(), prefs, ...ws });

  let aiOut = null;
  let aiError: string | null = null;
  let model: string | null = null;
  const ai = await getActiveAI(deps, user);
  if (!ai) aiError = AI_ERROR_MESSAGES.not_configured;
  else {
    try {
      const r = await runJSON(deps, user, ai, settings.timezone, 'briefing', {
        system: briefingSystemPrompt(prefs),
        user: briefingUserPrompt(ctx),
        schema: briefingAIOutputSchema,
        schemaName: 'morning_briefing',
      });
      aiOut = r.data;
      model = r.model;
    } catch (e) {
      aiError = e instanceof AIError ? AI_ERROR_MESSAGES[e.code] : AI_ERROR_MESSAGES.unavailable;
      deps.log.warn({ code: e instanceof AIError ? e.code : 'unknown' }, 'briefing AI enrichment failed; using rule-based briefing');
    }
  }
  const briefing = composeBriefing(ctx, aiOut, { model, aiError });

  // AI-detected tasks are stored for review (unconfirmed) unless the user enabled auto-extraction.
  for (const s of briefing.suggestedTasks) {
    await deps.db
      .insert(schema.tasks)
      .values({
        userId,
        title: s.title,
        description: s.explicitDeadline ? `Deadline mentioned in the source: ${s.explicitDeadline}` : '',
        source: 'internal',
        sourceItemId: s.sourceItemId,
        sourceUrl: s.sourceUrl,
        origin: 'ai_suggested',
        confirmed: settings.autoExtractTasks,
        suggestionReason: s.reason,
      })
      .onConflictDoNothing();
  }

  const date = localDate(deps.now(), settings.timezone);
  await deps.db
    .insert(schema.briefings)
    .values({ userId, date, content: briefing, mode: briefing.mode, trigger })
    .onConflictDoUpdate({
      target: [schema.briefings.userId, schema.briefings.date],
      set: { content: briefing, mode: briefing.mode, trigger, updatedAt: deps.now().toISOString() },
    });
  return briefing;
}

export async function latestBriefing(deps: Deps, userId: string, date?: string) {
  const q = deps.db.select().from(schema.briefings);
  const [row] = date
    ? await q.where(and(eq(schema.briefings.userId, userId), eq(schema.briefings.date, date))).limit(1)
    : await q.where(eq(schema.briefings.userId, userId)).orderBy(desc(schema.briefings.date)).limit(1);
  return row ?? null;
}
