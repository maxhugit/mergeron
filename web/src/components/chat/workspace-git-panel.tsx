import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { GitBranch, RefreshCw, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GitCopyActions, GitMergeAction } from './workspace-git-actions';
import type { GitDiffTarget } from '@/stores/workspace-store';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileTree } from '@/components/files/file-tree';
import { filesAddRoot } from '@/generated/api';
import { useFilesStore } from '@/stores/files-store';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectWorkspaceCopySummary,
} from '@/lib/projects-api';
import {
  gitGet,
  gitInventoryKey,
  type GitInventory,
  type GitSnapshot,
  type GitPullRequests,
  type GitChecks,
} from '@/lib/workspace-git-api';

interface Props {
  projectId: string;
  resourceId: string | null;
  onSelect: (id: string | null) => void;
  cwd: string | null;
  activeWorkspacePending: boolean;
  onActiveWorkspaceChange?: (path: string) => void;
  onFile: (path: string) => void;
  onGitDiff?: (target: GitDiffTarget) => void;
  children: ReactNode;
}

/** Browsing a repository never changes the agent's workspace. */
export function WorkspaceGitPanel(props: Props) {
  const { t } = useTranslation('workspaces');
  const inventory = useQuery({
    queryKey: gitInventoryKey(props.projectId),
    queryFn: async ({ signal }): Promise<GitInventory> => {
      const inventory = await getProjectLocations(props.projectId, signal);
      return {
        resources: connectionResourceViews(inventory),
        copies: inventory.copies,
      };
    },
    refetchInterval: 15000,
  });
  const resources =
    inventory.data?.resources.filter((item) => item.type === 'git') ?? [];
  const resource = resources.find((item) => item.id === props.resourceId);
  return (
    <>
      {resources.length > 0 && (
        <nav
          aria-label={t('gitRepositories')}
          className="shrink-0 space-y-1 border-b p-2"
        >
          {resources.map((item) => (
            <Button
              key={item.id}
              variant={item.id === props.resourceId ? 'secondary' : 'ghost'}
              size="sm"
              className="h-auto w-full min-w-0 justify-start gap-2 px-2 py-1 text-xs"
              aria-pressed={item.id === props.resourceId}
              onClick={() => props.onSelect(item.id)}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{item.name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {item.enabled ? 'Git' : t('gitDisabled')}
              </span>
            </Button>
          ))}
        </nav>
      )}
      {inventory.error && (
        <div role="alert" className="p-2 text-xs text-destructive">
          {t('gitInventoryError')}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void inventory.refetch()}
          >
            {t('gitRetry')}
          </Button>
        </div>
      )}
      {props.resourceId && !resource ? (
        <div role="status" className="p-3 text-xs">
          {inventory.isPending ? t('gitLoading') : t('gitResourceMissing')}
        </div>
      ) : resource ? (
        <RepositoryPanel
          key={`${props.projectId}:${resource.id}:${props.cwd}`}
          {...props}
          resource={resource}
          copies={(inventory.data?.copies ?? []).filter(
            (copy) => copy.sourceResourceId === resource.id,
          )}
        />
      ) : (
        props.children
      )}
    </>
  );
}

