import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  GitBranch,
  RefreshCw,
  ExternalLink,
  Loader2,
  HardDrive,
  Cloud,
  ArrowLeftRight,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkspaceEntryMenu } from './workspace-entry-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GitRemoteFiles } from './git-remote-files';
import { GitCopyActions, GitMergeAction } from './workspace-git-actions';
import { GitCopyDelete } from './git-copy-delete';
import { GitStageChanges } from './git-stage-changes';
import { GitCopyReservation } from './git-copy-reservation';
import { GitCreateBranch } from './git-create-branch';
import { pathIsWithin } from '@/lib/file-change-events';
import type {
  GitDiffTarget,
  GitGraphTarget,
  GitRemoteFileTarget,
} from '@/stores/workspace-store';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileTree } from '@/components/files/file-tree';
import { filesAddRoot } from '@/generated/api';
import { filesReadTreeQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import { useFilesStore } from '@/stores/files-store';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectWorkspaceCopySummary,
} from '@/lib/projects-api';
import {
  gitGet,
  gitInventoryKey,
  copyOwnedByAgent,
  type GitInventory,
  type GitSnapshot,
  type GitPullRequests,
  type GitChecks,
  type GitRemoteBranches,
  type GitCommits,
} from '@/lib/workspace-git-api';

interface Props {
  agentThreadId?: string;
  projectId: string;
  resourceId: string | null;
  onSelect: (id: string | null) => void;
  cwd: string | null;
  activeWorkspacePending: boolean;
  onActiveWorkspaceChange?: (path: string) => void;
  onFile: (path: string) => void;
  onGitDiff?: (target: GitDiffTarget) => void;
  onGitGraph?: (target: GitGraphTarget) => void;
  onGitRemoteFile?: (target: GitRemoteFileTarget) => void;
  children: ReactNode;
}

type EntryAction = 'local' | 'remote' | 'clone' | 'info' | 'release' | 'delete';

