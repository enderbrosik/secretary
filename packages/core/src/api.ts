import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES } from './types.js';
import { isValidTimezone } from './time.js';

/** Request/response validation shared by the server and the web client. */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Use HH:MM (24h)');
export const timezoneSchema = z.string().refine(isValidTimezone, 'Unknown timezone');

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  displayName: z.string().trim().min(1).max(80),
  timezone: timezoneSchema.optional(),
});
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
  client: z.enum(['web', 'desktop']).default('web'),
});

export const workHoursSchema = z
  .object({ start: hhmm, end: hhmm, days: z.array(z.number().int().min(1).max(7)).min(1).max(7) })
  .refine((w) => w.start < w.end, 'Work day must end after it starts');

export const notificationPrefsSchema = z.object({
  desktop: z.boolean(),
  inApp: z.boolean(),
  showPreviews: z.boolean(), // show sender/subject in OS notifications
  deadlineReminders: z.boolean(),
  meetingPrepMinutes: z.number().int().min(0).max(240),
  followUpReminders: z.boolean(),
  quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }),
});

export const automationsSchema = z.object({
  morningBriefing: z.boolean(),
  endOfDayReview: z.boolean(),
  deadlineReminders: z.boolean(),
  meetingPrep: z.boolean(),
  followUps: z.boolean(),
  backgroundSync: z.boolean(),
  scheduleChangeAlerts: z.boolean(),
  paused: z.boolean(),
});

export const settingsSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  timezone: timezoneSchema,
  workHours: workHoursSchema,
  briefingTime: hhmm,
  reviewTime: hhmm,
  assistantStyle: z.enum(['concise', 'friendly', 'formal', 'coach']),
  detailLevel: z.enum(['brief', 'standard', 'detailed']),
  theme: z.enum(['system', 'light', 'dark']),
  notifications: notificationPrefsSchema,
  automations: automationsSchema,
  retentionDays: z.number().int().min(7).max(3650),
  autoExtractTasks: z.boolean(), // if true, AI-detected tasks are added (still labelled AI-suggested)
  onboardingCompleted: z.boolean(),
});
export type Settings = z.infer<typeof settingsSchema>;
/** Partial update; nested groups can also be patched partially (e.g. just `automations.paused`). */
export const settingsPatchSchema = settingsSchema.partial().extend({
  notifications: notificationPrefsSchema.partial().optional(),
  automations: automationsSchema.partial().optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000).default(''),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  dueAt: z.string().datetime({ offset: true }).nullable().default(null),
  dueIsAllDay: z.boolean().default(false),
  estimateMinutes: z.number().int().min(5).max(60 * 24).nullable().default(null),
  status: z.enum(TASK_STATUSES).default('todo'),
  projectId: z.string().uuid().nullable().default(null),
  dependsOn: z.array(z.string().uuid()).max(20).default([]),
  waitingOn: z.string().max(200).nullable().default(null),
  nextAction: z.string().max(500).nullable().default(null),
  notes: z.string().max(10000).default(''),
});
export const taskPatchSchema = taskInputSchema.partial();

export const projectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f6bed'),
  status: z.enum(['active', 'paused', 'done']).default('active'),
});

export const aiProviderInputSchema = z.object({
  provider: z.enum(['openai', 'anthropic']),
  apiKey: z.string().trim().min(10).max(500),
  model: z.string().max(200).optional(),
});
export const aiProviderPatchSchema = z.object({
  model: z.string().max(200).optional(),
  monthlyBudgetUsd: z.number().min(0).max(100000).nullable().optional(),
  inputPricePerMTok: z.number().min(0).max(1000).nullable().optional(),
  outputPricePerMTok: z.number().min(0).max(1000).nullable().optional(),
  sendEmailBodies: z.boolean().optional(),
  active: z.boolean().optional(),
});

export const PERMISSION_TIERS = ['read', 'draft', 'write'] as const;
export type PermissionTier = (typeof PERMISSION_TIERS)[number];
