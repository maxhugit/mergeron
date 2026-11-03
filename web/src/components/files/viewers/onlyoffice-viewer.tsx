/** OnlyOffice Docs integration for DOCX/XLSX/PPTX editing and preview. */
import { useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  Save,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { onlyOfficeGetConfig } from '@/generated/api/sdk.gen';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { Button } from '@/components/ui/button';
import {
  connectOfficeAssistant,
  type OfficeAssistantBridge,
} from './onlyoffice-assistant-bridge';

interface Props {
  filePath: string;
  readOnly?: boolean;
}

interface OnlyOfficeEditor {
  destroyEditor?: () => void;
  refreshHistory?: (data: Record<string, unknown>) => void;
  setHistoryData?: (data: Record<string, unknown>) => void;
}

type EditorStatus =
  | 'loading'
  | 'ready'
  | 'editing'
  | 'saving'
  | 'saved'
  | 'view'
  | 'error';

interface OnlyOfficeApi {
  DocEditor: new (
    elementId: string,
    config: Record<string, unknown>,
  ) => OnlyOfficeEditor;
}

declare global {
  interface Window {
    DocsAPI?: OnlyOfficeApi;
  }
}

export function OnlyOfficeViewer({ filePath, readOnly = false }: Props) {
  const { t } = useTranslation();
  const elementId = `onlyoffice-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const editorRef = useRef<OnlyOfficeEditor | null>(null);
  const [status, setStatus] = useState<EditorStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  // Reset status when filePath changes (adjusting state during render)
  const [prevFilePath, setPrevFilePath] = useState(filePath);
  if (filePath !== prevFilePath) {
    setPrevFilePath(filePath);
    setStatus('loading');
  }

  useEffect(() => {
    let cancelled = false;
    let disconnectAssistant: (() => void) | undefined;

    void onlyOfficeGetConfig({
      query: { path: filePath, ...(readOnly ? { mode: 'view' as const } : {}) },
      throwOnError: true,
    })
      .then(async ({ data }) => {
        await loadOnlyOfficeScript(data.scriptUrl);
        if (cancelled || !window.DocsAPI) return;
        editorRef.current?.destroyEditor?.();
        const assistant = (
          data as typeof data & { assistant?: OfficeAssistantBridge }
        ).assistant;
        if (assistant) disconnectAssistant = connectOfficeAssistant(assistant);
        const editorConfig = data.config.editorConfig as
          | { mode?: string }
          | undefined;
        data.config.events = {
          onRequestHistory: () => {
            void fetchOnlyOfficeHistory(filePath)
              .then((history) => editorRef.current?.refreshHistory?.(history))
              .catch(() =>
                editorRef.current?.refreshHistory?.({
                  error: true,
                }),
              );
          },
          onRequestHistoryData: (event: { data: number }) => {
            void fetchOnlyOfficeHistoryData(filePath, event.data)
              .then((history) => editorRef.current?.setHistoryData?.(history))
              .catch(() =>
                editorRef.current?.setHistoryData?.({
                  error: true,
                  version: event.data,
                }),
              );
          },
          onDocumentReady: () =>
            setStatus(editorConfig?.mode === 'view' ? 'view' : 'ready'),
          onDocumentStateChange: (event: { data: boolean }) =>
            setStatus(event.data ? 'editing' : 'saved'),
          onError: () => setStatus('error'),
        };
        editorRef.current = new window.DocsAPI.DocEditor(
          elementId,
          data.config,
        );
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
      disconnectAssistant?.();
      editorRef.current?.destroyEditor?.();
      editorRef.current = null;
    };
  }, [attempt, elementId, filePath, readOnly]);

  return (
    <div className="relative h-full">
      {status === 'loading' && (
        <OnlyOfficeMessage
          icon={<Loader2 className="h-4 w-4 animate-spin" />}
          message={t('loadingb04ba49f')}
        />
      )}
      {status === 'error' && (
        <OnlyOfficeMessage
          message={t('failedToLoadOnlyOfficeEditor')}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setStatus('loading');
                setAttempt((value) => value + 1);
              }}
            >
              <RefreshCw className="h-4 w-4" />
              {t('retry')}
            </Button>
          }
        />
      )}
      <div id={elementId} className="h-full w-full" />
      {status !== 'loading' && status !== 'error' && (
        <EditorStatusBadge status={status} />
      )}
    </div>
  );
}

async function fetchOnlyOfficeJson(path: string) {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(path), {
    headers: authorization ? { Authorization: authorization } : {},
  });
  if (!response.ok) throw new Error('OnlyOffice history request failed');
  return (await response.json()) as Record<string, unknown>;
}

function fetchOnlyOfficeHistory(filePath: string) {
  return fetchOnlyOfficeJson(
    `/api/onlyoffice/history?path=${encodeURIComponent(filePath)}`,
  );
}

function fetchOnlyOfficeHistoryData(filePath: string, version: number) {
  return fetchOnlyOfficeJson(
    `/api/onlyoffice/history-data?path=${encodeURIComponent(filePath)}&version=${version}`,
  );
}

/** Loads the OnlyOffice DocsAPI script, deduplicating concurrent requests. */
async function loadOnlyOfficeScript(scriptUrl: string): Promise<void> {
  if (window.DocsAPI) return;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-onlyoffice-url="${scriptUrl}"]`,
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('OnlyOffice script failed')),
        { once: true },
      );
      return;
    }
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.dataset.onlyofficeUrl = scriptUrl;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('OnlyOffice script failed'));
    document.head.appendChild(script);
  });
}

function OnlyOfficeMessage({
  icon,
  message,
  action,
}: {
  icon?: React.ReactNode;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        {icon ?? <FileText className="h-5 w-5 opacity-50" />}
        {message}
      </div>
      {action}
    </div>
  );
}

function EditorStatusBadge({
  status,
}: {
  status: Exclude<EditorStatus, 'loading' | 'error'>;
}) {
  const { t } = useTranslation();
  const state =
    status === 'editing'
      ? {
          icon: FileText,
          label: t('onlyOfficeEditing'),
          tone: 'text-amber-700 dark:text-amber-300',
        }
      : status === 'saving'
        ? {
            icon: Loader2,
            label: t('onlyOfficeSaving'),
            tone: 'text-blue-700 dark:text-blue-300',
          }
        : status === 'saved'
          ? {
              icon: CheckCircle2,
              label: t('onlyOfficeSaved'),
              tone: 'text-emerald-700 dark:text-emerald-300',
            }
          : status === 'view'
            ? {
                icon: AlertTriangle,
                label: t('onlyOfficeReadOnly'),
                tone: 'text-muted-foreground',
              }
            : {
                icon: Save,
                label: t('onlyOfficeReady'),
                tone: 'text-muted-foreground',
              };
  const Icon = state.icon;
  return (
    <div
      className={`pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 text-xs shadow-sm ${state.tone}`}
      role="status"
    >
      <Icon
        className={`h-3.5 w-3.5 ${status === 'saving' ? 'animate-spin' : ''}`}
      />
      {state.label}
    </div>
  );
}
