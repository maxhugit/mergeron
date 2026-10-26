import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Eye, Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  projectsApi,
  type ProjectSummary,
  type ProjectWorkspaceResourceSummary,
  type ProjectWorkspaceTransferRunSummary,
  type ProjectWorkspaceTransferSummary,
} from '@/lib/projects-api';
import {
  getProjectLocations,
  locationResourceViews,
  locationTransfersPath,
} from '@/lib/project-locations-api';

const emptyForm = {
  name: '',
  sourceResourceId: '',
  destinationWorkspaceId: '',
  sourcePath: '',
  destinationPath: '',
  exclusions: '',
  conflictPolicy: 'skip',
  propagateDeletes: false,
};

export function WorkspaceTransfers({ project }: { project: ProjectSummary }) {
  const { t } = useTranslation();
  const [resources, setResources] = useState<ProjectWorkspaceResourceSummary[]>(
    [],
  );
  const [transfers, setTransfers] = useState<ProjectWorkspaceTransferSummary[]>(
    [],
  );
  const [runs, setRuns] = useState<ProjectWorkspaceTransferRunSummary[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const [inventory, result] = await Promise.all([
      getProjectLocations(project.id),
      projectsApi<{
        transfers: Array<
          Omit<
            ProjectWorkspaceTransferSummary,
            'sourceResourceId' | 'destinationWorkspaceId'
          > & {
            sourceLocationId: string | null;
            destinationLocationId: string | null;
          }
        >;
        runs: ProjectWorkspaceTransferRunSummary[];
      }>(locationTransfersPath(project.id)),
    ]);
    setResources(locationResourceViews(inventory));
    setTransfers(
      result.transfers.map(
        ({ sourceLocationId, destinationLocationId, ...rest }) => ({
          ...rest,
          sourceResourceId: sourceLocationId ?? '',
          destinationWorkspaceId: destinationLocationId ?? '',
        }),
      ),
    );
    setRuns(result.runs);
  }, [project.id]);
  useEffect(() => {
    // Network completion refreshes the transfer inventory for this project.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [load]);
  const sources = useMemo(
    () =>
      resources.filter((resource) =>
        ['local', 'sftp', 'ftp', 'ftps'].includes(resource.type),
      ),
    [resources],
  );
  const destinations = resources.filter(
    (location) =>
      location.type === 'local' &&
      location.enabled &&
      location.accessMode === 'read_write' &&
      location.capabilities.write,
  );
  const mutate = async <T,>(key: string, path: string, init: RequestInit) => {
    setBusy(key);
    setError('');
    try {
      const result = await projectsApi<T>(path, init);
      await load();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusy(null);
    }
  };
  const create = async () => {
    const result = await mutate<{ transfer: ProjectWorkspaceTransferSummary }>(
      'create',
      locationTransfersPath(project.id),
      {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          sourceLocationId: form.sourceResourceId,
          destinationLocationId: form.destinationWorkspaceId,
          sourcePath: form.sourcePath,
          destinationPath: form.destinationPath,
          conflictPolicy: form.conflictPolicy,
          propagateDeletes: form.propagateDeletes,
          exclusions: form.exclusions
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      },
    );
    if (result) {
      setEditing(false);
      setForm(emptyForm);
    }
  };
  const latestRun = (transferId: string) =>
    runs.find((run) => run.transferId === transferId);
  const statusLabel = (
    status: ProjectWorkspaceTransferRunSummary['status'],
  ) => {
    if (status === 'previewed') return t('transferStatusPreviewed');
    if (status === 'running') return t('transferStatusRunning');
    if (status === 'success') return t('transferStatusSuccess');
    if (status === 'completed_with_conflicts')
      return t('transferStatusConflicts');
    return t('transferStatusError');
  };
  const actionLabel = (
    action: ProjectWorkspaceTransferRunSummary['changes'][number]['action'],
  ) => {
    if (action === 'create') return t('transferActionCreate');
    if (action === 'update') return t('transferActionUpdate');
    if (action === 'conflict') return t('transferActionConflict');
    if (action === 'delete') return t('transferActionDelete');
    return t('transferActionUnchanged');
  };
  const field =
    'rounded-md border border-input bg-background px-3 py-2 text-sm';

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t('workspaceTransfers')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('workspaceTransfersDescription')}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={Boolean(busy)}
          onClick={() => setEditing((value) => !value)}
        >
          <ArrowRightLeft className="h-4 w-4" />
          {t('addTransfer')}
        </Button>
      </div>
      {editing && (
        <div className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
          <input
            className={`${field} sm:col-span-2`}
            placeholder={t('transferName')}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <select
            className={field}
            value={form.sourceResourceId}
            onChange={(event) =>
              setForm({ ...form, sourceResourceId: event.target.value })
            }
          >
            <option value="">{t('transferSource')}</option>
            {sources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} ({resource.type.toUpperCase()})
              </option>
            ))}
          </select>
          <select
            className={field}
            value={form.destinationWorkspaceId}
            onChange={(event) =>
              setForm({ ...form, destinationWorkspaceId: event.target.value })
            }
          >
            <option value="">{t('transferDestination')}</option>
            {destinations.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <input
            className={field}
            placeholder={t('sourceSubfolder')}
            value={form.sourcePath}
            onChange={(event) =>
              setForm({ ...form, sourcePath: event.target.value })
            }
          />
          <input
            className={field}
            placeholder={t('destinationSubfolder')}
            value={form.destinationPath}
            onChange={(event) =>
              setForm({ ...form, destinationPath: event.target.value })
            }
          />
          <textarea
            className={`${field} min-h-20 sm:col-span-2`}
            placeholder={t('transferExclusions')}
            value={form.exclusions}
            onChange={(event) =>
              setForm({ ...form, exclusions: event.target.value })
            }
          />
          <select
            className={field}
            value={form.conflictPolicy}
            onChange={(event) =>
              setForm({ ...form, conflictPolicy: event.target.value })
            }
          >
            <option value="skip">{t('skipConflicts')}</option>
            <option value="overwrite">{t('overwriteConflicts')}</option>
          </select>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={form.propagateDeletes}
              onChange={(event) =>
                setForm({ ...form, propagateDeletes: event.target.checked })
              }
            />
            {t('propagateDeletes')}
          </label>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              disabled={
                Boolean(busy) ||
                !form.name ||
                !form.sourceResourceId ||
                !form.destinationWorkspaceId
              }
              onClick={() => void create()}
            >
              {t('addTransfer')}
            </Button>
          </div>
        </div>
      )}
      {transfers.map((transfer) => {
        const run = latestRun(transfer.id);
        return (
          <div
            key={transfer.id}
            className="space-y-2 rounded-lg border border-border p-3"
          >
            <div className="flex items-start gap-2">
              <ArrowRightLeft className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{transfer.name}</div>
                <div className="text-xs text-muted-foreground">
                  {resources.find(
                    (item) => item.id === transfer.sourceResourceId,
                  )?.name ?? transfer.sourceResourceId}{' '}
                  →{' '}
                  {resources.find(
                    (item) => item.id === transfer.destinationWorkspaceId,
                  )?.name ?? transfer.destinationWorkspaceId}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() =>
                  void mutate<ProjectWorkspaceTransferRunSummary>(
                    `preview-${transfer.id}`,
                    `${locationTransfersPath(project.id)}/${transfer.id}/preview`,
                    { method: 'POST' },
                  )
                }
              >
                <Eye className="h-3.5 w-3.5" />
                {t('preview')}
              </Button>
              {run && ['previewed', 'error'].includes(run.status) && (
                <Button
                  size="sm"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void mutate(
                      `execute-${transfer.id}`,
                      `${locationTransfersPath(project.id)}/${transfer.id}/runs/${run.id}/execute`,
                      { method: 'POST' },
                    )
                  }
                >
                  <Play className="h-3.5 w-3.5" />
                  {run.status === 'error' ? t('retry') : t('execute')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={Boolean(busy)}
                onClick={() =>
                  void mutate(
                    `delete-${transfer.id}`,
                    `${locationTransfersPath(project.id)}/${transfer.id}`,
                    { method: 'DELETE' },
                  )
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {run && (
              <div className="space-y-1 rounded-md bg-muted/40 p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      run.status === 'error' ? 'destructive' : 'secondary'
                    }
                  >
                    {statusLabel(run.status)}
                  </Badge>
                  {(['create', 'update', 'conflict', 'delete'] as const).map(
                    (action) =>
                      Boolean(run.summary[action]) && (
                        <span key={action}>
                          {actionLabel(action)}: {run.summary[action]}
                        </span>
                      ),
                  )}
                </div>
                {run.changes
                  .filter((change) => change.action !== 'unchanged')
                  .slice(0, 20)
                  .map((change) => (
                    <div
                      key={`${change.action}-${change.path}`}
                      className="font-mono"
                    >
                      {actionLabel(change.action)} · {change.path}
                    </div>
                  ))}
                {run.changes.length > 20 && (
                  <div className="text-muted-foreground">
                    {t('andMoreFiles', { count: run.changes.length - 20 })}
                  </div>
                )}
                {run.error && (
                  <div className="text-destructive">{run.error}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {transfers.length === 0 && !editing && (
        <p className="text-xs italic text-muted-foreground">
          {t('noWorkspaceTransfer')}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
