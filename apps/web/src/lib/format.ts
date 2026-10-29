import { DateTime } from 'luxon';

export const fmtTime = (iso: string, tz: string) => DateTime.fromISO(iso).setZone(tz).toFormat('h:mm a');
export const fmtDay = (iso: string, tz: string) => DateTime.fromISO(iso).setZone(tz).toFormat('ccc, LLL d');
export const fmtDateTime = (iso: string, tz: string) => DateTime.fromISO(iso).setZone(tz).toFormat('ccc, LLL d · h:mm a');
export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  return DateTime.fromISO(iso).toRelative() ?? '';
}
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}
export function fmtDue(iso: string | null, allDay: boolean, tz: string): string | null {
  if (!iso) return null;
  const d = DateTime.fromISO(iso).setZone(tz);
  const today = DateTime.now().setZone(tz).startOf('day');
  const diff = Math.round(d.startOf('day').diff(today, 'days').days);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : diff > 1 && diff < 7 ? d.toFormat('cccc') : d.toFormat('LLL d');
  return allDay ? day : `${day} ${d.toFormat('h:mm a')}`;
}
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.replace(/[<>@].*$/, '').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase() || '?';
}
export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
