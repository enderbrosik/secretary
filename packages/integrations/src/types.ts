import type { Item, TaskPriority } from '@secretary/core';

export type ProviderId = 'google' | 'microsoft' | 'slack' | 'todoist' | 'demo';
export type Tier = 'read' | 'draft' | 'write';

export interface Features {
  calendar: boolean;
  email: boolean;
  messages: boolean;
  tasks: boolean;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** A normalized record before it has a database id. */
export type NewItem = DistributiveOmit<Item, 'id' | 'connectionId'>;

export interface ExternalTask {
  externalId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  dueAt: string | null;
  dueIsAllDay: boolean;
  estimateMinutes: number | null;
  completed: boolean;
  completedAt: string | null;
  url: string | null;
  updatedAt: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
  /** Provider-specific extras (e.g. Slack user id / team). */
  extra: Record<string, string>;
}

export interface AccountInfo {
  externalId: string;
  label: string;
  email: string | null;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  /** Microsoft tenant ("common", "organizations" or a tenant id). */
  tenant?: string;
}

export interface SyncContext {
  tokens: TokenSet;
  account: AccountInfo;
  features: Features;
  now: Date;
  timezone: string;
  syncState: Record<string, unknown>;
  /** Whether full email bodies may be fetched (user privacy setting). */
  includeBodies: boolean;
}

export interface SyncResult {
  items: NewItem[];
  tasks: ExternalTask[];
  /**
   * Windows that were fully re-read: existing records of this kind whose
   * occurredAt falls in [from, to) and were not returned are deleted.
   */
  replaceWindows: { kind: Item['kind']; from: string; to: string }[];
  syncState: Record<string, unknown>;
}

export interface DraftEmailInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Reply to this thread / message when present. */
  replyToExternalId?: string | null;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  description?: string;
  timezone: string;
  /** Focus blocks are created without attendees, as "busy". */
  attendees?: string[];
}

export interface ActionResult {
  externalId: string | null;
  url: string | null;
  message: string;
}

/**
 * Integration contract. Every connector reads into the normalized model and
 * exposes only the write operations its granted scopes allow. Write methods
 * are invoked solely by the approval executor after explicit user approval.
 */
export interface Connector {
  readonly provider: ProviderId;
  readonly name: string;
  readonly supports: Features;
  readonly usesPkce: boolean;
  scopesFor(features: Features, tier: Tier): string[];
  /** Human-readable explanation of each scope, shown before consent. */
  describeScopes(features: Features, tier: Tier): { scope: string; why: string }[];
  buildAuthUrl(p: { creds: ClientCredentials; redirectUri: string; state: string; codeChallenge: string; scopes: string[] }): string;
  exchangeCode(p: { creds: ClientCredentials; code: string; codeVerifier: string; redirectUri: string }): Promise<{ tokens: TokenSet; account: AccountInfo }>;
  /** Alternative to OAuth: connect with a token the user created in the provider (verified first). */
  connectWithToken?(token: string): Promise<{ tokens: TokenSet; account: AccountInfo }>;
  refresh?(tokens: TokenSet, creds: ClientCredentials): Promise<TokenSet>;
  revoke?(tokens: TokenSet, creds: ClientCredentials): Promise<void>;
  sync(ctx: SyncContext): Promise<SyncResult>;
  createDraft?(ctx: SyncContext, input: DraftEmailInput): Promise<ActionResult & { draftId: string }>;
  sendDraft?(ctx: SyncContext, draftId: string): Promise<ActionResult>;
  createEvent?(ctx: SyncContext, input: CreateEventInput): Promise<ActionResult>;
  completeTask?(ctx: SyncContext, externalId: string): Promise<ActionResult>;
}

export type IntegrationErrorCode = 'auth_expired' | 'insufficient_scope' | 'rate_limited' | 'unavailable' | 'bad_response' | 'not_supported' | 'config_missing';

export class IntegrationError extends Error {
  constructor(
    public readonly code: IntegrationErrorCode,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
  get retryable() {
    return this.code === 'rate_limited' || this.code === 'unavailable';
  }
}
