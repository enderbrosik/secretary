import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { Briefing, EmailCategory, EventItem, Item, PlanBlock, Review, Settings, SourceRef, Task } from '@secretary/core';
import { api, setCsrf } from './api';

export interface Me {
  user: { id: string; email: string; displayName: string } | null;
  csrfToken?: string;
  settings?: Settings;
  demoMode?: boolean;
  localMode: boolean;
  signupAllowed?: boolean;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await api<Me>('/api/auth/me');
      setCsrf(me.csrfToken);
      return me;
    },
    staleTime: 60_000,
  });
}

export type TaskDto = Task & {
  connectionId: string | null;
  suggestionReason: string | null;
  sourceItem: { id: string; kind: string; title: string; url: string | null; source: string } | null;
  canCompleteExternally?: boolean;
};

export const useTasks = (filter: string, projectId?: string) =>
  useQuery({ queryKey: ['tasks', filter, projectId ?? null], queryFn: () => api<TaskDto[]>(`/api/tasks?filter=${filter}${projectId ? `&projectId=${projectId}` : ''}`) });

export const useBriefing = () => useQuery({ queryKey: ['briefing', 'today'], queryFn: () => api<{ briefing: Briefing | null; updatedAt: string | null }>('/api/briefings/today') });

export interface InboxEntry {
  item: Item;
  category: EmailCategory;
  reasons: string[];
  score: number;
  summary: string | null;
  whyItMatters: string | null;
  aiCategorized: boolean;
  unansweredDays: number | null;
}
export const useInbox = (kind: string) => useQuery({ queryKey: ['inbox', kind], queryFn: () => api<InboxEntry[]>(`/api/inbox?kind=${kind}`) });

export const useCalendar = (from: string, days: number) =>
  useQuery({ queryKey: ['calendar', from, days], queryFn: () => api<{ events: EventItem[]; conflicts: { a: string; b: string; overlapMinutes: number }[]; timezone: string }>(`/api/calendar?from=${from}&days=${days}`) });

export const usePlan = () =>
  useQuery({ queryKey: ['plan'], queryFn: () => api<{ date: string; blocks: PlanBlock[]; calendars: { id: string; provider: string; accountLabel: string; canWrite: boolean }[] }>('/api/plan') });

export interface ReviewSummary {
  date: string;
  mode: string;
  summary: string;
  completed: number;
  carryOver: number;
  corrections: number;
}
export const useReviews = () => useQuery({ queryKey: ['reviews'], queryFn: () => api<ReviewSummary[]>('/api/reviews') });
export const useReview = (date: string) => useQuery({ queryKey: ['review', date], queryFn: () => api<{ review: Review; corrections: unknown[] }>(`/api/reviews/${date}`), retry: false });

export interface Connection {
  id: string;
  provider: string;
  name: string;
  accountLabel: string;
  scopes: string[];
  scopeDescriptions: { scope: string; why: string }[];
  tier: 'read' | 'draft' | 'write';
  features: { calendar: boolean; email: boolean; messages: boolean; tasks: boolean };
  status: 'active' | 'error' | 'reauth_required';
  lastSyncAt: string | null;
  lastSyncError: string | null;
}
export interface ProviderInfo {
  provider: string;
  name: string;
  supports: Connection['features'];
  configured: boolean;
  setupDoc: string | null;
  redirectUri: string | null;
}
export const useIntegrations = () => useQuery({ queryKey: ['integrations'], queryFn: () => api<{ providers: ProviderInfo[]; connections: Connection[] }>('/api/integrations') });

export interface AIProviderDto {
  provider: 'openai' | 'anthropic' | 'ollama';
  keyHint: string;
  model: string | null;
  active: boolean;
  monthlyBudgetUsd: number | null;
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  defaultPrice: { input: number; output: number } | null;
  sendEmailBodies: boolean;
  lastTestedAt: string | null;
  lastError: string | null;
}
export const useAIProviders = () =>
  useQuery({ queryKey: ['ai-providers'], queryFn: () => api<{ available: Record<string, { name: string; keyUrl: string; billingNote: string; keyPrefix: string }>; configured: AIProviderDto[] }>('/api/ai/providers') });

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}
export const useNotifications = () =>
  useQuery({ queryKey: ['notifications'], queryFn: () => api<{ notifications: Notification[]; showPreviews: boolean; desktop: boolean }>('/api/notifications'), refetchInterval: 60_000 });

export interface PendingAction {
  id: string;
  type: string;
  summary: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'executing' | 'done' | 'failed' | 'rejected';
  error: string | null;
  result: { url?: string | null; message?: string } | null;
  origin: string;
  createdAt: string;
}
export const useActions = (status?: string) => useQuery({ queryKey: ['actions', status ?? 'all'], queryFn: () => api<PendingAction[]>(`/api/actions${status ? `?status=${status}` : ''}`), refetchInterval: 30_000 });

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  status: 'active' | 'paused' | 'done';
  stats: { total: number; done: number; overdue: number };
}
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') });

export interface ChatCitation extends SourceRef {}

/** Mutation helper that invalidates the given query keys on success. */
export function useApiMutation<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
    },
  });
}
