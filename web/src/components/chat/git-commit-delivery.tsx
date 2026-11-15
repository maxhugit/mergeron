import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { workspaceGitCommitDelivery1 } from '@/generated/api';
import { Button } from '@/components/ui/button';

export function GitCommitDelivery({
  projectId,
  resourceId,
  revision,
}: {
  projectId: string;
  resourceId: string;
  revision: string;
}) {
  const { t } = useTranslation('workspaces');
  const reasonLabels = {
    registry_receipt_required: t('gitEvidenceReasons.registryReceiptRequired'),
    runtime_receipt_required: t('gitEvidenceReasons.runtimeReceiptRequired'),
    administrator_required: t('gitEvidenceReasons.administratorRequired'),
    registry_unavailable: t('gitEvidenceReasons.registryUnavailable'),
    commit_mismatch: t('gitEvidenceReasons.commitMismatch'),
    manager_unavailable: t('gitEvidenceReasons.managerUnavailable'),
    runtime_not_healthy: t('gitEvidenceReasons.runtimeNotHealthy'),
    different_commit: t('gitEvidenceReasons.differentCommit'),
    image_identity_mismatch: t('gitEvidenceReasons.imageIdentityMismatch'),
    verified_registry: t('gitEvidenceReasons.verifiedRegistry'),
    verified_manager: t('gitEvidenceReasons.verifiedManager'),
  };
  const environmentLabels = {
    development: t('gitEvidenceEnvironment.development'),
    production: t('gitEvidenceEnvironment.production'),
    unknown: t('gitEvidenceEnvironment.unknown'),
  };
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [
      'workspace-commit-delivery',
      projectId,
      resourceId,
      revision,
      page,
    ],
    enabled: open,
    retry: false,
    queryFn: async ({ signal }) => {
      const { data } = await workspaceGitCommitDelivery1({
        path: { projectId, resourceId, revision },
        query: { page },
        signal,
        throwOnError: true,
        meta: { silent: true },
      });
      if (data.revision !== revision) throw Error('GIT_STALE');
      return data;
    },
    refetchInterval: (q) =>
      open && q.state.data?.actions.items.some((r) => r.status !== 'completed')
        ? 15000
        : false,
  });
  const data = query.data?.revision === revision ? query.data : undefined;
  return (
    <details
      className="min-w-0 rounded-md border p-2"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer">{t('gitCommitDelivery')}</summary>
      <div className="mt-2 space-y-2 break-words [overflow-wrap:anywhere]">
        <p>{t('gitCommitDeliveryRevision', { sha: revision })}</p>
        <p className="text-muted-foreground">{t('gitCommitDeliveryProof')}</p>
        {query.isPending && open && (
          <p role="status">{t('gitCommitDeliveryLoading')}</p>
        )}
        {query.isError && <p role="alert">{t('gitCommitDeliveryError')}</p>}
        {data && !query.isError && (
          <>
            <a
              href={data.commitUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {t('gitCommitDeliveryPublished', {
                date: new Date(data.inspectedAt).toLocaleString(),
              })}
            </a>
            {data.actions.items.length === 0 && (
              <p>{t('gitCommitDeliveryEmpty')}</p>
            )}
            <ul className="space-y-2">
              {data.actions.items.map((run) => (
                <li key={run.id} className="rounded border p-2">
                  <a
                    href={run.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {run.name || `#${run.id}`}
                  </a>
                  <p>
                    {t('gitCommitDeliveryRun', {
                      event: run.event ?? '—',
                      attempt: run.attempt ?? '—',
                      status: run.status ?? '—',
                      conclusion: run.conclusion ?? '—',
                    })}
                  </p>
                </li>
              ))}
            </ul>
            {data.actions.limited && (
              <p>
                {t('gitCommitDeliveryLimited', { total: data.actions.total })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {page > 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPage(page - 1)}
                >
                  {t('gitCommitDeliveryPrevious')}
                </Button>
              )}
              {data.actions.nextPage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPage(data.actions.nextPage!)}
                >
                  {t('gitCommitDeliveryNext')}
                </Button>
              )}
            </div>
            <p className="text-muted-foreground">
              {data.image.state === 'verified'
                ? t('gitCommitDeliveryImageVerified', {
                    reference: data.image.reference ?? '—',
                    date: data.image.checkedAt
                      ? new Date(data.image.checkedAt).toLocaleString()
                      : '—',
                  })
                : `${t('gitCommitDeliveryImageUnknown')} ${reasonLabels[data.image.reason] ?? t('gitCommitDeliveryProof')}`}
            </p>
            <p className="text-muted-foreground">
              {data.deployment.state === 'verified'
                ? t('gitCommitDeliveryDeploymentVerified', {
                    reference: data.deployment.reference ?? '—',
                    environment:
                      environmentLabels[
                        data.deployment.environment ?? 'unknown'
                      ],
                    date: data.deployment.checkedAt
                      ? new Date(data.deployment.checkedAt).toLocaleString()
                      : '—',
                  })
                : `${t('gitCommitDeliveryDeploymentUnknown')} ${reasonLabels[data.deployment.reason] ?? t('gitCommitDeliveryProof')}`}
            </p>
            {data.deployment.observedRevision && (
              <p>
                {t('gitCommitDeliveryObservedRevision', {
                  sha: data.deployment.observedRevision,
                })}
              </p>
            )}
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('gitCommitDeliveryRefresh')}
        </Button>
      </div>
    </details>
  );
}
