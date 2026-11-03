import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Circle,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock3,
  Loader2,
  Network,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  listAgentTeams,
  readAgentTeam,
  assignmentState,
} from '@/lib/agent-teams-api';
import { getApiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/utils';
import { AgentTeamActions } from './agent-team-actions';

const icons = {
  planned: Circle,
  running: Loader2,
  waiting: Clock3,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: CircleX,
  unknown: CircleHelp,
  approval: Clock3,
  question: CircleHelp,
};
const colors = {
  planned: 'text-muted-foreground',
  running: 'text-purple-700 dark:text-purple-300',
  waiting: 'text-amber-700 dark:text-amber-300',
  completed: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
  approval: 'text-amber-700 dark:text-amber-300',
  question: 'text-amber-700 dark:text-amber-300',
};

export function AgentTeamSidebar({
  projectId,
  coordinator,
  open,
  active,
  desktop,
  onClose,
}: {
  projectId: string;
  coordinator: string;
  open: boolean;
  active: boolean;
  desktop: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('teams');
  const labels = {
    planned: t('states.planned'),
    running: t('states.running'),
    waiting: t('states.waiting'),
    completed: t('states.completed'),
    failed: t('states.failed'),
    cancelled: t('states.cancelled'),
    unknown: t('states.unknown'),
    approval: t('states.approval'),
    question: t('states.question'),
  };
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedAssignment, setSelectedAssignment] = useState<string | null>(
    null,
  );
  const listing = useQuery({
    queryKey: ['agent-teams', projectId, coordinator],
    queryFn: ({ signal }) => listAgentTeams(projectId, coordinator, signal),
    enabled: open && active,
    refetchInterval: open && active ? 5000 : false,
  });
  const teams = listing.isError ? [] : (listing.data?.teams ?? []);
  const team = teams.find((team) => team.id === selectedTeam) ?? teams[0];
  const details = useQuery({
    queryKey: ['agent-team', projectId, team?.id],
    queryFn: ({ signal }) => readAgentTeam(projectId, team!.id, signal),
    enabled: open && active && !!team && !listing.isError,
    refetchInterval: open && active ? 5000 : false,
  });
  const assignments = team?.assignments ?? [];
  const selected =
    assignments.find((a) => a.id === selectedAssignment) ?? assignments[0];
  const selectedDetails = details.isError
    ? undefined
    : details.data?.assignments.find((a) => a.id === selected?.id);
  const content = (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t('title')}
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-3">
        <Network className="h-4 w-4" />
        <h2 className="min-w-0 flex-1 text-sm font-medium">{t('title')}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('refresh')}
          disabled={listing.isFetching || details.isFetching}
          onClick={() => {
            void listing.refetch();
            if (team) void details.refetch();
          }}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('close')}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-sm">
        {listing.isPending && <p role="status">{t('loading')}</p>}
        {listing.isError && (
          <p role="alert" className="break-words text-destructive">
            {getApiErrorMessage(listing.error)}
          </p>
        )}
        {!listing.isPending && !listing.isError && !teams.length && (
          <p className="text-muted-foreground">{t('empty')}</p>
        )}
        {!!teams.length && (
          <>
            <label className="block space-y-1">
              <span>{t('mission')}</span>
              <select
                className="h-10 w-full min-w-0 rounded-md border bg-background px-2"
                value={team?.id ?? ''}
                onChange={(e) => {
                  setSelectedTeam(e.target.value);
                  setSelectedAssignment(null);
                }}
              >
                {teams.map((team) => (
                  <option value={team.id} key={team.id}>
                    {team.objective}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">{t('coordinator')}</p>
            <div className="space-y-2" aria-label={t('members')}>
              {assignments.map((assignment) => {
                const pending = details.isError
                  ? undefined
                  : details.data?.attention.find(
                      (request) =>
                        request.threadId === assignment.nativeThreadId,
                    );
                const state =
                    pending?.kind ?? assignmentState(assignment, assignments),
                  Icon = icons[state];
                return (
                  <button
                    type="button"
                    key={assignment.id}
                    aria-pressed={assignment.id === selected?.id}
                    onClick={() => setSelectedAssignment(assignment.id)}
                    className={cn(
                      'flex w-full min-w-0 items-start gap-2 rounded-lg border p-3 text-left hover:bg-accent',
                      assignment.id === selected?.id &&
                        'border-primary bg-accent',
                    )}
                  >
                    <Bot className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="min-w-0 space-y-1">
                      <span className="block break-words font-medium">
                        {assignment.role}
                      </span>
                      <span
                        className={cn(
                          'flex items-center gap-1.5 text-xs',
                          colors[state],
                        )}
                      >
                        <Icon
                          className={cn(
                            'h-4 w-4 shrink-0',
                            state === 'running' &&
                              'animate-spin motion-reduce:animate-none',
                          )}
                        />
                        {labels[state]}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {selected && (
              <div className="space-y-3 border-t pt-3" aria-live="polite">
                <h3 className="break-words font-medium">{selected.role}</h3>
                {!!selected.dependencies.length && (
                  <p className="break-words text-xs text-muted-foreground">
                    {t('dependencies', {
                      names: selected.dependencies
                        .map(
                          (id) =>
                            assignments.find((a) => a.id === id)?.role ??
                            t('missingDependency'),
                        )
                        .join(', '),
                    })}
                  </p>
                )}
                {details.isError ? (
                  <p role="alert" className="break-words text-destructive">
                    {getApiErrorMessage(details.error)}
                  </p>
                ) : selectedDetails ? (
                  <>
                    <div>
                      <h4 className="mb-1 font-medium">{t('instructions')}</h4>
                      <p className="whitespace-pre-wrap break-words text-muted-foreground">
                        {selectedDetails.instructions}
                      </p>
                    </div>
                    <div>
                      <h4 className="mb-1 font-medium">{t('result')}</h4>
                      <p className="whitespace-pre-wrap break-words text-muted-foreground">
                        {selectedDetails.result ?? t('noResult')}
                      </p>
                    </div>
                  </>
                ) : (
                  <p role="status">{t('loading')}</p>
                )}
              </div>
            )}
            {!details.isError && details.data && selected && (
              <AgentTeamActions
                key={`${team?.id}:${selected.id}`}
                projectId={projectId}
                team={details.data}
                assignmentId={selected.id}
                onChanged={() => {
                  void listing.refetch();
                  void details.refetch();
                }}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
  if (desktop)
    return open ? (
      <aside className="flex h-full w-80 max-w-[45vw] shrink-0 flex-col border-l bg-background">
        {content}
      </aside>
    ) : null;
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <SheetContent
        aria-describedby={undefined}
        side="right"
        className="flex w-[94vw] max-w-md flex-col p-0 [&>button]:hidden"
      >
        <SheetTitle className="sr-only">{t('title')}</SheetTitle>
        {content}
      </SheetContent>
    </Sheet>
  );
}
