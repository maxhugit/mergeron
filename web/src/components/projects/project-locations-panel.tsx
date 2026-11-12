import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Folder, GitBranch, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GitCopyDelete } from '@/components/chat/git-copy-delete';
import {
  getProjectLocations,
  projectLocationsPath,
  projectConnectionsPath,
} from '@/lib/project-locations-api';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';
import { ProjectLocationsIntro } from './project-locations-intro';

export function ProjectLocationsPanel({
  project,
  pending,
  onAddLocal,
  onDetachLocal,
}: {
  project: ProjectSummary;
  pending: boolean;
  onAddLocal: () => void;
  onDetachLocal: (id: string) => void;
}) {
  const { t } = useTranslation(['workspaces', 'common'], {
    nsMode: 'fallback',
  });
  const client = useQueryClient();
  const inventory = useQuery({
    queryKey: ['project-locations', project.id],
    queryFn: ({ signal }) => getProjectLocations(project.id, signal),
  });
  const [form, setForm] = useState<'copy' | 'remote' | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [branch, setBranch] = useState('');
  const [agentThreadId, setAgentThreadId] = useState('');
  const [recovery, setRecovery] = useState('');
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['project-locations', project.id] }),
      client.invalidateQueries({ queryKey: projectsQueryKey }),
    ]);
  };
  const create = useMutation({
    retry: false,
    mutationFn: () =>
      projectsApi(
        form === 'copy'
          ? `${projectConnectionsPath(project.id)}/${encodeURIComponent(connectionId)}/copies`
          : projectLocationsPath(project.id),
        {
          method: 'POST',
          body: JSON.stringify(
            form === 'copy'
              ? {
                  name: name.trim() || undefined,
                  branch: branch.trim() || undefined,
                  agentThreadId: agentThreadId || undefined,
                }
              : { connectionId, name: name.trim(), path: path.trim() },
          ),
        },
      ),
    onSuccess: async () => {
      setForm(null);
      await refresh();
    },
  });
  const detach = useMutation({
    retry: false,
    mutationFn: (id: string) =>
      projectsApi(
        `${projectLocationsPath(project.id)}/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    onSuccess: refresh,
  });
  const connections = inventory.data?.connections ?? [];
  const eligible = connections.filter(
    (c) =>
      c.enabled &&
      (form === 'copy' ? c.protocol === 'git' : c.protocol !== 'git'),
  );
  const open = (kind: 'copy' | 'remote') => {
    setForm(kind);
    setConnectionId(
      connections.find(
        (c) =>
          c.enabled &&
          (kind === 'copy' ? c.protocol === 'git' : c.protocol !== 'git'),
      )?.id ?? '',
    );
    setName('');
    setPath('');
    setBranch('');
    setAgentThreadId('');
    create.reset();
  };
  const busy = pending || create.isPending || detach.isPending;
  const field =
    'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm';
  const local =
    inventory.data?.locations.filter((l) => l.kind !== 'remote') ??
    project.workspaces.map((w) => ({
      id: `local:${w.id}`,
      name: w.name,
      path: w.path,
      kind: w.primary
        ? ('managed_local' as const)
        : ('attached_local' as const),
      localWorkspaceId: w.id,
      connectionId: null,
      workingCopyId: null,
    }));
  const remote =
    inventory.data?.locations.filter(
      (l) =>
        l.kind === 'remote' &&
        connections.find((c) => c.id === l.connectionId)?.protocol !== 'git',
    ) ?? [];
  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{t('projectLocationsTab')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('projectLocationsDescription')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={onAddLocal}>
            <Plus className="h-4 w-4" />
            {t('addLocalLocation')}
          </Button>
          <Button
            variant="outline"
            disabled={
              busy ||
              !connections.some((c) => c.enabled && c.protocol === 'git')
            }
            onClick={() => open('copy')}
          >
            <GitBranch className="h-4 w-4" />
            {t('createGitLocation')}
          </Button>
          <Button
            variant="outline"
            disabled={
              busy ||
              !connections.some((c) => c.enabled && c.protocol !== 'git')
            }
            onClick={() => open('remote')}
          >
            {t('addRemoteLocation')}
          </Button>
        </div>
      </div>
      <ProjectLocationsIntro />
      {form && (
        <form
          className="grid min-w-0 gap-3 rounded-lg border p-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) create.mutate();
          }}
        >
          <h4 className="font-medium sm:col-span-2">
            {t(form === 'copy' ? 'createGitLocation' : 'addRemoteLocation')}
          </h4>
          <label className="grid min-w-0 gap-1 text-sm sm:col-span-2">
            {t('existingProjectConnection')}
            <select
              className={field}
              value={connectionId}
              required
              disabled={busy}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              {eligible.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.protocol.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t('locationName')}
            <input
              className={field}
              value={name}
              required={form === 'remote'}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {form === 'copy' ? (
            <>
              <label className="grid gap-1 text-sm">
                {t('gitBranchOptional')}
                <input
                  className={field}
                  value={branch}
                  disabled={busy}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm sm:col-span-2">
                {t('workingCopyAgent')}
                <select
                  className={field}
                  value={agentThreadId}
                  disabled={busy}
                  onChange={(e) => setAgentThreadId(e.target.value)}
                >
                  <option value="">{t('unassigned')}</option>
                  {(project.agentThreads ?? []).map((a) => (
                    <option key={a.threadId} value={a.threadId}>
                      {a.title}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <label className="grid gap-1 text-sm">
              {t('remoteDirectoryPath')}
              <input
                className={field}
                required
                value={path}
                disabled={busy}
                placeholder="/srv/project"
                onChange={(e) => setPath(e.target.value)}
              />
            </label>
          )}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {t('reuseConnectionLocationHelp')}
          </p>
          {create.error && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {create.error.message}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setForm(null)}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy || !connectionId}>
              {t(form === 'copy' ? 'createCopy' : 'attachLocation')}
            </Button>
          </div>
        </form>
      )}
      <h4 className="text-sm font-semibold">{t('projectWorkspaces')}</h4>
      {local.map((location) => {
        const copy = inventory.data?.copies.find(
          (c) =>
            c.id === location.workingCopyId ||
            c.localWorkspaceId === location.localWorkspaceId,
        );
        const agents = (project.agentThreads ?? []).filter(
          (a) => a.workspacePath === location.path,
        );
        return (
          <article
            key={location.id}
            className="min-w-0 space-y-3 rounded-lg border p-3"
          >
            <div className="flex flex-wrap items-center gap-3">
              {copy ? (
                <GitBranch className="h-4 w-4 shrink-0" />
              ) : (
                <Folder className="h-4 w-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{location.name}</span>
                  <Badge variant="secondary">
                    {t(
                      copy
                        ? 'gitWorkingCopyLocation'
                        : location.kind === 'managed_local'
                          ? 'primaryWorkspace'
                          : 'secondaryWorkspace',
                    )}
                  </Badge>
                </div>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {location.path}
                </p>
              </div>
              {location.kind !== 'managed_local' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    location.localWorkspaceId &&
                    onDetachLocal(location.localWorkspaceId)
                  }
                >
                  {t('detach')}
                </Button>
              )}
            </div>
            {copy && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {copy.sourceName ?? t('connectionDetached')} ·{' '}
                  {copy.branch ?? t('detachedRevision')} ·{' '}
                  {copy.revision.slice(0, 12) || t('gitNoCommit')} ·{' '}
                  {t(
                    copy.accessMode === 'read_only'
                      ? 'readOnly'
                      : 'readAndWrite',
                  )}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      copy.state === 'ready' ? 'secondary' : 'destructive'
                    }
                  >
                    {t(copy.state === 'ready' ? 'ready' : 'revoked')}
                  </Badge>
                  <GitCopyDelete
                    projectId={project.id}
                    copy={copy}
                    onRemoved={(value) => {
                      setRecovery(value);
                      void refresh();
                    }}
                  />
                </div>
              </div>
            )}
            <div className="space-y-1.5 border-l pl-3">
              <div className="text-xs text-muted-foreground">
                {t('associatedConversations')} ({agents.length})
              </div>
              {agents.length ? (
                agents.map((a) => (
                  <div
                    key={a.threadId}
                    className="flex min-w-0 items-center gap-2 text-xs"
                  >
                    <Bot className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{a.title}</span>
                  </div>
                ))
              ) : (
                <p className="text-xs italic text-muted-foreground">
                  {t('noAssociatedConversation')}
                </p>
              )}
            </div>
          </article>
        );
      })}
      <h4 className="text-sm font-semibold">{t('remoteProjectLocations')}</h4>
      {remote.map((l) => (
        <article
          key={l.id}
          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
        >
          <div className="min-w-0">
            <p className="font-medium">{l.name}</p>
            <p className="break-all font-mono text-xs">{l.path}</p>
            <p className="text-xs text-muted-foreground">
              {connections.find((c) => c.id === l.connectionId)?.name} ·{' '}
              {t(l.accessMode === 'read_only' ? 'readOnly' : 'readAndWrite')}
            </p>
          </div>
          {
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => detach.mutate(l.id)}
            >
              {t('detach')}
            </Button>
          }
        </article>
      ))}
      {!remote.length && (
        <p className="text-xs text-muted-foreground">
          {t('noRemoteProjectLocation')}
        </p>
      )}
      {recovery && (
        <p role="status" className="break-all text-xs">
          {t('gitCopyRecovery', { path: recovery })}
        </p>
      )}
      {(inventory.error || detach.error) && (
        <p role="alert" className="text-sm text-destructive">
          {(inventory.error || detach.error)?.message}
        </p>
      )}
    </section>
  );
}
