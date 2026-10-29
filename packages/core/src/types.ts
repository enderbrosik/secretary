/**
 * Normalized domain model shared by every integration, the server and the UI.
 * Every record carries its source and a link back to the original where one exists.
 */

export const SOURCES = ['google', 'microsoft', 'slack', 'todoist', 'demo', 'internal'] as const;
export type Source = (typeof SOURCES)[number];

export type ItemKind = 'email' | 'event' | 'message';

export interface Person {
  name: string | null;
  email: string | null;
}

export interface EmailData {
  threadId: string;
  from: Person;
  to: Person[];
  cc: Person[];
  snippet: string;
  /** Plain-text body, already truncated by the connector. Untrusted. */
  bodyText: string;
  labels: string[];
  isUnread: boolean;
  isImportant: boolean;
  /** True when the most recent message in the thread was sent by the user. */
  lastMessageFromMe: boolean;
  messageCount: number;
  /** Mailing-list / bulk indicators (List-Unsubscribe, noreply, promotions). */
  isBulk: boolean;
  /** Recipients include the user directly (To:), not only cc / list. */
  directToMe: boolean;
}

export type AttendeeResponse = 'accepted' | 'declined' | 'tentative' | 'needsAction' | 'unknown';

export interface Attendee extends Person {
  response: AttendeeResponse;
  organizer: boolean;
  self: boolean;
}

export interface EventData {
  start: string; // ISO with offset
  end: string;
  allDay: boolean;
  location: string | null;
  description: string; // untrusted
  attendees: Attendee[];
  organizer: Person | null;
  conferenceUrl: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  selfResponse: AttendeeResponse;
  calendarName: string | null;
}

export interface MessageData {
  channelId: string;
  channelName: string | null;
  channelType: 'dm' | 'group_dm' | 'channel' | 'private_channel';
  author: { id: string; name: string | null };
  text: string; // untrusted
  threadTs: string | null;
  mentionsMe: boolean;
  fromMe: boolean;
  /** For DMs / threads: true if nobody (incl. the user) replied after this message. */
  awaitingReply: boolean;
}

interface ItemBase {
  id: string;
  source: Source;
  connectionId: string | null;
  externalId: string;
  title: string;
  url: string | null;
  occurredAt: string; // ISO
  updatedAt: string; // ISO
}

export type Item =
  | (ItemBase & { kind: 'email'; data: EmailData })
  | (ItemBase & { kind: 'event'; data: EventData })
  | (ItemBase & { kind: 'message'; data: MessageData });

export type EmailItem = Extract<Item, { kind: 'email' }>;
export type EventItem = Extract<Item, { kind: 'event' }>;
export type MessageItem = Extract<Item, { kind: 'message' }>;

export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'waiting',
  'blocked',
  'done',
  'canceled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * user            – created by the user in the app
 * integration     – synced from a task service (Todoist), already confirmed by the user there
 * ai_suggested    – proposed by the assistant from an email / message; needs review
 */
export type TaskOrigin = 'user' | 'integration' | 'ai_suggested';

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  /** Real deadline from the user or the source system. Never set by the AI without confirmation. */
  dueAt: string | null;
  dueIsAllDay: boolean;
  estimateMinutes: number | null;
  status: TaskStatus;
  source: Source;
  sourceUrl: string | null;
  sourceItemId: string | null;
  externalId: string | null;
  projectId: string | null;
  dependsOn: string[];
  waitingOn: string | null;
  nextAction: string | null;
  notes: string;
  origin: TaskOrigin;
  confirmed: boolean;
  postponeCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startedAt: string | null;
}

export interface WorkHours {
  start: string; // "09:00"
  end: string; // "17:30"
  days: number[]; // ISO weekday 1=Mon .. 7=Sun
}

export interface UserPreferences {
  timezone: string;
  workHours: WorkHours;
  briefingTime: string; // "07:30"
  reviewTime: string; // "17:30"
  assistantStyle: 'concise' | 'friendly' | 'formal' | 'coach';
  detailLevel: 'brief' | 'standard' | 'detailed';
  displayName: string;
  email: string;
}

/** Labels every statement shown to the user with where it came from. */
export type Provenance = 'fact' | 'inference' | 'suggestion';

export interface SourceRef {
  /** Short id used in prompts, e.g. "E3", "T1". */
  ref: string;
  kind: 'email' | 'event' | 'message' | 'task';
  id: string;
  title: string;
  url: string | null;
  source: Source;
}

export interface FreshnessInfo {
  connectionId: string;
  provider: Source;
  label: string;
  lastSyncedAt: string | null;
  stale: boolean;
  status: 'ok' | 'error' | 'never_synced' | 'disconnected';
  error: string | null;
}
