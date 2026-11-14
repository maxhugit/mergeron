import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileText, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  agentContextKey,
  previewGitInstructions,
  getAgentContext,
  setAgentInstructionSource,
  verifyAgentContext,
} from '@/lib/agent-context-api';
import type { ProjectWorkspaceCopySummary } from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';

export function AgentInstructionsDialog({
  threadId,
  copies,
  resourceId,
  open,
  onOpenChange,
}: {
  threadId: string;
  copies: ProjectWorkspaceCopySummary[];
  resourceId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation('workspaces');
  const session = usePlatformSession();
  const client = useQueryClient();
  const key = agentContextKey(threadId, session.data?.personId);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getAgentContext(threadId, signal),
    enabled: open,
    retry: false,
    refetchInterval: open ? 10000 : false,
  });
  const [showPreview, setShowPreview] = useState(false);
  const preview = useQuery({
    queryKey: [...key, 'preview', query.data?.copyId, query.data?.version],
    queryFn: ({ signal }) => previewGitInstructions(threadId, signal),
    enabled: open && showPreview && Boolean(query.data?.copyId),
    retry: false,
  });
  const [draft, setDraft] = useState<{
    copyId: string | null;
    version: number;
  } | null>(null);
  const save = useMutation({
    mutationFn: (selection: { copyId: string | null; version: number }) =>
      setAgentInstructionSource(threadId, selection.copyId, selection.version),
    onSuccess: (data) => {
      client.setQueryData(key, data);
      setDraft(null);
    },
  });
  const verify = useMutation({
    mutationFn: () => verifyAgentContext(threadId),
    onSuccess: (data) => client.setQueryData(key, data),
    onError: () => void query.refetch(),
  });
  const value = draft?.copyId ?? (draft ? '' : (query.data?.copyId ?? ''));
  const last = query.data?.events[0];
  const options = copies.filter(
    (copy) =>
      copy.state === 'ready' &&
      copy.sourceEnabled &&
      copy.sourceType === 'git' &&
      (!resourceId ||
        copy.sourceResourceId === resourceId ||
        copy.sourceConnectionId === resourceId ||
        copy.id === query.data?.copyId),
  );
  const admin = session.data?.role === 'administrator';
  const labels: Record<string, string> = {
    verified: t('contextVerified'),
    supplied: t('contextSupplied'),
    pending: t('contextPending'),
    unavailable: t('contextUnavailable'),
  };
  const triggers: Record<string, string> = {
    turn: t('contextTriggerTurn'),
    mcp: t('contextTriggerMcp'),
    manual: t('contextTriggerManual'),
    compaction: t('contextTriggerCompaction'),
    association: t('contextTriggerAssociation'),
    session: t('contextTriggerSession'),
  };
  const kinds: Record<string, string> = {
    server: t('contextServer'),
    profile: t('contextProfile'),
    project: t('contextProject'),
    git: t('contextGit'),
  };
  const changeOpen = (next: boolean) => {
    if (!next) {
      setDraft(null);
      setShowPreview(false);
      save.reset();
      verify.reset();
    }
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl sm:max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('contextTitle')}</DialogTitle>
          <DialogDescription>{t('contextIndependent')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto">
          {query.isPending && <p role="status">{t('contextLoading')}</p>}
          {query.data && (
            <>
              <label className="grid gap-2 text-sm">
                {t('contextSource')}
                <select
                  className="min-w-0 rounded-md border bg-background p-2"
                  value={value}
                  disabled={!admin || save.isPending}
                  onChange={(e) =>
                    setDraft({
                      copyId: e.target.value || null,
                      version: query.data!.version,
                    })
                  }
                >
                  <option value="">{t('contextNoSource')}</option>
                  {query.data.copyId &&
                    !options.some((copy) => copy.id === query.data?.copyId) && (
                      <option value={query.data.copyId}>
                        {t('contextUnavailableSource')}
                      </option>
                    )}
                  {options.map((copy) => (
                    <option key={copy.id} value={copy.id}>
                      {copy.name} · {copy.branch ?? 'HEAD'}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">
                {t('contextGitScope')}
              </p>
              {query.data.copyId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPreview(!showPreview)}
                >
                  {t('contextPreview')}
                </Button>
              )}
              {showPreview && query.data.copyId && (
                <div className="space-y-2">
                  {preview.isPending && (
                    <p role="status">{t('contextLoading')}</p>
                  )}
                  {preview.isError && (
                    <p role="alert" className="text-sm text-destructive">
                      {t('contextError')}
                    </p>
                  )}
                  {preview.data?.files.map((file) => (
                    <div key={file.path}>
                      <h4 className="text-xs font-medium">{file.path}</h4>
                      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
                        {file.text}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
              {admin && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={!draft || save.isPending}
                    onClick={() => save.mutate(draft!)}
                  >
                    {t('contextSaveAssociation')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!draft || save.isPending}
                    onClick={() => {
                      setDraft(null);
                      void query.refetch();
                    }}
                  >
                    {t('contextCancel')}
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <h3 className="text-sm font-medium">
                  {t('contextSourcesAndVersions')}
                </h3>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={verify.isPending}
                  onClick={() => verify.mutate()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('contextVerify')}
                </Button>
              </div>
              <p
                className={
                  last?.state === 'unavailable'
                    ? 'text-sm text-destructive'
                    : 'text-sm text-muted-foreground'
                }
              >
                {last
                  ? `${labels[last.state] ?? last.state} · ${new Date(last.createdAt).toLocaleString(i18n.resolvedLanguage)}`
                  : t('contextNotChecked')}
              </p>
              {(last?.sources ?? []).map((source) => (
                <div
                  className="space-y-1 border-b pb-2 text-sm"
                  key={source.kind}
                >
                  <h4 className="font-medium">
                    {kinds[source.kind] ?? source.kind}
                  </h4>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {t('contextFingerprint')} : {source.revision.slice(0, 16)}…
                  </p>
                  {source.commit && (
                    <p className="text-xs">
                      Git : {source.commit.slice(0, 12)}
                    </p>
                  )}
                  {source.files?.map((file) => (
                    <p key={file} className="break-all text-xs">
                      <FileText className="mr-1 inline h-3 w-3" />
                      {file}
                    </p>
                  ))}
                </div>
              ))}
              <h3 className="text-sm font-medium">{t('contextJournal')}</h3>
              <div className="divide-y">
                {query.data.events.map((event) => (
                  <div
                    key={event.id}
                    className="flex flex-wrap justify-between gap-1 py-2 text-xs"
                  >
                    <span>
                      {triggers[event.trigger] ?? event.trigger} ·{' '}
                      {labels[event.state] ?? event.state}
                    </span>
                    <time
                      dateTime={new Date(event.createdAt).toISOString()}
                      className="text-muted-foreground"
                    >
                      {new Date(event.createdAt).toLocaleTimeString(
                        i18n.resolvedLanguage,
                      )}
                    </time>
                  </div>
                ))}
              </div>
            </>
          )}
          {(query.isError || save.isError || verify.isError) && (
            <p role="alert" className="text-sm text-destructive">
              {t('contextError')}
            </p>
          )}
          <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            {t('contextReceiptLimit')}
          </p>
        </div>
        <div className="flex justify-end border-t pt-3">
          <Button variant="outline" onClick={() => changeOpen(false)}>
            {t('contextClose')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
