import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SimpleChatFolderSelector } from '@/components/chat/simple-chat-folder-selector';
import type { FormEvent, KeyboardEvent } from 'react';
import { MarkdownRenderer } from '@/components/chat/markdown-renderer';
import {
  SimpleChatBubble,
  SimpleChatTranscript,
} from '@/components/chat/simple-chat-transcript';
import {
  Bot,
  ExternalLink,
  Globe2,
  Loader2,
  MessageCircle,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { VoiceDictationButton } from '@/components/chat/voice-dictation-button';
import { SimpleChatModelSelector } from '@/components/chat/simple-chat-model-selector';
import { useSimpleChatActivityStore } from '@/stores/simple-chat-activity-store';

interface ChatSource {
  title: string;
  url: string;
}

interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  sources: ChatSource[];
  totalTokens: number;
  createdAt: number;
}

interface ChatThread {
  id: string;
  title: string;
  model: string;
  cwd: string;
  projectId?: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ChatStatus {
  configured: boolean;
  model: string;
  webSearch: boolean;
  backend: 'openai' | 'codex';
}

interface ThreadDetail {
  thread: ChatThread;
  messages: ChatMessage[];
}

function apiHeaders(hasBody = false) {
  const authorization = getAuthorizationHeader();
  return {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(`/api/simple-chat${path}`), {
    ...init,
    headers: { ...apiHeaders(init?.body !== undefined), ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    message?: string;
  };
  if (!response.ok) {
    throw new Error(
      payload.message || `La requête a échoué (HTTP ${response.status}).`,
    );
  }
  return payload;
}

export function SimpleChatRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const requestedThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread,
  });
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState<string>();
  const messagesRef = useRef<HTMLDivElement>(null);
  const setThreadActive = useSimpleChatActivityStore(
    (state) => state.setThreadActive,
  );

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId),
    [threads, activeThreadId],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<ChatStatus>('/status'),
      api<{ models: string[] }>('/models'),
      api<{ threads: ChatThread[] }>('/threads'),
    ])
      .then(([nextStatus, modelResult, threadResult]) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setModels(modelResult.models);
        setThreads(threadResult.threads);
        const selected = threadResult.threads.some(
          (thread) => thread.id === requestedThreadId,
        )
          ? requestedThreadId
          : threadResult.threads[0]?.id;
        setActiveThreadId(selected);
        if (selected && selected !== requestedThreadId) {
          void navigate({
            to: '/simple-chat',
            search: { thread: selected },
            replace: true,
          });
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : 'Chargement impossible.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, requestedThreadId]);

  useEffect(() => {
    if (!requestedThreadId || requestedThreadId === activeThreadId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setActiveThreadId(requestedThreadId);
    });
    return () => {
      cancelled = true;
    };
  }, [requestedThreadId, activeThreadId]);

  useEffect(() => {
    if (!activeThreadId) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setMessages([]);
      });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLoadingThread(true);
    });
    api<ThreadDetail>(`/threads/${activeThreadId}`)
      .then((detail) => {
        if (!cancelled) setMessages(detail.messages);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Conversation inaccessible.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingThread(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId]);

  useEffect(() => {
    const scroller = messagesRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const changeModel = async (model: string) => {
    if (!activeThreadId) return;
    try {
      const detail = await api<ThreadDetail>(`/threads/${activeThreadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ model }),
      });
      setThreads((current) =>
        current.map((thread) =>
          thread.id === detail.thread.id ? detail.thread : thread,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: ['simple-chat-threads'] });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Changement de modèle impossible.',
      );
    }
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || sending || !status?.configured) return;
    const threadId = activeThreadId;
    if (!threadId) {
      setError('Crée d’abord une conversation depuis un workspace.');
      return;
    }
    const temporary: ChatMessage = {
      id: crypto.randomUUID(),
      threadId,
      role: 'user',
      content: text,
      model: null,
      sources: [],
      totalTokens: 0,
      createdAt: Date.now(),
    };
    setMessages((current) => [...current, temporary]);
    setInput('');
    setSending(true);
    setThreadActive(threadId, true);
    setError(undefined);
    try {
      const result = await api<{ message: ChatMessage; thread: ChatThread }>(
        `/threads/${threadId}/messages`,
        { method: 'POST', body: JSON.stringify({ message: text }) },
      );
      setMessages((current) => [...current, result.message]);
      setThreads((current) => [
        result.thread,
        ...current.filter((thread) => thread.id !== result.thread.id),
      ]);
      void queryClient.invalidateQueries({ queryKey: ['simple-chat-threads'] });
    } catch (caught) {
      setMessages((current) =>
        current.filter((message) => message.id !== temporary.id),
      );
      setInput(text);
      setError(
        caught instanceof Error ? caught.message : 'La requête a échoué.',
      );
    } finally {
      setSending(false);
      setThreadActive(threadId, false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <SimpleChatTranscript scrollRef={messagesRef}>
          {status && !status.configured && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
              La clé API OpenAI n’est pas encore configurée.
            </div>
          )}
          {!activeThreadId && !loadingThread && (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <MessageCircle className="mx-auto mb-3 h-8 w-8" />
              Crée une conversation ou envoie directement un message.
            </div>
          )}
          {loadingThread && (
            <Loader2 className="mx-auto mt-16 h-6 w-6 animate-spin" />
          )}
          {messages.map((message) => (
            <SimpleChatBubble key={message.id} role={message.role}>
              {message.role === 'assistant' ? (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <MarkdownRenderer
                    content={message.content}
                    completed
                    copyResponse
                  />
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{message.content}</p>
              )}
              {message.sources?.length > 0 && (
                <div className="mt-3 border-t pt-2">
                  <p className="mb-1 text-[11px] font-medium opacity-70">
                    Sources
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {message.sources.map((source) => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-64 items-center gap-1 truncate rounded border px-2 py-1 text-[11px] hover:bg-accent"
                      >
                        <ExternalLink className="h-3 w-3 shrink-0" />{' '}
                        {source.title}
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {message.role === 'assistant' && (
                <p className="mt-2 text-[11px] opacity-55">
                  {message.model} · {message.totalTokens} jetons
                </p>
              )}
            </SimpleChatBubble>
          ))}
          {sending && (
            <div className="mr-auto flex items-center gap-2 rounded-2xl border bg-card px-4 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Réponse en cours…
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error ===
              'The active folder is unresolved. Select an available project resource before starting a new operation.'
                ? t('activeFolderNeedsResolution')
                : error}
            </p>
          )}
        </SimpleChatTranscript>

        <form
          onSubmit={(event) => void send(event)}
          className="shrink-0 bg-background px-3 pt-3 pb-0 sm:pb-3"
        >
          {status?.backend === 'codex' && activeThread?.projectId && (
            <SimpleChatFolderSelector
              key={activeThread.id}
              projectId={activeThread.projectId}
              threadId={activeThread.id}
              disabled={sending || loadingThread}
              onSelected={() => setError(undefined)}
            />
          )}
          <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-card shadow-lg transition-all duration-200 focus-within:outline-2 focus-within:outline-primary/40">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Écris ton message…"
              className="max-h-40 min-h-20 resize-none border-none bg-transparent px-4 pt-3 shadow-none focus-visible:ring-0"
              maxLength={6_000}
              disabled={sending || status?.configured === false}
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="flex min-w-0 items-center gap-1">
                {status?.backend === 'codex' ? (
                  <span
                    className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground"
                    title="Modèle et effort définis dans le projet"
                  >
                    <Bot className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">
                      Configuration du projet
                    </span>
                  </span>
                ) : (
                  <SimpleChatModelSelector
                    value={activeThread?.model || status?.model || ''}
                    onChange={(model) => void changeModel(model)}
                    disabled={!activeThread || sending}
                    models={models}
                  />
                )}
                <span
                  className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground"
                  title="Recherche Web disponible"
                  aria-label="Recherche Web disponible"
                >
                  <Globe2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Web</span>
                </span>
                <span
                  className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground"
                  title="Aucun accès au serveur"
                  aria-label="Aucun accès au serveur"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Isolé</span>
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <VoiceDictationButton
                  disabled={sending || status?.configured === false}
                  onTranscript={(text) =>
                    setInput((current) =>
                      current.trimEnd()
                        ? `${current.trimEnd()} ${text.trim()}`
                        : text.trim(),
                    )
                  }
                />
                <Button
                  type="submit"
                  size="icon"
                  className="h-7 w-7 rounded-lg"
                  disabled={!input.trim() || sending || !status?.configured}
                  aria-label="Envoyer"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </form>
      </section>
    </main>
  );
}
