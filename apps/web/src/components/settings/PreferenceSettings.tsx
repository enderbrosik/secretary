import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Settings } from '@secretary/core';
import { api, errorMessage } from '../../lib/api';
import { useMe } from '../../lib/queries';
import { applyTheme } from '../../lib/theme';
import { Button, Card, CardHeader, Field, Input, Select, Switch } from '../../ui';

export function useSettingsSaver() {
  const qc = useQueryClient();
  return async (patch: Record<string, unknown>, msg = 'Saved') => {
    try {
      const s = await api<Settings>('/api/settings', { method: 'PATCH', body: patch });
      qc.setQueryData(['me'], (old: object) => ({ ...old, settings: s }));
      toast.success(msg);
      return s;
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  };
}

export const TIMEZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney'];
  }
})();

const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [7, 'Sun'],
] as const;

/** Schedule section, shared by Settings and onboarding. */
export function ScheduleFields({ value, onChange }: { value: Pick<Settings, 'timezone' | 'workHours' | 'briefingTime' | 'reviewTime'>; onChange: (v: Partial<Settings>) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Timezone" className="sm:col-span-2" hint="All times, deadlines and schedules use this zone, including daylight-saving changes.">
        {(id) => (
          <Select id={id} value={value.timezone} onChange={(e) => onChange({ timezone: e.target.value })}>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Work day starts">{(id) => <Input id={id} type="time" value={value.workHours.start} onChange={(e) => onChange({ workHours: { ...value.workHours, start: e.target.value } })} />}</Field>
      <Field label="Work day ends">{(id) => <Input id={id} type="time" value={value.workHours.end} onChange={(e) => onChange({ workHours: { ...value.workHours, end: e.target.value } })} />}</Field>
      <div className="sm:col-span-2">
        <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Work days</div>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map(([d, l]) => {
            const on = value.workHours.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ workHours: { ...value.workHours, days: on ? value.workHours.days.filter((x) => x !== d) : [...value.workHours.days, d].sort() } })}
                className={`h-8 w-12 rounded-lg border text-[12.5px] font-medium ${on ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-muted hover:border-line-strong'}`}
              >
                {l}
              </button>
            );
          })}
        </div>
      </div>
      <Field label="Morning briefing at" hint="Prepared automatically on work days.">{(id) => <Input id={id} type="time" value={value.briefingTime} onChange={(e) => onChange({ briefingTime: e.target.value })} />}</Field>
      <Field label="End-of-day review at">{(id) => <Input id={id} type="time" value={value.reviewTime} onChange={(e) => onChange({ reviewTime: e.target.value })} />}</Field>
    </div>
  );
}

export function StyleFields({ value, onChange }: { value: Pick<Settings, 'assistantStyle' | 'detailLevel'>; onChange: (v: Partial<Settings>) => void }) {
  const styles = [
    ['concise', 'Concise', 'Crisp and direct'],
    ['friendly', 'Friendly', 'Warm, still efficient'],
    ['formal', 'Formal', 'Polished and professional'],
    ['coach', 'Coach', 'Supportive and practical'],
  ] as const;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Assistant style">
        {styles.map(([v, l, d]) => (
          <button key={v} type="button" role="radio" aria-checked={value.assistantStyle === v} onClick={() => onChange({ assistantStyle: v })} className={`rounded-xl border p-3 text-left ${value.assistantStyle === v ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong'}`}>
            <div className="text-[13px] font-semibold">{l}</div>
            <div className="text-[12px] text-muted">{d}</div>
          </button>
        ))}
      </div>
      <Field label="Level of detail">
        {(id) => (
          <Select id={id} value={value.detailLevel} onChange={(e) => onChange({ detailLevel: e.target.value as Settings['detailLevel'] })}>
            <option value="brief">Brief — just the essentials</option>
            <option value="standard">Standard</option>
            <option value="detailed">Detailed — more explanation</option>
          </Select>
        )}
      </Field>
    </div>
  );
}

export function GeneralSettings() {
  const me = useMe();
  const save = useSettingsSaver();
  const s = me.data!.settings!;
  const [draft, setDraft] = useState(s);
  useEffect(() => setDraft(s), [s]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(s);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Profile" />
        <div className="grid gap-4 px-5 pb-5 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />}</Field>
          <Field label="Email">{(id) => <Input id={id} value={me.data?.user?.email ?? ''} disabled />}</Field>
          <Field label="Theme">
            {(id) => (
              <Select
                id={id}
                value={draft.theme}
                onChange={(e) => {
                  const theme = e.target.value as Settings['theme'];
                  applyTheme(theme);
                  setDraft({ ...draft, theme });
                }}
              >
                <option value="system">Match system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            )}
          </Field>
        </div>
      </Card>
      <Card>
        <CardHeader title="Schedule" subtitle="Used for planning, briefings, reviews and reminders." />
        <div className="px-5 pb-5">
          <ScheduleFields value={draft} onChange={(v) => setDraft({ ...draft, ...v })} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Assistant style" />
        <div className="px-5 pb-5">
          <StyleFields value={draft} onChange={(v) => setDraft({ ...draft, ...v })} />
          <Switch
            checked={draft.autoExtractTasks}
            onCheckedChange={(v) => setDraft({ ...draft, autoExtractTasks: v })}
            label="Add detected tasks automatically"
            description="When off (recommended), tasks the assistant finds in emails and messages wait in a review tray. When on, they’re added directly but stay labelled as AI-detected."
          />
        </div>
      </Card>
      <div className="sticky bottom-3 flex justify-end">
        <Button variant="primary" disabled={!dirty} onClick={() => void save(draft, 'Settings saved')}>
          Save changes
        </Button>
      </div>
    </div>
  );
}
