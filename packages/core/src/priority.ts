import { DateTime } from 'luxon';
import type { Task, TaskPriority } from './types.js';
import { dayBounds } from './time.js';

export interface PriorityScore {
  taskId: string;
  score: number;
  /** Fact-based reasons, e.g. "Due today", "Blocks 2 other tasks". */
  reasons: string[];
  dueState: 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'later' | 'none';
  blocks: string[];
  blockedBy: string[];
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { urgent: 40, high: 25, medium: 10, low: 0 };

export function isOpen(t: Task): boolean {
  return t.status !== 'done' && t.status !== 'canceled';
}

export function dueState(t: Task, date: string, tz: string): PriorityScore['dueState'] {
  if (!t.dueAt) return 'none';
  const { start, end } = dayBounds(date, tz);
  const due = DateTime.fromISO(t.dueAt).setZone(tz);
  // All-day deadlines are due at the end of their local day.
  const effective = t.dueIsAllDay ? due.endOf('day') : due;
  if (effective < start) return 'overdue';
  if (effective < end) return 'today';
  if (effective < end.plus({ days: 1 })) return 'tomorrow';
  if (effective < end.plus({ days: 7 })) return 'this_week';
  return 'later';
}

/**
 * Deterministic task ranking. The AI explains and may re-order the top items,
 * but deadlines, overdue state and dependencies always come from this function.
 */
export function scoreTasks(tasks: Task[], date: string, tz: string): PriorityScore[] {
  const open = tasks.filter((t) => isOpen(t) && t.confirmed);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blocksMap = new Map<string, string[]>();
  for (const t of open) {
    for (const dep of t.dependsOn) {
      if (!blocksMap.has(dep)) blocksMap.set(dep, []);
      blocksMap.get(dep)!.push(t.id);
    }
  }

  return open
    .map((t) => {
      const reasons: string[] = [];
      let score = PRIORITY_WEIGHT[t.priority];
      if (t.priority === 'urgent' || t.priority === 'high') reasons.push(`Marked ${t.priority} priority`);
      const ds = dueState(t, date, tz);
      switch (ds) {
        case 'overdue':
          score += 50;
          reasons.push('Overdue');
          break;
        case 'today':
          score += 40;
          reasons.push('Due today');
          break;
        case 'tomorrow':
          score += 25;
          reasons.push('Due tomorrow');
          break;
        case 'this_week':
          score += 10;
          reasons.push('Due this week');
          break;
        default:
          break;
      }
      const blocks = blocksMap.get(t.id) ?? [];
      if (blocks.length) {
        score += 12 * blocks.length;
        reasons.push(`Blocks ${blocks.length} other task${blocks.length > 1 ? 's' : ''}`);
      }
      const blockedBy = t.dependsOn.filter((d) => {
        const dep = byId.get(d);
        return dep ? isOpen(dep) : false;
      });
      if (blockedBy.length || t.status === 'blocked') {
        score -= 30;
        reasons.push(blockedBy.length ? 'Waiting on another task to finish' : 'Marked blocked');
      }
      if (t.status === 'waiting') {
        score -= 20;
        reasons.push(t.waitingOn ? `Waiting on ${t.waitingOn}` : 'Waiting on someone else');
      }
      if (t.status === 'in_progress') {
        score += 8;
        reasons.push('Already in progress');
      }
      if (t.postponeCount >= 2) {
        score += 5;
        reasons.push(`Postponed ${t.postponeCount} times`);
      }
      return { taskId: t.id, score, reasons, dueState: ds, blocks, blockedBy };
    })
    .sort((a, b) => b.score - a.score || a.taskId.localeCompare(b.taskId));
}
