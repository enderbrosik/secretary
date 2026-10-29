import type { EmailItem, EventItem, MessageItem, Task } from './types.js';
import { normalizeSubject } from './hash.js';

const STOP = new Set(
  'the and for with from this that your you our are was were will have has had not but all any can about into over meeting call sync weekly daily re fwd fw update updates notes review quick chat team'.split(
    ' ',
  ),
);

export function keywords(text: string): Set<string> {
  return new Set(
    normalizeSubject(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

function attendeeEmails(e: EventItem): Set<string> {
  return new Set(
    e.data.attendees
      .filter((a) => !a.self && a.email)
      .map((a) => a.email!.toLowerCase()),
  );
}

/**
 * Deterministic relation finding used for meeting prep: a record is related
 * when it shares a participant with the meeting or at least two meaningful
 * keywords with its title.
 */
export function relatedToEvent(
  event: EventItem,
  emails: EmailItem[],
  messages: MessageItem[],
  tasks: Task[],
): { emails: EmailItem[]; messages: MessageItem[]; tasks: Task[] } {
  const kw = keywords(event.title);
  const people = attendeeEmails(event);
  const rEmails = emails
    .map((e) => {
      let s = overlap(kw, keywords(e.title)) * 2;
      if (e.data.from.email && people.has(e.data.from.email.toLowerCase())) s += 3;
      return { e, s };
    })
    .filter((x) => x.s >= 3 || (kw.size > 0 && overlap(kw, keywords(x.e.title)) >= 2))
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((x) => x.e);
  const rMessages = messages.filter((m) => overlap(kw, keywords(m.data.text)) >= 2).slice(0, 3);
  const rTasks = tasks
    .filter((t) => t.status !== 'done' && t.status !== 'canceled' && overlap(kw, keywords(t.title)) >= 1)
    .slice(0, 3);
  return { emails: rEmails, messages: rMessages, tasks: rTasks };
}
