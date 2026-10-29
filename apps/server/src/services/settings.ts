import { eq } from 'drizzle-orm';
import { settingsSchema, type Settings, type SettingsPatch, type UserPreferences } from '@secretary/core';
import { schema } from '@secretary/db';
import type { Deps } from '../lib/context.js';

export function defaultSettings(displayName: string, timezone = 'UTC'): Settings {
  return {
    displayName,
    timezone,
    workHours: { start: '09:00', end: '17:30', days: [1, 2, 3, 4, 5] },
    briefingTime: '07:30',
    reviewTime: '17:30',
    assistantStyle: 'concise',
    detailLevel: 'standard',
    theme: 'system',
    notifications: {
      desktop: true,
      inApp: true,
      showPreviews: false,
      deadlineReminders: true,
      meetingPrepMinutes: 15,
      followUpReminders: true,
      quietHours: { enabled: false, start: '20:00', end: '07:00' },
    },
    automations: {
      morningBriefing: true,
      endOfDayReview: true,
      deadlineReminders: true,
      meetingPrep: true,
      followUps: true,
      backgroundSync: true,
      scheduleChangeAlerts: true,
      paused: false,
    },
    retentionDays: 90,
    autoExtractTasks: false,
    onboardingCompleted: false,
  };
}

export async function getSettings(deps: Deps, userId: string): Promise<Settings> {
  const [row] = await deps.db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId));
  const fallback = defaultSettings('');
  if (!row) return fallback;
  // Merge with defaults so newly added settings get sensible values.
  const merged = { ...fallback, ...(row.settings as object) } as Settings;
  merged.notifications = { ...fallback.notifications, ...merged.notifications };
  merged.automations = { ...fallback.automations, ...merged.automations };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : fallback;
}

export async function updateSettings(deps: Deps, userId: string, patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings(deps, userId);
  const next = settingsSchema.parse({
    ...current,
    ...patch,
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    automations: { ...current.automations, ...(patch.automations ?? {}) },
  });
  await deps.db
    .insert(schema.userSettings)
    .values({ userId, settings: next })
    .onConflictDoUpdate({ target: schema.userSettings.userId, set: { settings: next, updatedAt: deps.now().toISOString() } });
  if (patch.displayName) await deps.db.update(schema.users).set({ displayName: patch.displayName }).where(eq(schema.users.id, userId));
  return next;
}

export function toPreferences(s: Settings, email: string): UserPreferences {
  return {
    timezone: s.timezone,
    workHours: s.workHours,
    briefingTime: s.briefingTime,
    reviewTime: s.reviewTime,
    assistantStyle: s.assistantStyle,
    detailLevel: s.detailLevel,
    displayName: s.displayName,
    email,
  };
}
