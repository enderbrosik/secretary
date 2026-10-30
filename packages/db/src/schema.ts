import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const createdAt = () => ts('created_at').notNull().defaultNow();

// ---------------------------------------------------------------------------
// Accounts & sessions
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  /** Per-user data-encryption key, wrapped (encrypted) with the server master key. */
  wrappedDataKey: text('wrapped_data_key').notNull(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the session token; the raw token only ever lives in the cookie / OS keychain. */
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    client: text('client').notNull().$type<'web' | 'desktop'>(),
    csrfToken: text('csrf_token').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// AI providers (BYOK)
// ---------------------------------------------------------------------------

export const aiProviders = pgTable(
  'ai_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().$type<'openai' | 'anthropic' | 'ollama'>(),
    encryptedKey: text('encrypted_key').notNull(),
    keyHint: text('key_hint').notNull(),
    model: text('model'),
    active: boolean('active').notNull().default(true),
    monthlyBudgetUsd: doublePrecision('monthly_budget_usd'),
    inputPricePerMTok: doublePrecision('input_price_per_mtok'),
    outputPricePerMTok: doublePrecision('output_price_per_mtok'),
    sendEmailBodies: boolean('send_email_bodies').notNull().default(true),
    lastTestedAt: ts('last_tested_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ai_providers_user_provider_uq').on(t.userId, t.provider)],
);

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    purpose: text('purpose').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd'),
    success: boolean('success').notNull(),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (t) => [index('ai_usage_user_time_idx').on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export interface ConnectionFeatures {
  calendar: boolean;
  email: boolean;
  messages: boolean;
  tasks: boolean;
}

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().$type<'google' | 'microsoft' | 'slack' | 'todoist' | 'demo'>(),
    externalAccountId: text('external_account_id').notNull(),
    accountLabel: text('account_label').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    tier: text('tier').notNull().$type<'read' | 'draft' | 'write'>().default('read'),
    features: jsonb('features').notNull().$type<ConnectionFeatures>(),
    encryptedTokens: text('encrypted_tokens'),
    tokenExpiresAt: ts('token_expires_at'),
    status: text('status').notNull().$type<'active' | 'error' | 'reauth_required'>().default('active'),
    lastSyncAt: ts('last_sync_at'),
    lastSyncError: text('last_sync_error'),
    syncState: jsonb('sync_state').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('connections_user_provider_account_uq').on(t.userId, t.provider, t.externalAccountId)],
);

export const oauthStates = pgTable('oauth_states', {
  state: text('state').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  encryptedVerifier: text('encrypted_verifier').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  tier: text('tier').notNull(),
  features: jsonb('features').notNull().$type<ConnectionFeatures>(),
  returnTo: text('return_to').notNull().default('/settings/integrations'),
  createdAt: createdAt(),
  expiresAt: ts('expires_at').notNull(),
});

