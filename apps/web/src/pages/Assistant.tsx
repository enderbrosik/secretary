import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, MessageSquarePlus, Sparkles, Square } from 'lucide-react';
import type { SourceRef } from '@secretary/core';
import { api, apiStream, errorMessage } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { useAIProviders } from '../lib/queries';
import { Banner, Button, Card, cn, IconButton, SourceChip, Textarea } from '../ui';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: SourceRef[];
  error?: string;
}

const STARTERS = [
  'What should I focus on right now?',
  'Summarize my unread work emails.',
  'What do I need to prepare for my next meeting?',
  'Which people am I waiting on?',
  'Help me plan tomorrow.',
  'Why did you rank my top task first?',
];

export default function AssistantPage() {
  const ai = useAIProviders();
  const qc = useQueryClient();
  const threads = useQuery({ queryKey: ['threads'], queryFn: () => api<{ threadId: string; title: string; updatedAt: string }[]>('/api/assistant/threads') });
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const hasAI = ai.data?.configured.some((p) => p.active && p.model);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [messages]);

  const loadThread = async (id: string) => {
    const rows = await api<{ id: string; role: 'user' | 'assistant'; content: string; citations: SourceRef[] }[]>(`/api/assistant/threads/${id}`);
    setThreadId(id);
    setMessages(rows.map((r) => ({ ...r, citations: r.citations ?? [] })));
  };

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setInput('');
    const user: Msg = { id: crypto.randomUUID(), role: 'user', content: text, citations: [] };
    const reply: Msg = { id: crypto.randomUUID(), role: 'assistant', content: '', citations: [] };
    setMessages((m) => [...m, user, reply]);
    setBusy(true);
    abort.current = new AbortController();
    try {
      await apiStream<{ type: string; threadId?: string; text?: string; citations?: SourceRef[]; message?: string }>(
        '/api/assistant/chat',
        { threadId, message: text },
        (e) => {
          if (e.type === 'start' && e.threadId) setThreadId(e.threadId);
          if (e.type === 'delta') setMessages((m) => m.map((x) => (x.id === reply.id ? { ...x, content: x.content + e.text } : x)));
          if (e.type === 'done') setMessages((m) => m.map((x) => (x.id === reply.id ? { ...x, citations: e.citations ?? [] } : x)));
          if (e.type === 'error') setMessages((m) => m.map((x) => (x.id === reply.id ? { ...x, error: e.message } : x)));
        },
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setMessages((m) => m.map((x) => (x.id === reply.id ? { ...x, error: errorMessage(e) } : x)));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['threads'] });
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="hidden lg:block">
        <Button className="mb-3 w-full" icon={<MessageSquarePlus className="size-4" />} onClick={() => { setThreadId(null); setMessages([]); }}>
          New conversation
        </Button>
        <ul className="flex flex-col gap-0.5">
          {threads.data?.map((t) => (
            <li key={t.threadId}>
              <button onClick={() => void loadThread(t.threadId)} className={cn('w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-bg-subtle', t.threadId === threadId && 'bg-surface shadow-card')}>
                <div className="truncate text-[13px]">{t.title}</div>
                <div className="text-[11px] text-faint">{fmtRelative(t.updatedAt)}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="flex min-h-[calc(100vh-140px)] flex-col">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="font-display text-[28px] tracking-[-0.01em]">Assistant</h1>
          <IconButton label="New conversation" className="lg:hidden" onClick={() => { setThreadId(null); setMessages([]); }}>
            <MessageSquarePlus className="size-5" />
          </IconButton>
        </div>
        {!hasAI && !ai.isLoading && (
          <div className="mb-4">
            <Banner tone="info" title="Connect an AI provider to chat" action={<Link to="/settings/ai"><Button size="sm">Set up AI</Button></Link>}>
              The assistant uses your own OpenAI or Anthropic API key.
            </Banner>
          </div>
        )}
        <div className="flex-1">
          {!messages.length ? (
            <div className="flex flex-col items-center pt-10 text-center">
              <div className="flex size-11 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
                <Sparkles className="size-5" />
              </div>
              <p className="mt-3 max-w-md text-[14px] text-muted">Ask about your schedule, tasks, emails and messages. Answers cite the records they’re based on — and the assistant will tell you when it doesn’t have access to something.</p>
              <div className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                {STARTERS.map((s) => (
                  <button key={s} disabled={!hasAI} onClick={() => void send(s)} className="rounded-xl border border-line bg-surface px-4 py-3 text-left text-[13.5px] text-ink-2 shadow-card hover:border-line-strong hover:text-ink disabled:opacity-50">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-5 pb-4">
              {messages.map((m) => (
                <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  {m.role === 'user' ? (
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[14px] text-accent-ink">{m.content}</div>
                  ) : (
                    <Card className="max-w-full px-5 py-4">
                      {m.error ? (
                        <p className="text-[13.5px] text-danger">{m.error}</p>
                      ) : !m.content ? (
                        <span className="inline-flex gap-1" aria-label="Thinking">
                          {[0, 1, 2].map((i) => (
                            <span key={i} className="size-1.5 animate-bounce rounded-full bg-faint" style={{ animationDelay: `${i * 120}ms` }} />
                          ))}
                        </span>
                      ) : (
                        <div className="prose-sm text-[14px] leading-relaxed text-ink-2 [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-5">
                          <ReactMarkdown skipHtml>{m.content}</ReactMarkdown>
                        </div>
                      )}
                      {m.citations.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2.5 text-[12px] text-muted">
                          Sources:
                          {m.citations.map((c) => (
                            <span key={c.ref} className="inline-flex items-center gap-1">
                              <span className="font-medium text-ink-2">[{c.ref}]</span>
                              <span className="max-w-[220px] truncate">{c.title}</span>
                              <SourceChip source={c.source} url={c.url} label="" />
                            </span>
                          ))}
                        </div>
                      )}
                    </Card>
                  )}
                </div>
              ))}
              <div ref={bottom} />
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="sticky bottom-0 mx-auto mt-2 w-full max-w-3xl bg-bg pb-2 pt-2"
        >
          <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 shadow-card focus-within:border-accent">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              disabled={!hasAI}
              placeholder={hasAI ? 'Ask anything about your day…' : 'Connect an AI provider first'}
              className="min-h-[44px] resize-none border-0 shadow-none focus:ring-0"
              rows={1}
              aria-label="Message"
            />
            {busy ? (
              <IconButton label="Stop" onClick={() => abort.current?.abort()} className="bg-bg-subtle">
                <Square className="size-4" />
              </IconButton>
            ) : (
              <IconButton label="Send" type="submit" disabled={!input.trim() || !hasAI} className="bg-accent text-accent-ink hover:bg-accent hover:text-accent-ink">
                <ArrowUp className="size-4" />
              </IconButton>
            )}
          </div>
          <p className="mt-1.5 text-center text-[11.5px] text-faint">The assistant can read your connected data but can’t send or change anything.</p>
        </form>
      </div>
    </div>
  );
}
