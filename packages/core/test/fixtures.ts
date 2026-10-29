import type { EmailItem, EventItem, MessageItem, Task, UserPreferences } from '../src/index.js';

export const prefs: UserPreferences = {
  timezone: 'America/New_York',
  workHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
  briefingTime: '07:30',
  reviewTime: '17:30',
  assistantStyle: 'concise',
  detailLevel: 'standard',
  displayName: 'Alex Rivera',
  email: 'alex@example.com',
};

let n = 0;
export function event(title: string, start: string, end: string, extra: Partial<EventItem['data']> = {}): EventItem {
  n++;
  return {
    id: `ev-${n}`,
    kind: 'event',
    source: 'google',
    connectionId: 'c1',
    externalId: `g-${n}`,
    title,
    url: `https://calendar.google.com/e/${n}`,
    occurredAt: start,
    updatedAt: start,
    data: {
      start,
      end,
      allDay: false,
      location: null,
      description: '',
      attendees: [
        { name: 'Alex', email: 'alex@example.com', response: 'accepted', organizer: false, self: true },
        { name: 'Sam Lee', email: 'sam@partner.com', response: 'accepted', organizer: true, self: false },
      ],
      organizer: { name: 'Sam Lee', email: 'sam@partner.com' },
      conferenceUrl: null,
      status: 'confirmed',
      selfResponse: 'accepted',
      calendarName: 'Work',
      ...extra,
    },
  };
}

export function email(subject: string, at: string, extra: Partial<EmailItem['data']> = {}): EmailItem {
  n++;
  return {
    id: `em-${n}`,
    kind: 'email',
    source: 'google',
    connectionId: 'c1',
    externalId: `m-${n}`,
    title: subject,
    url: `https://mail.google.com/mail/u/0/#all/${n}`,
    occurredAt: at,
    updatedAt: at,
    data: {
      threadId: `t-${n}`,
      from: { name: 'Sam Lee', email: 'sam@partner.com' },
      to: [{ name: 'Alex', email: 'alex@example.com' }],
      cc: [],
      snippet: subject,
      bodyText: subject,
      labels: ['INBOX'],
      isUnread: true,
      isImportant: false,
      lastMessageFromMe: false,
      messageCount: 1,
      isBulk: false,
      directToMe: true,
      ...extra,
    },
  };
}

export function message(text: string, at: string, extra: Partial<MessageItem['data']> = {}): MessageItem {
  n++;
  return {
    id: `msg-${n}`,
    kind: 'message',
    source: 'slack',
    connectionId: 'c2',
    externalId: `s-${n}`,
    title: text.slice(0, 60),
    url: `https://slack.com/archives/C1/p${n}`,
    occurredAt: at,
    updatedAt: at,
    data: {
      channelId: 'D1',
      channelName: null,
      channelType: 'dm',
      author: { id: 'U2', name: 'Jordan' },
      text,
      threadTs: null,
      mentionsMe: false,
      fromMe: false,
      awaitingReply: true,
      ...extra,
    },
  };
}

export function task(title: string, extra: Partial<Task> = {}): Task {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    title,
    description: '',
    priority: 'medium',
    dueAt: null,
    dueIsAllDay: false,
    estimateMinutes: 30,
    status: 'todo',
    source: 'internal',
    sourceUrl: null,
    sourceItemId: null,
    externalId: null,
    projectId: null,
    dependsOn: [],
    waitingOn: null,
    nextAction: null,
    notes: '',
    origin: 'user',
    confirmed: true,
    postponeCount: 0,
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-01T12:00:00Z',
    completedAt: null,
    startedAt: null,
    ...extra,
  };
}
