import { useTranslation } from 'react-i18next';
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock3,
  Loader2,
} from 'lucide-react';
import type { AgentTeamDetail } from '@/lib/agent-teams-api';
import { cn } from '@/lib/utils';
export function AgentTeamMissionStatus({ team }: { team: AgentTeamDetail }) {
  const { t } = useTranslation('teams');
  const labels = {
    observed: t('teamStates.observed'),
    draft: t('teamStates.draft'),
    preparing: t('teamStates.preparing'),
    dispatching: t('teamStates.dispatching'),
    running: t('teamStates.running'),
    completed: t('teamStates.completed'),
    failed: t('teamStates.failed'),
    stopping: t('teamStates.stopping'),
    stopped: t('teamStates.stopped'),
    unknown: t('teamStates.unknown'),
    needs_attention: t('teamStates.needsAttention'),
  };
  const running = ['preparing', 'dispatching', 'running', 'stopping'].includes(
    team.state,
  );
  const Icon =
    team.state === 'completed'
      ? CircleCheck
      : team.state === 'failed' || team.state === 'stopped'
        ? CircleX
        : running
          ? Loader2
          : team.state === 'draft'
            ? Clock3
            : CircleHelp;
  const done = team.assignments.filter((a) => a.status === 'completed').length;
  return (
    <section
      className="space-y-2 rounded-md border p-3"
      aria-label={t('missionProgress')}
    >
      <p
        className={cn(
          'flex items-center gap-2 font-medium',
          team.state === 'completed'
            ? 'text-emerald-700 dark:text-emerald-300'
            : team.state === 'failed'
              ? 'text-destructive'
              : running
                ? 'text-purple-700 dark:text-purple-300'
                : 'text-muted-foreground',
        )}
      >
        <Icon
          className={cn(
            'h-6 w-6 shrink-0',
            running && 'animate-spin motion-reduce:animate-none',
          )}
        />
        {labels[team.state]}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('completedCount', { done, total: team.assignments.length })}
      </p>
      {team.summary && (
        <details>
          <summary className="cursor-pointer text-xs font-medium">
            {t('coordinatorSummary')}
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {team.summary}
          </p>
        </details>
      )}
    </section>
  );
}
