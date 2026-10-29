import { NavLink, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { api, setBearer, usesBearer } from '../lib/api';
import { clearSessionToken } from '../lib/platform';
import { useMe } from '../lib/queries';
import { AISettings } from '../components/settings/AISettings';
import { IntegrationSettings } from '../components/settings/IntegrationSettings';
import { GeneralSettings } from '../components/settings/PreferenceSettings';
import { ActivitySettings, AutomationSettings, PrivacySettings, SecuritySettings } from '../components/settings/SystemSettings';
import { Button, cn, PageHeader, Spinner } from '../ui';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI provider' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'automations', label: 'Automations & alerts' },
  { id: 'privacy', label: 'Privacy & data' },
  { id: 'security', label: 'Security' },
  { id: 'activity', label: 'Activity log' },
];

export default function SettingsPage() {
  const { tab = 'general' } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  if (!me.data?.settings) return <Spinner />;
  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    if (usesBearer()) await clearSessionToken();
    setBearer(null);
    qc.clear();
    nav('/login');
    window.location.reload();
  };
  return (
    <div>
      <PageHeader title="Settings" actions={<Button variant="ghost" icon={<LogOut className="size-4" />} onClick={signOut}>Sign out</Button>} />
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col scrollbar-thin" aria-label="Settings sections">
          {TABS.map((t) => (
            <NavLink key={t.id} to={`/settings/${t.id}`} className={({ isActive }) => cn('shrink-0 rounded-lg px-3 py-1.5 text-[13.5px]', isActive ? 'bg-surface font-medium text-ink shadow-card' : 'text-ink-2 hover:bg-bg-subtle')}>
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">
          {tab === 'general' && <GeneralSettings />}
          {tab === 'ai' && <AISettings />}
          {tab === 'integrations' && <IntegrationSettings />}
          {tab === 'automations' && <AutomationSettings />}
          {tab === 'privacy' && <PrivacySettings />}
          {tab === 'security' && <SecuritySettings />}
          {tab === 'activity' && <ActivitySettings />}
        </div>
      </div>
    </div>
  );
}