function RepositoryPanel({
  projectId,
  resource,
  copies,
  cwd,
  activeWorkspacePending,
  onActiveWorkspaceChange,
  onFile,
  onGitDiff,
}: Props & {
  resource: GitInventory['resources'][number];
  copies: ProjectWorkspaceCopySummary[];
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [copyId, setCopyId] = useState<string | null>(null);
  const [tab, setTab] = useState('files');
  const [branch, setBranch] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [browsed, setBrowsed] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState('');
  const browseSequence = useRef(0);
  useEffect(
    () => () => {
      browseSequence.current++;
    },
    [],
  );
  const ready = copies.filter(
    (copy) => copy.state === 'ready' && copy.sourceEnabled,
  );
  const copy =
    ready.find((item) => item.id === copyId) ??
    ready.find((item) => item.localPath === cwd) ??
    ready[0];
  const snapshot = useQuery({
    queryKey: ['workspace-git', projectId, copy?.id],
    queryFn: ({ signal }) =>
      gitGet<GitSnapshot>(
        projectId,
        `copies/${encodeURIComponent(copy!.id)}`,
        signal,
      ),
    enabled: Boolean(copy && resource.enabled),
    refetchInterval: 15000,
  });
  const clone = useMutation({
    mutationFn: () =>
      projectsApi<{ copy: ProjectWorkspaceCopySummary }>(
        `${projectConnectionsPath(projectId)}/${encodeURIComponent(resource.id)}/copies`,
        {
          method: 'POST',
          body: JSON.stringify(branch.trim() ? { branch: branch.trim() } : {}),
        },
      ),
    onSuccess: async (result) => {
      setCopyId(result.copy.id);
      setPreparing(false);
      setBranch('');
      await Promise.all([
        client.invalidateQueries({ queryKey: gitInventoryKey(projectId) }),
        client.invalidateQueries({ queryKey: projectsQueryKey }),
      ]);
    },
  });
  const browse = async () => {
    if (!copy?.localPath) return;
    const sequence = ++browseSequence.current;
    setBrowseError('');
    try {
      await filesAddRoot({
        body: { root: copy.localPath },
        throwOnError: true,
        meta: { silent: true },
      });
      if (sequence !== browseSequence.current) return;
      useFilesStore.getState().setRootDir(copy.localPath);
      setBrowsed(copy.id);
    } catch {
      if (sequence === browseSequence.current)
        setBrowseError(t('gitBrowseError'));
    }
  };
  const switchCopy = (id: string) => {
    browseSequence.current++;
    setCopyId(id);
    setBrowsed(null);
    setBrowseError('');
  };
  return (
    <section
      aria-label={resource.name}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="min-w-0 shrink-0 space-y-2 border-b p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <strong className="truncate">{resource.name}</strong>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('gitRefresh')}
            disabled={!copy || snapshot.isFetching}
            onClick={() => void snapshot.refetch()}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${snapshot.isFetching ? 'animate-spin' : ''}`}
            />
          </Button>
        </div>
        {!resource.enabled ? (
          <p>{t('gitDisabledHelp')}</p>
        ) : (
          <>
            {copy && (
              <>
                <label className="grid min-w-0 grid-cols-1 gap-1">
                  {t('gitWorkingCopy')}
                  <select
                    className="w-full min-w-0 rounded-md border bg-background p-1.5"
                    value={copy.id}
                    onChange={(event) => switchCopy(event.target.value)}
                  >
                    {ready.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {copy.localPath === cwd ? (
                  <p className="text-primary">{t('gitActiveForAgent')}</p>
                ) : (
                  onActiveWorkspaceChange && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-xs"
                      disabled={activeWorkspacePending || !copy.localPath}
                      onClick={() =>
                        copy.localPath &&
                        onActiveWorkspaceChange(copy.localPath)
                      }
                    >
                      {t('gitUseForAgent')}
                    </Button>
                  )
                )}
                {snapshot.data && !snapshot.error && (
                  <div className="space-y-1">
                    <p className="break-all">
                      <GitBranch className="mr-1 inline h-3.5 w-3.5" />
                      {snapshot.data.branch ?? t('gitDetached')} ·{' '}
                      {snapshot.data.head.slice(0, 7) || t('gitNoCommit')}
                    </p>
                    <p>
                      {t('gitTracking', {
                        ahead: snapshot.data.ahead,
                        behind: snapshot.data.behind,
                      })}
                      {!snapshot.data.upstream && ` · ${t('gitNoUpstream')}`}
                    </p>
                    <p className="text-muted-foreground">
                      {t('gitLocalSnapshot')}
                    </p>
                  </div>
                )}
              </>
            )}
            {!copy && <p className="text-muted-foreground">{t('gitNoCopy')}</p>}
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              disabled={clone.isPending}
              onClick={() => setPreparing(!preparing)}
            >
              {t(copy ? 'gitAnotherCopy' : 'gitPrepareCopy')}
            </Button>
            {preparing && (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!clone.isPending) clone.mutate();
                }}
              >
                <label className="grid gap-1">
                  {t('gitExistingBranch')}
                  <input
                    className="w-full rounded-md border bg-background p-2"
                    value={branch}
                    maxLength={200}
                    disabled={clone.isPending}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder={t('gitDefaultBranch')}
                  />
                </label>
                <p className="text-muted-foreground">{t('gitCopyHelp')}</p>
                <Button type="submit" size="sm" disabled={clone.isPending}>
                  {clone.isPending && (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  )}
                  {t('gitConfirmCopy')}
                </Button>
              </form>
            )}
          </>
        )}
        {clone.error && (
          <p role="alert" className="text-destructive">
            {t('gitCloneFailed')}
          </p>
        )}
        {snapshot.error && (
          <p role="alert" className="text-destructive">
            {t('gitInspectionError')}
          </p>
        )}
        {copy &&
          copy.accessMode === 'read_write' &&
          resource.accessMode === 'read_write' &&
          snapshot.data &&
          !snapshot.error && (
            <GitCopyActions
              key={copy.id}
              projectId={projectId}
              copyId={copy.id}
              snapshot={snapshot.data}
              address={resource.address}
            />
          )}
      </div>
      {resource.enabled && (
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
        >
          <TabsList className="flex h-auto w-full shrink-0 flex-wrap rounded-none border-b bg-transparent p-1">
            {['files', 'changes', 'branches', 'prs'].map((id) => (
              <TabsTrigger
                className="min-w-0 px-2 py-1 text-[11px]"
                key={id}
                value={id}
              >
                {t(
                  id === 'files'
                    ? 'gitTabFiles'
                    : id === 'changes'
                      ? 'gitTabChanges'
                      : id === 'branches'
                        ? 'gitTabBranches'
                        : 'gitTabPrs',
                )}
                {id === 'changes' && snapshot.data && !snapshot.error
                  ? ` (${snapshot.data.changes.length})`
                  : ''}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="files" className="flex min-h-0 flex-1 flex-col">
            {copy && browsed === copy.id ? (
              <FileTree onFileClick={onFile} />
            ) : copy ? (
              <div className="p-3">
                <Button size="sm" onClick={() => void browse()}>
                  {t('gitBrowse')}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('gitBrowseHelp')}
                </p>
              </div>
            ) : (
              <p className="p-3 text-xs">{t('gitNoCopy')}</p>
            )}
            {browseError && (
              <p role="alert" className="p-3 text-xs text-destructive">
                {browseError}
              </p>
            )}
          </TabsContent>
          <TabsContent
            value="changes"
            className="min-h-0 flex-1 overflow-auto p-2"
          >
            {copy && snapshot.data && !snapshot.error ? (
              <Changes
                projectId={projectId}
                copy={copy}
                snapshot={snapshot.data}
                onGitDiff={onGitDiff}
              />
            ) : (
              <p className="p-1 text-xs">
                {t(snapshot.isPending && copy ? 'gitLoading' : 'gitNoSnapshot')}
              </p>
            )}
          </TabsContent>
          <TabsContent
            value="branches"
            className="min-h-0 flex-1 overflow-auto p-3 text-xs"
          >
            <p className="mb-3 text-muted-foreground">{t('gitBranchesHelp')}</p>
            {snapshot.data && !snapshot.error ? (
              snapshot.data.branches.map((item) => (
                <div
                  key={`${item.remote}:${item.name}`}
                  className="border-b py-2"
                >
                  <p className="break-all font-medium">
                    {item.name}
                    {!item.remote && item.name === snapshot.data.branch
                      ? ` · ${t('gitCurrent')}`
                      : ''}
                  </p>
                  <p className="text-muted-foreground">
                    {t(item.remote ? 'gitRemoteBranch' : 'gitLocalBranch')} ·{' '}
                    {item.revision.slice(0, 7) || t('gitNoCommit')}
                  </p>
                  {item.remote && !item.name.endsWith('/HEAD') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={() => {
                        setBranch(item.name.replace(/^[^/]+\//, ''));
                        setPreparing(true);
                      }}
                    >
                      {t('gitPrepareCopy')}
                    </Button>
                  )}
                </div>
              ))
            ) : (
              <p>{t('gitNoSnapshot')}</p>
            )}
            {snapshot.data?.branchesLimited && <p>{t('gitLimited')}</p>}
          </TabsContent>
          <TabsContent value="prs" className="min-h-0 flex-1 overflow-auto">
            <PullRequests
              projectId={projectId}
              resourceId={resource.id}
              canWrite={resource.accessMode === 'read_write'}
              resourceAddress={resource.address}
            />
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}

function Changes({
  projectId,
  copy,
  snapshot,
  onGitDiff,
}: {
  projectId: string;
  copy: ProjectWorkspaceCopySummary;
  snapshot: GitSnapshot;
  onGitDiff?: (target: GitDiffTarget) => void;
}) {
  const { t } = useTranslation('workspaces');
  return (
    <>
      {snapshot.changes.length === 0 ? (
        <p className="p-1 text-xs text-muted-foreground">{t('gitClean')}</p>
      ) : (
        snapshot.changes.map((change) => (
          <Button
            key={change.path}
            size="sm"
            variant="ghost"
            className="h-auto w-full min-w-0 justify-start gap-2 py-2 text-xs"
            title={
              change.originalPath
                ? `${change.originalPath} → ${change.path}`
                : change.path
            }
            onClick={() =>
              onGitDiff?.({
                projectId,
                copyId: copy.id,
                path: change.path,
                localPath: copy.localPath,
                status: change.status,
              })
            }
          >
            <code className="shrink-0 whitespace-pre text-primary">
              {change.status}
            </code>
            <span className="truncate">{change.path}</span>
          </Button>
        ))
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {t('gitChangesHelp')}
      </p>
    </>
  );
}

function PullRequests({
  projectId,
  resourceId,
  canWrite,
  resourceAddress,
}: {
  projectId: string;
  resourceId: string;
  canWrite: boolean;
  resourceAddress: string | null;
}) {
  const { t } = useTranslation('workspaces');
  const [number, setNumber] = useState<number | null>(null);
  const [lastMerged, setLastMerged] = useState<number | null>(null);
  const refreshButton = useRef<HTMLButtonElement | null>(null);
  const statusLabels: Record<string, string> = {
    success: t('gitCheckSuccess'),
    failure: t('gitCheckFailure'),
    error: t('gitCheckError'),
    pending: t('gitCheckPending'),
    queued: t('gitCheckQueued'),
    in_progress: t('gitCheckInProgress'),
    waiting: t('gitCheckWaiting'),
    requested: t('gitCheckRequested'),
    neutral: t('gitCheckNeutral'),
    skipped: t('gitCheckSkipped'),
    cancelled: t('gitCheckCancelled'),
    timed_out: t('gitCheckTimedOut'),
    action_required: t('gitCheckActionRequired'),
    stale: t('gitCheckStale'),
  };
  const prs = useQuery({
    queryKey: ['workspace-git-prs', projectId, resourceId],
    queryFn: ({ signal }) =>
      gitGet<GitPullRequests>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/pull-requests`,
        signal,
      ),
    refetchInterval: 60000,
    retry: false,
  });
  const checks = useQuery({
    queryKey: ['workspace-git-checks', projectId, resourceId, number],
    queryFn: ({ signal }) =>
      gitGet<GitChecks>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/pull-requests/${number}/checks`,
        signal,
      ),
    enabled: number !== null,
    refetchInterval: 30000,
    retry: false,
  });
  return (
    <div className="space-y-3 p-3 text-xs">
      <Button
        ref={refreshButton}
        size="sm"
        variant="outline"
        disabled={prs.isFetching || checks.isFetching}
        onClick={() => {
          void prs.refetch();
          if (number) void checks.refetch();
        }}
      >
        {t('gitRefresh')}
      </Button>
      {lastMerged !== null && (
        <p role="status">
          #{lastMerged} · {t('gitActionMerged')}
        </p>
      )}
      {prs.isPending ? (
        <p role="status">{t('gitLoading')}</p>
      ) : prs.error ? (
        <p role="alert" className="text-destructive">
          {t('gitGithubError')}
        </p>
      ) : !prs.data?.supported ? (
        <p>{t('gitProviderUnsupported')}</p>
      ) : (
        <>
          {prs.data.items.length === 0 && <p>{t('gitNoPr')}</p>}
          {prs.data.limited && <p>{t('gitLimited')}</p>}
          {prs.data.items.map((pr) => (
            <article key={pr.number} className="space-y-2 border-b pb-3">
              <Button
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal text-left text-xs"
                aria-pressed={number === pr.number}
                onClick={() => setNumber(pr.number)}
              >
                #{pr.number} {pr.title}
                {pr.draft ? ` · ${t('gitDraft')}` : ''}
              </Button>
              <p className="break-all text-muted-foreground">
                {pr.branch} → {pr.base}
              </p>
              <a
                className="inline-flex items-center gap-1 text-primary underline"
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('gitOpenPr')}
                <ExternalLink className="h-3 w-3" />
              </a>
              {number === pr.number &&
                (checks.isPending ? (
                  <p role="status">{t('gitLoading')}</p>
                ) : checks.error ? (
                  <p role="alert" className="text-destructive">
                    {t('gitGithubError')}
                  </p>
                ) : (
                  checks.data && (
                    <div className="space-y-2">
                      <p>
                        {t('gitPrRevision', {
                          sha: checks.data.head.slice(0, 7),
                        })}
                      </p>
                      <p>
                        {t(
                          checks.data.mergeable === null
                            ? 'gitMergeUnknown'
                            : checks.data.mergeable
                              ? 'gitMergeNoConflict'
                              : 'gitMergeConflict',
                        )}
                      </p>
                      {checks.data.limited && <p>{t('gitLimited')}</p>}
                      {checks.data.items.length === 0 ? (
                        <p>{t('gitNoChecks')}</p>
                      ) : (
                        checks.data.items.map((check) => (
                          <div
                            key={check.id}
                            className="flex items-start justify-between gap-2"
                          >
                            <span className="min-w-0 break-words">
                              {check.name}
                            </span>
                            <span
                              className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${check.status === 'success' ? 'bg-emerald-500/10 text-emerald-500' : ['failure', 'error', 'timed_out', 'action_required'].includes(check.status) ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}
                            >
                              {statusLabels[check.status] ??
                                t('gitCheckUnknown')}
                            </span>
                          </div>
                        ))
                      )}
                      <p className="text-muted-foreground">
                        {t('gitMergeHelp')}
                      </p>
                      {canWrite && (
                        <GitMergeAction
                          key={pr.number}
                          projectId={projectId}
                          resourceId={resourceId}
                          number={pr.number}
                          checks={checks.data}
                          address={resourceAddress}
                          onMerged={() => setLastMerged(pr.number)}
                          onCloseFocus={() => refreshButton.current?.focus()}
                        />
                      )}
                    </div>
                  )
                ))}
            </article>
          ))}
        </>
      )}
    </div>
  );
}
import {
  getProjectLocations,
  connectionResourceViews,
  projectConnectionsPath,
} from '@/lib/project-locations-api';