/** Normalized emails, events and chat messages from every integration. */
export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    kind: text('kind').notNull().$type<'email' | 'event' | 'message'>(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    occurredAt: ts('occurred_at').notNull(),
    sourceUpdatedAt: ts('source_updated_at').notNull(),
    data: jsonb('data').notNull(),
    contentHash: text('content_hash').notNull(),
    searchText: tsvector('search_text').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(data->>'snippet', '') || ' ' || coalesce(data->>'text', '') || ' ' || coalesce(data->>'description', ''))`,
    ),
    createdAt: createdAt(),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('items_dedupe_uq').on(t.userId, t.connectionId, t.kind, t.externalId),
    index('items_user_kind_time_idx').on(t.userId, t.kind, t.occurredAt),
    index('items_search_idx').using('gin', t.searchText),
  ],
);

// ---------------------------------------------------------------------------
// Tasks & projects
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    color: text('color').notNull().default('#4f6bed'),
    status: text('status').notNull().$type<'active' | 'paused' | 'done'>().default('active'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('projects_user_idx').on(t.userId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    priority: text('priority').notNull().$type<'urgent' | 'high' | 'medium' | 'low'>().default('medium'),
    dueAt: ts('due_at'),
    dueIsAllDay: boolean('due_is_all_day').notNull().default(false),
    estimateMinutes: integer('estimate_minutes'),
    status: text('status').notNull().$type<'todo' | 'in_progress' | 'waiting' | 'blocked' | 'done' | 'canceled'>().default('todo'),
    source: text('source').notNull().default('internal'),
    sourceUrl: text('source_url'),
    sourceItemId: uuid('source_item_id').references(() => items.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    dependsOn: uuid('depends_on').array().notNull().default(sql`'{}'::uuid[]`),
    waitingOn: text('waiting_on'),
    nextAction: text('next_action'),
    notes: text('notes').notNull().default(''),
    origin: text('origin').notNull().$type<'user' | 'integration' | 'ai_suggested'>().default('user'),
    confirmed: boolean('confirmed').notNull().default(true),
    /** Reason shown with AI-suggested tasks. */
    suggestionReason: text('suggestion_reason'),
    postponeCount: integer('postpone_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    startedAt: ts('started_at'),
  },
  (t) => [
    index('tasks_user_status_idx').on(t.userId, t.status),
    uniqueIndex('tasks_external_uq').on(t.userId, t.connectionId, t.externalId).where(sql`external_id is not null`),
    uniqueIndex('tasks_suggestion_uq').on(t.userId, t.sourceItemId).where(sql`origin = 'ai_suggested' and source_item_id is not null`),
  ],
);

export const taskEvents = pgTable(
  'task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    fromValue: text('from_value'),
    toValue: text('to_value'),
    createdAt: createdAt(),
  },
  (t) => [index('task_events_task_idx').on(t.taskId), index('task_events_user_time_idx').on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Briefings, reviews, assistant
// ---------------------------------------------------------------------------

export const briefings = pgTable(
  'briefings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    content: jsonb('content').notNull(),
    mode: text('mode').notNull(),
    trigger: text('trigger').notNull().$type<'scheduled' | 'manual' | 'onboarding'>(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('briefings_user_date_uq').on(t.userId, t.date)],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    content: jsonb('content').notNull(),
    corrections: jsonb('corrections').notNull().default([]),
    mode: text('mode').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reviews_user_date_uq').on(t.userId, t.date)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').notNull(),
    role: text('role').notNull().$type<'user' | 'assistant'>(),
    content: text('content').notNull(),
    citations: jsonb('citations').notNull().default([]),
    model: text('model'),
    createdAt: createdAt(),
  },
  (t) => [index('chat_user_thread_idx').on(t.userId, t.threadId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Approvals, notifications, jobs, audit
// ---------------------------------------------------------------------------

export const pendingActions = pgTable(
  'pending_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    summary: text('summary').notNull(),
    payload: jsonb('payload').notNull(),
    origin: text('origin').notNull(),
    status: text('status').notNull().$type<'pending' | 'executing' | 'done' | 'failed' | 'rejected'>().default('pending'),
    result: jsonb('result'),
    error: text('error'),
    createdAt: createdAt(),
    decidedAt: ts('decided_at'),
    executedAt: ts('executed_at'),
  },
  (t) => [index('pending_actions_user_status_idx').on(t.userId, t.status)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** Possibly sensitive detail; only shown in-app or in OS notifications when previews are enabled. */
    body: text('body').notNull().default(''),
    link: text('link'),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: createdAt(),
    readAt: ts('read_at'),
  },
  (t) => [uniqueIndex('notifications_dedupe_uq').on(t.userId, t.dedupeKey), index('notifications_user_time_idx').on(t.userId, t.createdAt)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Idempotency key, e.g. "briefing:<user>:2026-10-29". A second enqueue is a no-op. */
    dedupeKey: text('dedupe_key').notNull().unique(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().$type<'queued' | 'running' | 'succeeded' | 'failed' | 'dead'>().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(4),
    runAt: ts('run_at').notNull().defaultNow(),
    lockedAt: ts('locked_at'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('jobs_status_run_idx').on(t.status, t.runAt), index('jobs_user_idx').on(t.userId, t.createdAt)],
);

export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull().$type<'succeeded' | 'failed'>(),
    error: text('error'),
    durationMs: integer('duration_ms').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('job_runs_user_time_idx').on(t.userId, t.createdAt)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    target: text('target'),
    detail: jsonb('detail').notNull().default({}),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_user_time_idx').on(t.userId, t.createdAt)],
);