/** Browsing a repository never changes the agent's workspace. */
export function WorkspaceGitPanel(props: Props) {
  const { t } = useTranslation('workspaces');
  const [command, setCommand] = useState<{
    resourceId: string;
    action: EntryAction;
    nonce: number;
  } | null>(null);
  const request = (resourceId: string, action: EntryAction) => {
    props.onSelect(resourceId);
    setCommand((current) => ({
      resourceId,
      action,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  };
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
          {resources.map((item) => {
            const own = inventory.data?.copies.find(
              (copy) =>
                copy.sourceResourceId === item.id &&
                copyOwnedByAgent(copy, props.agentThreadId) &&
                copy.state === 'ready',
            );
            const agentHasCopy = inventory.data?.copies.some((copy) =>
              copyOwnedByAgent(copy, props.agentThreadId),
            );
            const active = Boolean(
              own?.localPath &&
              props.cwd &&
              pathIsWithin(props.cwd, own.localPath),
            );
            return (
              <div key={item.id} className="flex min-w-0 items-center gap-1">
                <Button
                  variant={item.id === props.resourceId ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1 text-xs"
                  aria-pressed={item.id === props.resourceId}
                  onClick={() => {
                    setCommand(null);
                    props.onSelect(item.id);
                  }}
                >
                  <Star
                    aria-label={active ? t('gitActiveForAgent') : undefined}
                    className={`h-3.5 w-3.5 shrink-0 ${active ? 'fill-primary text-primary' : 'text-muted-foreground'}`}
                  />
                  <GitBranch className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{item.name}</span>
                    <span className="block whitespace-normal text-[10px] text-muted-foreground">
                      {t(
                        !item.enabled
                          ? 'gitDisabled'
                          : own
                            ? 'gitHasAgentCopy'
                            : 'gitNoAgentCopy',
                      )}
                    </span>
                  </span>
                </Button>
                <WorkspaceEntryMenu
                  label={t('gitMenu', { name: item.name })}
                  items={[
                    {
                      label: t('gitBrowseLocal'),
                      disabled: !own || !item.enabled,
                      onSelect: () => request(item.id, 'local'),
                    },
                    {
                      label: t('gitBrowseRemote'),
                      disabled: !item.enabled,
                      onSelect: () => request(item.id, 'remote'),
                    },
                    {
                      label: t('gitOpenGraph'),
                      disabled: !item.enabled || !props.onGitGraph,
                      onSelect: () =>
                        props.onGitGraph?.({
                          projectId: props.projectId,
                          resourceId: item.id,
                          name: item.name,
                          copyId: own?.id ?? null,
                        }),
                    },
                    {
                      label: t('gitPrepareCopy'),
                      disabled: !item.enabled || agentHasCopy,
                      reason: agentHasCopy
                        ? t('gitAgentCopyExists')
                        : undefined,
                      onSelect: () => request(item.id, 'clone'),
                    },
                    {
                      label: t('gitUseForAgent'),
                      disabled:
                        !own?.localPath ||
                        active ||
                        props.activeWorkspacePending ||
                        !props.onActiveWorkspaceChange ||
                        !item.enabled,
                      onSelect: () =>
                        own?.localPath &&
                        props.onActiveWorkspaceChange?.(own.localPath),
                    },
                    {
                      label: t('gitInformation'),
                      onSelect: () => request(item.id, 'info'),
                    },
                    {
                      label: t('gitCopyRelease'),
                      disabled: !own || active,
                      reason: active ? t('gitCopyReleaseActive') : undefined,
                      onSelect: () => request(item.id, 'release'),
                    },
                    {
                      label: t('gitCopyDelete'),
                      destructive: true,
                      disabled: !own || active,
                      reason: active ? t('gitCopyInUse') : undefined,
                      onSelect: () => request(item.id, 'delete'),
                    },
                  ]}
                />
              </div>
            );
          })}
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
          key={`${props.projectId}:${resource.id}:${props.cwd}:${command?.resourceId === resource.id ? command.nonce : 0}`}
          initialAction={
            command?.resourceId === resource.id ? command.action : undefined
          }
          {...props}
          resource={resource}
          copies={(inventory.data?.copies ?? []).filter(
            (copy) => copy.sourceResourceId === resource.id,
          )}
          agentHasCopy={(inventory.data?.copies ?? []).some((copy) =>
            copyOwnedByAgent(copy, props.agentThreadId),
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
  onFile,
  onGitDiff,
  onGitGraph,
  onGitRemoteFile,
  agentThreadId,
  agentHasCopy,
  initialAction,
}: Props & {
  initialAction?: EntryAction;
  resource: GitInventory['resources'][number];
  copies: ProjectWorkspaceCopySummary[];
  agentHasCopy: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const client = useQueryClient();
  const [tab, setTab] = useState('files');
  const [scope, setScope] = useState(
    initialAction === 'remote' ? 'remote' : 'local',
  );
  const [removedCopyPath, setRemovedCopyPath] = useState('');
  const [branch, setBranch] = useState('');
  const [preparing, setPreparing] = useState(initialAction === 'clone');
  const [infoOpen, setInfoOpen] = useState(initialAction === 'info');
  const [browsed, setBrowsed] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState('');
  const [browseAttempt, setBrowseAttempt] = useState(0);
  const refreshButton = useRef<HTMLButtonElement | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useMutation({
    mutationFn: async () => {
      setRefreshVersion((version) => version + 1);
      await Promise.all([
        ...(copy?.localPath
          ? [...new Set([copy.localPath, useFilesStore.getState().rootDir])]
              .filter((root): root is string =>
                Boolean(root && pathIsWithin(root, copy.localPath!)),
              )
              .map((root) =>
                client.invalidateQueries({
                  queryKey: filesReadTreeQueryKey({ query: { root } }),
                  refetchType: 'all',
                }),
              )
          : []),
        client.invalidateQueries({ queryKey: gitInventoryKey(projectId) }),
        ...[
          ['workspace-git', projectId, copy?.id],
          ['workspace-git-commits', projectId, copy?.id],
          ['workspace-git-remote-files', projectId, resource.id],
          ['workspace-git-remote-branches', projectId, resource.id],
          ['workspace-git-prs', projectId, resource.id],
          ['workspace-git-checks', projectId, resource.id],
        ].map((queryKey) =>
          client.invalidateQueries({ queryKey, refetchType: 'all' }),
        ),
      ]);
    },
  });
  const ready = copies.filter((copy) => copy.state === 'ready');
  const copy = agentThreadId
    ? ready.find((item) => copyOwnedByAgent(item, agentThreadId))
    : (ready.find((item) => item.localPath === cwd) ?? ready[0]);
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
          body: JSON.stringify({
            ...(branch.trim() ? { branch: branch.trim() } : {}),
            agentThreadId,
          }),
        },
      ),
    onSuccess: async () => {
      setBrowsed(null);
      setPreparing(false);
      setBranch('');
      await Promise.all([
        client.invalidateQueries({ queryKey: gitInventoryKey(projectId) }),
        client.invalidateQueries({ queryKey: projectsQueryKey }),
      ]);
    },
  });
  useEffect(() => {
    if (
      scope !== 'local' ||
      tab !== 'files' ||
      !copy?.localPath ||
      browsed === copy.id
    )
      return;
    let cancelled = false;
    void filesAddRoot({
      body: { root: copy.localPath },
      throwOnError: true,
      meta: { silent: true },
    }).then(
      () => {
        if (!cancelled) {
          useFilesStore.getState().setRootDir(copy.localPath!);
          setBrowseError('');
          setBrowsed(copy.id);
        }
      },
      () => {
        if (!cancelled) setBrowseError(t('gitBrowseError'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope, tab, copy?.id, copy?.localPath, browsed, browseAttempt, t]);
  const writable =
    Boolean(
      copy &&
      copy.accessMode === 'read_write' &&
      resource.accessMode === 'read_write',
    ) &&
    (!agentThreadId
      ? !copy?.ownerAgentIds?.length
      : Boolean(copy && copyOwnedByAgent(copy, agentThreadId)));
  const reservedElsewhere = Boolean(
    copy?.ownerAgentIds?.length && !copyOwnedByAgent(copy, agentThreadId),
  );
  return (
    <section
      aria-label={resource.name}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <Tabs
        value={scope}
        onValueChange={setScope}
        className="flex min-w-0 shrink-0 flex-col gap-0"
      >
        <div className="flex min-w-0 shrink-0 items-center border-b">
          <TabsList className="flex h-auto min-w-0 flex-1 flex-wrap rounded-none bg-transparent p-1">
            <TabsTrigger
              value="local"
              className="inline-flex min-w-0 items-center gap-1 px-3 py-2 text-xs"
            >
              <HardDrive className="h-3.5 w-3.5" />
              {t('gitScopeLocal')}
            </TabsTrigger>
            <TabsTrigger
              value="remote"
              className="inline-flex min-w-0 items-center gap-1 px-3 py-2 text-xs"
            >
              <Cloud className="h-3.5 w-3.5" />
              {t('gitScopeRemote')}
            </TabsTrigger>
            <TabsTrigger
              value="sync"
              className="inline-flex min-w-0 items-center gap-1 px-3 py-2 text-xs"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
              {t('gitSynchronization')}
            </TabsTrigger>
          </TabsList>
          <Button
            ref={refreshButton}
            variant="ghost"
            size="icon-sm"
            className="mr-1 shrink-0"
            aria-label={t('gitRefreshAll')}
            title={t('gitRefreshAllHelp')}
            disabled={!resource.enabled || refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refresh.isPending ? 'animate-spin' : ''}`}
            />
          </Button>
        </div>
        <TabsContent
          value="local"
          forceMount
          hidden={scope !== 'local'}
          className="flex min-w-0 flex-col data-[state=inactive]:hidden"
        >
          <div className="min-w-0 shrink-0 space-y-2 border-b p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                <GitBranch className="mr-1 inline h-3.5 w-3.5" />
                {snapshot.data?.branch ?? copy?.branch ?? t('gitScopeLocal')}
                {snapshot.data?.head
                  ? ` · ${snapshot.data.head.slice(0, 7)}`
                  : ''}
              </span>
            </div>
            {!resource.enabled ? (
              <p>{t('gitDisabledHelp')}</p>
            ) : (
              <>
                {!copy && (
                  <p className="text-muted-foreground">{t('gitNoAgentCopy')}</p>
                )}
                {preparing && !agentHasCopy && (
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
          </div>
          {resource.enabled && (
            <Tabs
              value={tab}
              onValueChange={setTab}
              className="flex min-h-[180px] min-w-0 shrink-0 flex-col gap-0"
            >
              <TabsList className="flex h-auto w-full shrink-0 flex-wrap rounded-none border-b bg-transparent p-1">
                {['files', 'changes', 'branches', 'commits'].map((id) => (
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
                            : 'gitTabCommits',
                    )}
                    {id === 'changes' && snapshot.data && !snapshot.error
                      ? ` (${snapshot.data.changes.length})`
                      : ''}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent
                value="files"
                className="flex min-h-0 flex-1 flex-col"
              >
                {copy && browsed === copy.id ? (
                  <FileTree onFileClick={onFile} />
                ) : copy ? (
                  !browseError && (
                    <p role="status" className="p-3 text-xs">
                      {t('gitLoading')}
                    </p>
                  )
                ) : (
                  <p className="p-3 text-xs">{t('gitNoCopy')}</p>
                )}
                {browseError && (
                  <div className="p-3 text-xs">
                    <p role="alert" className="text-destructive">
                      {browseError}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setBrowseError('');
                        setBrowseAttempt((value) => value + 1);
                      }}
                    >
                      {t('gitRetry')}
                    </Button>
                  </div>
                )}
              </TabsContent>
              <TabsContent
                value="changes"
                className="min-h-0 flex-1 overflow-auto p-2"
              >
                {copy && writable && snapshot.data && !snapshot.error && (
                  <GitCopyActions
                    key={copy.id}
                    projectId={projectId}
                    agentThreadId={agentThreadId}
                    copyId={copy.id}
                    snapshot={snapshot.data}
                    address={resource.address}
                    actionScope="commit"
                  />
                )}
                {copy && snapshot.data && !snapshot.error ? (
                  <Changes
                    projectId={projectId}
                    copy={copy}
                    snapshot={snapshot.data}
                    onGitDiff={onGitDiff}
                    agentThreadId={agentThreadId}
                    writable={writable}
                  />
                ) : (
                  <p className="p-1 text-xs">
                    {t(
                      snapshot.isPending && copy
                        ? 'gitLoading'
                        : 'gitNoSnapshot',
                    )}
                  </p>
                )}
              </TabsContent>
              <TabsContent
                value="branches"
                className="min-h-0 flex-1 overflow-auto p-3 text-xs"
              >
                {onGitGraph && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onGitGraph({
                        projectId,
                        resourceId: resource.id,
                        name: resource.name,
                        copyId: copy?.id ?? null,
                      })
                    }
                  >
                    {t('gitOpenGraph')}
                  </Button>
                )}
                <p className="mb-3 text-muted-foreground">
                  {t('gitBranchesHelp')}
                </p>
                {snapshot.data && !snapshot.error ? (
                  <>
                    {copy && (
                      <GitCreateBranch
                        key={`${projectId}:${copy.id}:${agentThreadId ?? ''}`}
                        projectId={projectId}
                        copyId={copy.id}
                        snapshot={snapshot.data}
                        agentThreadId={agentThreadId}
                        readOnly={
                          resource.accessMode !== 'read_write' ||
                          copy.accessMode !== 'read_write'
                        }
                      />
                    )}
                    {snapshot.data.branches
                      .filter((item) => !item.remote)
                      .map((item) => (
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
                            {t(
                              item.remote
                                ? 'gitRemoteBranch'
                                : 'gitLocalBranch',
                            )}{' '}
                            · {item.revision.slice(0, 7) || t('gitNoCommit')}
                          </p>
                        </div>
                      ))}
                  </>
                ) : (
                  <p>{t('gitNoSnapshot')}</p>
                )}
                {snapshot.data?.branchesLimited && <p>{t('gitLimited')}</p>}
              </TabsContent>
              <TabsContent
                value="commits"
                className="min-h-0 flex-1 overflow-auto"
              >
                {copy ? (
                  <LocalCommits projectId={projectId} copyId={copy.id} />
                ) : (
                  <p className="p-3 text-xs">{t('gitNoCopy')}</p>
                )}
              </TabsContent>
            </Tabs>
          )}
        </TabsContent>
        <TabsContent
          value="remote"
          className="min-h-0 min-w-0 flex-1 overflow-auto"
        >
          {resource.enabled ? (
            <Tabs
              defaultValue={initialAction === 'remote' ? 'files' : 'prs'}
              className="gap-0"
            >
              <TabsList className="flex h-auto w-full flex-wrap rounded-none border-b bg-transparent p-1">
                <TabsTrigger value="files" className="px-2 py-1 text-xs">
                  {t('gitTabFiles')}
                </TabsTrigger>
                <TabsTrigger value="prs" className="px-2 py-1 text-xs">
                  {t('gitTabPrs')}
                </TabsTrigger>
                <TabsTrigger value="published" className="px-2 py-1 text-xs">
                  {t('gitPublishedBranches')}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="files">
                <GitRemoteFiles
                  projectId={projectId}
                  resourceId={resource.id}
                  refreshVersion={refreshVersion}
                  onFile={onGitRemoteFile}
                />
              </TabsContent>
              <TabsContent value="prs">
                <PullRequests
                  projectId={projectId}
                  resourceId={resource.id}
                  canWrite={resource.accessMode === 'read_write'}
                  resourceAddress={resource.address}
                  onCloseFocus={() => refreshButton.current?.focus()}
                />
              </TabsContent>
              <TabsContent value="published">
                <RemoteBranches
                  projectId={projectId}
                  resourceId={resource.id}
                  canPrepare={!agentHasCopy}
                  onPrepare={(name) => {
                    setBranch(name);
                    setPreparing(true);
                    setScope('local');
                  }}
                />
              </TabsContent>
            </Tabs>
          ) : (
            <p className="p-3 text-xs">{t('gitDisabledHelp')}</p>
          )}
        </TabsContent>
        <TabsContent
          value="sync"
          className="min-h-0 min-w-0 flex-1 overflow-auto"
        >
          {resource.enabled ? (
            <section
              aria-label={t('gitSynchronization')}
              className="space-y-2 p-3 text-xs"
            >
              <h3 className="flex items-center gap-2 font-medium">
                <ArrowLeftRight className="h-3.5 w-3.5" />
                {t('gitSynchronization')}
              </h3>
              <p className="break-all">
                {copy
                  ? `${copy.name} · ${snapshot.data?.branch ?? t('gitDetached')}`
                  : t('gitNoCopy')}{' '}
                → GitHub
              </p>
              <p className="text-muted-foreground">
                {snapshot.data && !snapshot.error && snapshot.data.upstream
                  ? t('gitKnownTracking', {
                      ahead: snapshot.data.ahead,
                      behind: snapshot.data.behind,
                      upstream: snapshot.data.upstream,
                      date: new Date(
                        snapshot.data.inspectedAt,
                      ).toLocaleTimeString(),
                    })
                  : t('gitNoTrackingComparison')}
              </p>
              {writable && copy && snapshot.data && !snapshot.error && (
                <GitCopyActions
                  key={`publish:${copy.id}`}
                  projectId={projectId}
                  agentThreadId={agentThreadId}
                  copyId={copy.id}
                  snapshot={snapshot.data}
                  address={resource.address}
                  actionScope="push"
                />
              )}
              <div>
                <Button size="sm" variant="outline" disabled>
                  {t('gitIntegrate')}
                </Button>
                <p className="mt-1 text-muted-foreground">
                  {t('gitIntegrateUnavailable')}
                </p>
              </div>
            </section>
          ) : (
            <p className="p-3 text-xs">{t('gitDisabledHelp')}</p>
          )}
        </TabsContent>
      </Tabs>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('gitInformation')} · {resource.name}
            </DialogTitle>
          </DialogHeader>
          <p className="break-all text-xs">{resource.address}</p>
          <p className="break-all font-mono text-xs">
            {copy?.localPath ?? t('gitNoAgentCopy')}
          </p>
          {copy && <p className="text-xs">{t('gitCopyOwnedByAgent')}</p>}
        </DialogContent>
      </Dialog>
      {copy && (
        <>
          <GitCopyReservation
            projectId={projectId}
            copy={copy}
            agentThreadId={agentThreadId}
            active={Boolean(
              copy.localPath && cwd && pathIsWithin(cwd, copy.localPath),
            )}
            initialOpen={initialAction === 'release'}
            hideTrigger
          />
          <GitCopyDelete
            projectId={projectId}
            copy={copy}
            active={Boolean(
              reservedElsewhere ||
              (copy.localPath && cwd && pathIsWithin(cwd, copy.localPath)),
            )}
            initialOpen={initialAction === 'delete'}
            hideTrigger
            onRemoved={(path) => {
              setBrowsed(null);
              setRemovedCopyPath(path);
            }}
          />
        </>
      )}
      {removedCopyPath && (
        <p role="status" className="break-all p-3 text-xs">
          {t('gitCopyRecovery', { path: removedCopyPath })}
        </p>
      )}
    </section>
  );
}

function LocalCommits({
  projectId,
  copyId,
}: {
  projectId: string;
  copyId: string;
}) {
  const { t, i18n } = useTranslation('workspaces');
  const query = useQuery({
    queryKey: ['workspace-git-commits', projectId, copyId],
    queryFn: ({ signal }) =>
      gitGet<GitCommits>(
        projectId,
        `copies/${encodeURIComponent(copyId)}/commits`,
        signal,
      ),
    retry: false,
  });
  return (
    <div className="space-y-2 p-3 text-xs">
      <p className="text-muted-foreground">{t('gitLocalCommitsHelp')}</p>
      {query.isPending ? (
        <p role="status">{t('gitLoading')}</p>
      ) : query.isError ? (
        <p role="alert">{t('gitInspectionError')}</p>
      ) : (
        <>
          {query.data.items.length === 0 && <p>{t('gitNoCommit')}</p>}
          {query.data.items.map((item) => (
            <article key={item.sha} className="space-y-1 border-b py-2">
              <p className="break-all font-medium">{item.subject}</p>
              <p className="break-all text-muted-foreground">
                {item.sha.slice(0, 7)} · {item.author} ·{' '}
                {new Date(item.date).toLocaleString(i18n.language)}
              </p>
            </article>
          ))}
          {query.data.limited && <p>{t('gitLimited')}</p>}
        </>
      )}
    </div>
  );
}

function RemoteBranches({
  projectId,
  resourceId,
  onPrepare,
  canPrepare,
}: {
  projectId: string;
  resourceId: string;
  onPrepare: (branch: string) => void;
  canPrepare: boolean;
}) {
  const { t, i18n } = useTranslation('workspaces');
  const query = useQuery({
    queryKey: ['workspace-git-remote-branches', projectId, resourceId],
    queryFn: ({ signal }) =>
      gitGet<GitRemoteBranches>(
        projectId,
        `resources/${encodeURIComponent(resourceId)}/branches`,
        signal,
      ),
    retry: false,
    refetchInterval: 60000,
  });
  return (
    <div className="space-y-3 p-3 text-xs">
      {query.isPending ? (
        <p role="status">{t('gitLoading')}</p>
      ) : query.isError ? (
        <p role="alert">{t('gitGithubError')}</p>
      ) : !query.data.supported ? (
        <p>{t('gitProviderUnsupported')}</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {t('gitRemoteObserved', {
              date: new Date(query.data.inspectedAt).toLocaleString(
                i18n.language,
              ),
            })}
          </p>
          {query.data.items.length === 0 && <p>{t('gitNoPublishedBranch')}</p>}
          {query.data.items.map((item) => (
            <article key={item.name} className="space-y-1 border-b py-2">
              <p className="break-all font-medium">{item.name}</p>
              <p>
                {item.revision.slice(0, 7)}
                {item.protected ? ` · ${t('gitProtectedBranch')}` : ''}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={!canPrepare}
                onClick={() => onPrepare(item.name)}
              >
                {t('gitPrepareCopy')}
              </Button>
            </article>
          ))}
          {query.data.limited && <p>{t('gitLimited')}</p>}
        </>
      )}
    </div>
  );
}

function Changes({
  projectId,
  copy,
  snapshot,
  onGitDiff,
  agentThreadId,
  writable,
}: {
  projectId: string;
  copy: ProjectWorkspaceCopySummary;
  snapshot: GitSnapshot;
  onGitDiff?: (target: GitDiffTarget) => void;
  agentThreadId?: string;
  writable: boolean;
}) {
  return (
    <GitStageChanges
      key={`${copy.id}:${agentThreadId ?? ''}`}
      projectId={projectId}
      copyId={copy.id}
      snapshot={snapshot}
      agentThreadId={agentThreadId}
      writable={writable}
      onDiff={(path) =>
        onGitDiff?.({
          projectId,
          copyId: copy.id,
          path,
          localPath: copy.localPath,
          status: snapshot.changes.find((c) => c.path === path)?.status ?? '',
        })
      }
    />
  );
}

function PullRequests({
  projectId,
  resourceId,
  canWrite,
  resourceAddress,
  onCloseFocus,
}: {
  projectId: string;
  resourceId: string;
  canWrite: boolean;
  resourceAddress: string | null;
  onCloseFocus: () => void;
}) {
  const { t } = useTranslation('workspaces');
  const [number, setNumber] = useState<number | null>(null);
  const [lastMerged, setLastMerged] = useState<number | null>(null);
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
                          onCloseFocus={onCloseFocus}
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
