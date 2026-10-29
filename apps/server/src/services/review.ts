import { and, desc, eq } from 'drizzle-orm';
import { AI_ERROR_MESSAGES, AIError } from '@secretary/ai';
import { buildReviewContext, composeReview, localDate, reviewAIOutputSchema, reviewSystemPrompt, reviewUserPrompt, type Briefing, type Review } from '@secretary/core';
import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';
import { getActiveAI, runJSON } from './ai.js';
import { getSettings, toPreferences } from './settings.js';
import { loadUser } from './sync.js';
import { loadWorkspace } from './workspace.js';

export async function generateReview(deps: Deps, userId: string): Promise<Review> {
  const user = await loadUser(deps, userId);
  const settings = await getSettings(deps, userId);
  const prefs = toPreferences(settings, user.email);
  const ws = await loadWorkspace(deps, userId, settings.timezone);
  const date = localDate(deps.now(), settings.timezone);
  const [b] = await deps.db.select().from(schema.briefings).where(and(eq(schema.briefings.userId, userId), eq(schema.briefings.date, date)));
  const briefing = b?.content as Briefing | undefined;
  const plannedTaskIds = briefing
    ? Array.from(new Set([...briefing.priorities.map((p) => p.taskId), ...briefing.plan.filter((p) => p.taskId).map((p) => p.taskId!)]))
    : [];

  const ctx = buildReviewContext({ now: deps.now(), prefs, ...ws, plannedTaskIds });
  let aiOut = null;
  let aiError: string | null = null;
  let model: string | null = null;
  const ai = await getActiveAI(deps, user);
  if (!ai) aiError = AI_ERROR_MESSAGES.not_configured;
  else {
    try {
      const r = await runJSON(deps, user, ai, settings.timezone, 'review', {
        system: reviewSystemPrompt(prefs),
        user: reviewUserPrompt(ctx),
        schema: reviewAIOutputSchema,
        schemaName: 'end_of_day_review',
      });
      aiOut = r.data;
      model = r.model;
    } catch (e) {
      aiError = e instanceof AIError ? AI_ERROR_MESSAGES[e.code] : AI_ERROR_MESSAGES.unavailable;
    }
  }
  const review = composeReview(ctx, aiOut, { model, aiError, now: deps.now() });
  await deps.db
    .insert(schema.reviews)
    .values({ userId, date, content: review, mode: review.mode })
    .onConflictDoUpdate({ target: [schema.reviews.userId, schema.reviews.date], set: { content: review, mode: review.mode, updatedAt: deps.now().toISOString() } });
  return review;
}

export async function listReviews(deps: Deps, userId: string, limit = 30) {
  return deps.db.select().from(schema.reviews).where(eq(schema.reviews.userId, userId)).orderBy(desc(schema.reviews.date)).limit(limit);
}
