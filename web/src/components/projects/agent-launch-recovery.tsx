import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { projectsApi } from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';
import { Button } from '@/components/ui/button';

interface LaunchStatus {
  launch: {
    id: string;
    state: string;
    phase: string;
    threadId: string | null;
    revision: number;
    targetRevision: number;
    resourceId: string;
    busy: boolean;
    associationPending?: boolean;
  } | null;
  candidates: Array<{ id: string; title: string }>;
  inventoryError?: boolean;
}
/** Recovery changes an association or acknowledges an inspected turn; it never sends a turn. */
export function AgentLaunchRecovery({
  projectId,
  resourceId,
  kind,
  targetId,
  onOpen,
  onRecovered,
}: {
  projectId: string;
  resourceId: string;
  kind: 'task' | 'deliverable';
  targetId: string;
  onOpen: (threadId: string) => void;
  onRecovered: () => unknown;
}) {
  const { t } = useTranslation('workspaces');
  const session = usePlatformSession();
  const client = useQueryClient();
  const [decision, setDecision] = useState<{
    scope: string;
    selected: string;
    checked: boolean;
  } | null>(null);
  const base = `/${projectId}/resources/${resourceId}`;
  const query = useQuery({
    queryKey: ['agent-launch', projectId, resourceId, kind, targetId],
    queryFn: () =>
      projectsApi<LaunchStatus>(
        `${base}/${kind === 'task' ? 'tasks' : 'deliverables'}/${targetId}/agent-launch`,
      ),
    enabled: session.isAdministrator && Boolean(targetId),
    refetchInterval: 5_000,
  });
  // A choice or verification only applies to the exact receipt the user inspected.
  const scope = `${query.data?.launch?.id}:${query.data?.launch?.revision}`;
  const selected = decision?.scope === scope ? decision.selected : '';
  const checked = decision?.scope === scope ? decision.checked : false;
  const setSelected = (value: string) =>
    setDecision((previous) => ({
      scope,
      selected: value,
      checked: previous?.scope === scope ? previous.checked : false,
    }));
  const setChecked = (value: boolean) =>
    setDecision((previous) => ({
      scope,
      selected: previous?.scope === scope ? previous.selected : '',
      checked: value,
    }));
  const recover = useMutation({
    mutationFn: (action: 'attach' | 'resume' | 'acknowledge' | 'keep') =>
      projectsApi<{ threadId: string | null }>(
        `/${projectId}/resources/${query.data!.launch!.resourceId}/agent-launches/${query.data!.launch!.id}/recover`,
        {
          method: 'POST',
          body: JSON.stringify({
            action,
            expectedUpdatedAt: query.data!.launch!.revision,
            verified:
              action === 'keep' || action === 'acknowledge'
                ? checked
                : undefined,
            targetRevision: query.data!.launch!.targetRevision,
            ...(action === 'attach' ? { threadId: selected } : {}),
          }),
        },
      ),
    onSuccess: async (result, action) => {
      setDecision(null);
      await client.invalidateQueries({ queryKey: ['agent-launch', projectId] });
      await onRecovered();
      if (result.threadId && action !== 'acknowledge') onOpen(result.threadId);
    },
  });
  const launch = query.data?.launch;
  if (
    !session.isAdministrator ||
    !launch ||
    ['submitted', 'ready', 'confirmed', 'abandoned'].includes(launch.state)
  )
    return null;
  const uncertainSend = ['dispatching', 'submitted', 'legacy'].includes(
    launch.phase,
  );
  return (
    <section
      aria-label={t('launchRecoveryTitle')}
      className="max-h-[40dvh] shrink-0 space-y-3 overflow-y-auto rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
    >
      <p className="font-medium">{t('launchRecoveryTitle')}</p>
      <p>
        {launch.busy
          ? t('launchRecoveryBusy')
          : uncertainSend && launch.threadId
            ? t('launchRecoveryUncertainSend')
            : launch.threadId
              ? t('launchRecoveryKnownAgent')
              : t('launchRecoveryUnknownAgent')}
      </p>
      {!launch.busy && !launch.threadId && (
        <label className="block space-y-1">
          <span>{t('launchRecoverySelect')}</span>
          <select
            className="h-10 w-full max-w-full rounded-md border bg-background px-2"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">{t('launchRecoverySelectPlaceholder')}</option>
            {query.data?.candidates.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {query.data?.inventoryError && (
        <p role="status">{t('launchRecoveryInventoryUnavailable')}</p>
      )}
      {!launch.busy && launch.threadId && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          {t('launchRecoveryChecked')}
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching || recover.isPending}
          onClick={() => void query.refetch()}
        >
          {t('launchRecoveryRefresh')}
        </Button>
        {launch.threadId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpen(launch.threadId!)}
          >
            {t('launchRecoveryOpen')}
          </Button>
        )}
        {!launch.busy && !launch.threadId && (
          <Button
            size="sm"
            disabled={
              !selected ||
              recover.isPending ||
              !query.data?.candidates.some((agent) => agent.id === selected)
            }
            onClick={() => recover.mutate('attach')}
          >
            {t('launchRecoveryAttach')}
          </Button>
        )}
        {!launch.busy &&
          launch.threadId &&
          (!uncertainSend || launch.associationPending) && (
            <Button
              size="sm"
              disabled={recover.isPending}
              onClick={() => recover.mutate('resume')}
            >
              {t('launchRecoveryResume')}
            </Button>
          )}
        {!launch.busy &&
          launch.threadId &&
          uncertainSend &&
          !launch.associationPending && (
            <Button
              size="sm"
              disabled={!checked || recover.isPending}
              onClick={() => recover.mutate('acknowledge')}
            >
              {t('launchRecoveryAcknowledge')}
            </Button>
          )}
        {!launch.busy && launch.threadId && (
          <Button
            variant="outline"
            size="sm"
            disabled={!checked || recover.isPending}
            onClick={() => recover.mutate('keep')}
          >
            {t('launchRecoveryKeep')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('launchRecoveryNoReplay')}
      </p>
      {recover.isError && <p role="alert">{t('launchRecoveryConflict')}</p>}
    </section>
  );
}
