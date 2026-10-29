import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, LogOut, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Settings } from '@secretary/core';
import { api, apiBase, errorMessage, setBearer, usesBearer } from '../../lib/api';
import { fmtDateTime, fmtRelative } from '../../lib/format';
import { checkForUpdates, clearSessionToken, getAutostart, getDesktopPrefs, isDesktop, requestWebNotificationPermission, setAutostart, setDesktopPrefs } from '../../lib/platform';
import { useMe } from '../../lib/queries';
import { Badge, Banner, Button, Card, CardHeader, Dialog, Field, Input, Select, Switch } from '../../ui';
import { useSettingsSaver } from './PreferenceSettings';

export function AutomationSettings() {
  const me = useMe();
  const s = me.data!.settings!;
  const save = useSettingsSaver();
  const status = useQuery({ queryKey: ['automations'], queryFn: () => api<{ jobsEnabled: boolean; nextBriefing: string; nextReview: string; lastBriefingJob: { status: string; at: string; error: string | null } | null; lastReviewJob: { status: string; at: string; error: string | null } | null }>('/api/automations') });
  const a = s.automations;
  const n = s.notifications;
  const setA = (patch: Partial<Settings['automations']>) => void save({ automations: patch });
  const setN = (patch: Partial<Settings['notifications']>) => void save({ notifications: patch });
  const tz = s.timezone;
  return (
    <div className="flex flex-col gap-6">
      {a.paused && <Banner tone="warn" title="All automations are paused">No briefings, reviews, reminders or background syncs will run until you resume.</Banner>}
      {status.data && !status.data.jobsEnabled && <Banner tone="warn">Background jobs are disabled on this server (JOBS_ENABLED=false). Scheduled items won’t run automatically.</Banner>}
      <Card>
        <CardHeader
          title="Automations"
          subtitle="Each one can be turned off. Scheduled work runs on the server, so it doesn’t depend on a browser tab being open."
          actions={
            <Button size="sm" variant={a.paused ? 'primary' : 'secondary'} onClick={() => setA({ paused: !a.paused })}>
              {a.paused ? 'Resume all' : 'Pause all'}
            </Button>
          }
        />
        <div className="divide-y divide-line px-5 pb-3">
          <Switch checked={a.morningBriefing} onCheckedChange={(v) => setA({ morningBriefing: v })} label="Morning briefing" description={status.data ? `Next: ${fmtDateTime(status.data.nextBriefing, tz)}${status.data.lastBriefingJob ? ` · last run ${status.data.lastBriefingJob.status} ${fmtRelative(status.data.lastBriefingJob.at)}` : ''}` : undefined} />
          <Switch checked={a.endOfDayReview} onCheckedChange={(v) => setA({ endOfDayReview: v })} label="End-of-day review" description={status.data ? `Next: ${fmtDateTime(status.data.nextReview, tz)}` : undefined} />
          <Switch checked={a.deadlineReminders} onCheckedChange={(v) => setA({ deadlineReminders: v })} label="Deadline reminders" description="An alert when a task is due within the hour." />
          <Switch checked={a.meetingPrep} onCheckedChange={(v) => setA({ meetingPrep: v })} label="Meeting preparation alerts" description={`A heads-up ${n.meetingPrepMinutes} minutes before meetings with other people.`} />
          <Switch checked={a.followUps} onCheckedChange={(v) => setA({ followUps: v })} label="Follow-up reminders" description="Once a day, if emails have been waiting on your reply for two days or more." />
          <Switch checked={a.scheduleChangeAlerts} onCheckedChange={(v) => setA({ scheduleChangeAlerts: v })} label="Schedule change alerts" description="When today’s meetings are added, moved or cancelled." />
          <Switch checked={a.backgroundSync} onCheckedChange={(v) => setA({ backgroundSync: v })} label="Background sync" description="Keep connected accounts up to date every 15 minutes." />
        </div>
      </Card>
      <Card>
        <CardHeader title="Notifications" subtitle="Calm by default. Previews stay off so sensitive details don’t appear on your lock screen." />
        <div className="divide-y divide-line px-5 pb-3">
          <Switch
            checked={n.desktop}
            onCheckedChange={async (v) => {
              if (v && !isDesktop) {
                const p = await requestWebNotificationPermission();
                if (p !== 'granted') toast.info('Your browser blocked notifications. In-app notifications still work.');
              }
              setN({ desktop: v });
            }}
            label={isDesktop ? 'System notifications' : 'Browser notifications'}
            description={isDesktop ? 'Shown by your operating system.' : 'Shown while Secretary is open in a tab.'}
          />
          <Switch checked={n.showPreviews} onCheckedChange={(v) => setN({ showPreviews: v })} label="Show message previews" description="Include names, subjects and task titles in system notifications." />
          <div className="grid gap-3 py-3 sm:grid-cols-3">
            <Field label="Meeting alert lead time">
              {(id) => (
                <Select id={id} value={String(n.meetingPrepMinutes)} onChange={(e) => setN({ meetingPrepMinutes: Number(e.target.value) })}>
                  {[5, 10, 15, 30, 60].map((m) => (
                    <option key={m} value={m}>
                      {m} minutes
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Quiet hours from">{(id) => <Input id={id} type="time" value={n.quietHours.start} onChange={(e) => setN({ quietHours: { ...n.quietHours, start: e.target.value } })} disabled={!n.quietHours.enabled} />}</Field>
            <Field label="Quiet hours until">{(id) => <Input id={id} type="time" value={n.quietHours.end} onChange={(e) => setN({ quietHours: { ...n.quietHours, end: e.target.value } })} disabled={!n.quietHours.enabled} />}</Field>
          </div>
          <Switch checked={n.quietHours.enabled} onCheckedChange={(v) => setN({ quietHours: { ...n.quietHours, enabled: v } })} label="Quiet hours" description="No alerts during these hours. Briefings are still prepared." />
        </div>
      </Card>
      {isDesktop && <DesktopSettings />}
    </div>
  );
}

function DesktopSettings() {
  const [autostart, setAuto] = useState<boolean | null>(null);
  const [prefs, setPrefs] = useState<{ trayEnabled: boolean; closeToTray: boolean } | null>(null);
  useEffect(() => {
    void getAutostart().then(setAuto);
    void getDesktopPrefs().then(setPrefs);
  }, []);
  return (
    <Card>
      <CardHeader title="Desktop app" subtitle="Local mode runs scheduled jobs only while Secretary is running (it can stay in the menu bar / system tray)." />
      <div className="divide-y divide-line px-5 pb-3">
        {autostart !== null && <Switch checked={autostart} onCheckedChange={async (v) => { await setAutostart(v); setAuto(v); }} label="Launch at login" description="Recommended in local mode so morning briefings are ready on time." />}
        {prefs && (
          <>
            <Switch checked={prefs.trayEnabled} onCheckedChange={async (v) => { const p = { ...prefs, trayEnabled: v }; await setDesktopPrefs(p); setPrefs(p); }} label="Show in menu bar / system tray" description="Quick access to today’s priorities." />
            <Switch checked={prefs.closeToTray} onCheckedChange={async (v) => { const p = { ...prefs, closeToTray: v }; await setDesktopPrefs(p); setPrefs(p); }} label="Keep running when the window is closed" description="Background sync and notifications continue." />
          </>
        )}
        <div className="py-3">
          <Button size="sm" onClick={async () => { const r = await checkForUpdates(); r.error ? toast.error(r.error) : r.available ? toast.success(`Update ${r.version} is downloading and will install on restart.`) : toast.success('You’re on the latest version.'); }}>
            Check for updates
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function PrivacySettings() {
  const me = useMe();
  const s = me.data!.settings!;
  const save = useSettingsSaver();
  const nav = useNavigate();
  const qc = useQueryClient();
  const ai = useQuery({ queryKey: ['ai-data'], queryFn: () => api<{ sent: string[]; neverSent: string[]; note: string }>('/api/privacy/ai-data') });
  const [del, setDel] = useState(false);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="What your AI provider receives" subtitle={ai.data?.note} />
        {ai.data && (
          <div className="grid gap-5 px-5 pb-5 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Sent, when relevant to a request</div>
              <ul className="space-y-1 text-[13px] text-muted">
                {ai.data.sent.map((x) => (
                  <li key={x}>• {x}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Never sent</div>
              <ul className="space-y-1 text-[13px] text-muted">
                {ai.data.neverSent.map((x) => (
                  <li key={x}>• {x}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Data retention" subtitle="Synced emails, events and messages, chat history, briefings and reviews older than this are deleted automatically." />
        <div className="px-5 pb-5">
          <Select value={String(s.retentionDays)} onChange={(e) => void save({ retentionDays: Number(e.target.value) }, 'Retention updated')} className="max-w-xs" aria-label="Retention period">
            {[7, 30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </Select>
        </div>
      </Card>
      <Card>
        <CardHeader title="Your data" />
        <div className="flex flex-wrap gap-2 px-5 pb-5">
          <Button
            icon={<Download className="size-4" />}
            onClick={async () => {
              try {
                const data = await api('/api/data/export');
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `secretary-export-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(a.href);
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Export all data
          </Button>
          <Button
            onClick={async () => {
              if (!window.confirm('Delete all synced emails, events and messages, plus briefings and chat history? Your account, tasks and connections stay.')) return;
              await api('/api/data/synced', { method: 'DELETE' });
              await qc.invalidateQueries();
              toast.success('Synced data deleted. It will be re-synced on the next sync unless you disconnect the accounts.');
            }}
          >
            Delete synced data
          </Button>
          <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDel(true)}>
            Delete account
          </Button>
        </div>
      </Card>
      <Dialog
        open={del}
        onOpenChange={setDel}
        title="Delete your account permanently?"
        description="This revokes access to every connected account, deletes your API keys, tasks, synced data, briefings and history. It cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDel(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={confirm !== 'DELETE' || !pw}
              onClick={async () => {
                try {
                  await api('/api/account', { method: 'DELETE', body: { password: pw, confirm } });
                  if (usesBearer()) await clearSessionToken();
                  setBearer(null);
                  qc.clear();
                  nav('/login');
                  window.location.reload();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Delete everything
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Your password">{(id) => <Input id={id} type="password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
          <Field label='Type "DELETE" to confirm'>{(id) => <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </div>
  );
}

export function SecuritySettings() {
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ id: string; client: string; userAgent: string | null; ip: string | null; lastSeenAt: string; current: boolean }[]>('/api/auth/sessions') });
  const qc = useQueryClient();
  const nav = useNavigate();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Signed-in devices"
          actions={
            <Button
              size="sm"
              icon={<LogOut className="size-3.5" />}
              onClick={async () => {
                await api('/api/auth/logout-all', { method: 'POST', body: {} });
                if (usesBearer()) await clearSessionToken();
                qc.clear();
                nav('/login');
                window.location.reload();
              }}
            >
              Sign out everywhere
            </Button>
          }
        />
        <ul className="px-5 pb-4">
          {sessions.data?.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 border-t border-line py-2.5 text-[13px] first:border-t-0">
              <Badge>{s.client}</Badge>
              <span className="min-w-0 flex-1 truncate text-muted">{s.userAgent ?? 'Unknown device'}</span>
              <span className="text-[12px] text-faint">active {fmtRelative(s.lastSeenAt)}</span>
              {s.current ? (
                <Badge tone="ok">This device</Badge>
              ) : (
                <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' }); void sessions.refetch(); }}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Change password" subtitle="Other devices are signed out when you change it." />
        <div className="grid gap-3 px-5 pb-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Current password">{(id) => <Input id={id} type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />}</Field>
          <Field label="New password">{(id) => <Input id={id} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} />}</Field>
          <Button
            disabled={!cur || next.length < 10}
            onClick={async () => {
              try {
                await api('/api/auth/password', { method: 'POST', body: { currentPassword: cur, newPassword: next } });
                setCur('');
                setNext('');
                toast.success('Password changed');
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Update
          </Button>
        </div>
      </Card>
      <Card className="p-5 text-[13px] text-muted">
        <p>
          Server: <code>{apiBase() || window.location.origin}</code>. Credentials (API keys, OAuth tokens) are encrypted at rest with per-user keys and never sent to this device. {isDesktop ? 'Your session token is stored in the operating system’s credential store.' : 'Your session uses a secure, HTTP-only cookie.'}
        </p>
      </Card>
    </div>
  );
}

export function ActivitySettings() {
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api<{ id: string; action: string; target: string | null; detail: Record<string, unknown>; ip: string | null; createdAt: string }[]>('/api/audit') });
  const runs = useQuery({ queryKey: ['job-runs'], queryFn: () => api<{ id: string; type: string; status: string; attempt: number; error: string | null; durationMs: number; createdAt: string }[]>('/api/jobs/runs') });
  const me = useMe();
  const tz = me.data?.settings?.timezone ?? 'UTC';
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Audit log" subtitle="Sign-ins, connections, permission changes and every approved action." />
        <ul className="max-h-[560px] overflow-y-auto px-5 pb-4 scrollbar-thin">
          {audit.data?.map((a) => (
            <li key={a.id} className="border-t border-line py-2 text-[13px] first:border-t-0">
              <div className="flex items-center justify-between gap-2">
                <code className="text-[12px] text-ink">{a.action}</code>
                <span className="text-[11.5px] text-faint">{fmtDateTime(a.createdAt, tz)}</span>
              </div>
              {Object.keys(a.detail ?? {}).length > 0 && <div className="mt-0.5 truncate text-[12px] text-muted">{JSON.stringify(a.detail)}</div>}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Background jobs" subtitle="Recent scheduled runs and their results." />
        <ul className="max-h-[560px] overflow-y-auto px-5 pb-4 scrollbar-thin">
          {!runs.data?.length && <li className="py-3 text-[13px] text-muted">No runs yet.</li>}
          {runs.data?.map((r) => (
            <li key={r.id} className="flex items-center gap-2 border-t border-line py-2 text-[13px] first:border-t-0">
              <Badge tone={r.status === 'succeeded' ? 'ok' : 'danger'}>{r.status}</Badge>
              <span className="capitalize">{r.type}</span>
              {r.attempt > 1 && <span className="text-[12px] text-faint">attempt {r.attempt}</span>}
              <span className="min-w-0 flex-1 truncate text-[12px] text-danger">{r.error}</span>
              <span className="text-[11.5px] text-faint">{fmtRelative(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
