import { DateTime } from 'luxon';
import type { EmailItem, MessageItem } from './types.js';

export const EMAIL_CATEGORIES = [
  'needs_reply',
  'urgent',
  'waiting_for_me',
  'informational',
  'can_wait',
] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export const EMAIL_CATEGORY_LABELS: Record<EmailCategory, string> = {
  needs_reply: 'Needs a reply',
  urgent: 'Urgent',
  waiting_for_me: 'Waiting for me',
  informational: 'Informational',
  can_wait: 'Can probably wait',
};

// A bare "today" is not urgency ("ahead of today's sync"); it must be tied to a deadline or request.
const URGENT_RE = /\b(urgent|asap|as soon as possible|immediately|eod|end of (the )?day|(by|before|until) (the end of )?today|today at the latest|(needs?|need it|due) (\w+ ){0,3}today)\b/i;
const REQUEST_RE =
  /\?|\b(can you|could you|would you|please|let me know|thoughts|approve|approval|review|sign|confirm|feedback|need (you|your))\b/i;
const WAITING_RE = /\b(waiting (on|for) you|following up|follow(ing)?-up|gentle reminder|reminder|any update|still need)\b/i;

export interface EmailSignals {
  category: EmailCategory;
  reasons: string[];
  /** Days since last message in the thread when the user hasn't replied. */
  unansweredDays: number | null;
  score: number;
}

/**
 * Deterministic first-pass classification. The AI may refine wording and
 * category, but these signals are what the UI shows when AI is unavailable.
 */
export function emailSignals(e: EmailItem, now: Date): EmailSignals {
  const d = e.data;
  const text = `${e.title}\n${d.snippet}`;
  const reasons: string[] = [];
  const ageDays = Math.max(0, DateTime.fromJSDate(now).diff(DateTime.fromISO(e.occurredAt), 'days').days);
  const unanswered = !d.lastMessageFromMe && !d.isBulk && d.directToMe;
  let score = 0;

  if (d.isBulk) {
    reasons.push('Looks like a newsletter or automated message');
    return { category: d.isImportant ? 'informational' : 'can_wait', reasons, unansweredDays: null, score: d.isImportant ? 10 : 0 };
  }
  if (d.isImportant) {
    score += 15;
    reasons.push('Marked important by your mail provider');
  }
  if (d.isUnread) score += 5;
  if (d.directToMe) score += 10;

  const urgent = URGENT_RE.test(text) && ageDays < 2;
  const request = REQUEST_RE.test(text);
  const waiting = WAITING_RE.test(text) || (d.messageCount > 1 && unanswered && ageDays >= 2);

  let category: EmailCategory;
  if (urgent && unanswered) {
    category = 'urgent';
    score += 40;
    reasons.push('Contains time-sensitive language and you have not replied');
  } else if (waiting && unanswered) {
    category = 'waiting_for_me';
    score += 30;
    reasons.push('Sender appears to be following up and is waiting on you');
  } else if (request && unanswered) {
    category = 'needs_reply';
    score += 25;
    reasons.push('Contains a direct question or request and you have not replied');
  } else if (!d.directToMe) {
    category = 'informational';
    reasons.push('You are cc’d or on a list rather than a direct recipient');
  } else {
    category = d.isUnread ? 'informational' : 'can_wait';
  }
  if (unanswered && ageDays >= 3) {
    score += 10;
    reasons.push(`No reply for ${Math.floor(ageDays)} days`);
  }
  return { category, reasons, unansweredDays: unanswered ? Math.floor(ageDays) : null, score };
}

export interface MessageSignals {
  important: boolean;
  reasons: string[];
  looksLikeRequest: boolean;
  score: number;
}

export function messageSignals(m: MessageItem): MessageSignals {
  const d = m.data;
  const reasons: string[] = [];
  let score = 0;
  if (d.fromMe) return { important: false, reasons, looksLikeRequest: false, score: 0 };
  if (d.mentionsMe) {
    score += 30;
    reasons.push('You were mentioned');
  }
  if (d.channelType === 'dm' || d.channelType === 'group_dm') {
    score += 20;
    reasons.push('Direct message');
  }
  const looksLikeRequest = REQUEST_RE.test(d.text);
  if (looksLikeRequest) {
    score += 15;
    reasons.push('Contains a question or request');
  }
  if (d.awaitingReply && (d.mentionsMe || d.channelType === 'dm')) {
    score += 10;
    reasons.push('No reply yet');
  }
  if (URGENT_RE.test(d.text)) score += 10;
  return { important: score >= 30, reasons, looksLikeRequest, score };
}
