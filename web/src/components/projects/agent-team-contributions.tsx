import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { readTeamContributions } from '@/lib/agent-teams-api';
import { getApiErrorMessage } from '@/lib/api-error';
const TeamSidebar = lazy(() =>
  import('@/components/chat/agent-team-sidebar').then((module) => ({
    default: module.AgentTeamSidebar,
  })),
);
export function AgentTeamContributions({
  projectId,
  taskId,
  deliverableId,
}: {
  projectId: string;
  taskId?: string;
  deliverableId?: string;
}) {
  const { t } = useTranslation('teams');
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState<{
    id: string;
    coordinator: string;
  } | null>(null);
  const target = taskId ? { taskId } : { deliverableId: deliverableId! };
  const query = useQuery({
    queryKey: ['agent-team-contributions', projectId, taskId, deliverableId],
    queryFn: ({ signal }) => readTeamContributions(projectId, target, signal),
    enabled: expanded && !!(taskId || deliverableId),
    refetchOnWindowFocus: true,
  });
  const teams = query.isError ? [] : (query.data?.teams ?? []);
  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border p-3 text-sm"
      aria-label={t('contributions')}
    >
      <h3 className="font-medium">{t('contributions')}</h3>
      <Button
        size="sm"
        variant="outline"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? t('hideContributions') : t('showContributions')}
      </Button>
      {expanded && query.isPending && <p role="status">{t('loading')}</p>}
      {expanded && query.isError && (
        <p role="alert" className="break-words text-destructive">
          {getApiErrorMessage(query.error)}
        </p>
      )}
      {expanded && !query.isPending && !query.isError && !teams.length && (
        <p className="text-xs text-muted-foreground">{t('noContributions')}</p>
      )}
      {expanded &&
        teams.map((team) => (
          <article key={team.id} className="min-w-0 space-y-2 border-t pt-2">
            <p className="break-words font-medium">{team.objective}</p>
            {team.assignments.map((assignment) => (
              <div key={assignment.id} className="min-w-0 space-y-1">
                <h4 className="break-words text-xs font-medium">
                  {assignment.role}
                </h4>
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {assignment.result ?? t('noResult')}
                </p>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setOpened({
                  id: team.id,
                  coordinator: team.coordinatorThreadId,
                })
              }
            >
              {t('viewTeam')}
            </Button>
          </article>
        ))}
      {opened && (
        <Suspense fallback={<p>{t('loading')}</p>}>
          <TeamSidebar
            key={opened.id}
            projectId={projectId}
            coordinator={opened.coordinator}
            initialTeamId={opened.id}
            open
            active
            desktop={false}
            onClose={() => setOpened(null)}
          />
        </Suspense>
      )}
    </section>
  );
}
