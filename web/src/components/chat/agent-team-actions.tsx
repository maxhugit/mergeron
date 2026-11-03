import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  controlAgentTeam,
  launchAgentTeam,
  readTeamHistory,
  type AgentTeamDetail,
} from '@/lib/agent-teams-api';
import { getApiErrorMessage } from '@/lib/api-error';
import type { PendingServerRequestDto } from '@/generated/api';
import { samePendingRequest } from '@/lib/pending-request-identity';
import { syncPendingApprovals } from '@/lib/pending-approvals-sync';
import { useTimelineStore } from '@/stores/timeline-store';
import { ApprovalItem } from './turn-items/approval-item';
import { InteractionCard } from './turn-items/interaction-card';
import { UserInputCard } from './turn-items/user-input-card';

function TeamRequest({ request }: { request: PendingServerRequestDto }) {
  const { t } = useTranslation('teams');
  const held = useTimelineStore((s) => {
    const runtime = s.getThreadRuntime(request.threadId);
    return (
      runtime?.approvals[String(request.requestId)] ??
      runtime?.userInputRequests[String(request.requestId)]
    );
  });
  useEffect(() => {
    const controller = new AbortController();
    void syncPendingApprovals([request.threadId], controller.signal);
    return () => controller.abort();
  }, [request.threadId, request.instanceId]);
  if (!held || !samePendingRequest(held, request))
    return <p role="status">{t('refreshRequest')}</p>;
  if ('questions' in held) return <UserInputCard request={held} />;
  return held.kind === 'permissions' || held.kind === 'elicitation' ? (
    <InteractionCard request={held} />
  ) : (
    <ApprovalItem approval={held} />
  );
}

export function AgentTeamActions({
  projectId,
  team,
  assignmentId,
  onChanged,
}: {
  projectId: string;
  team: AgentTeamDetail;
  assignmentId: string;
  onChanged: () => void;
}) {
  const { t } = useTranslation('teams');
  const [confirmStop, setConfirmStop] = useState(false),
    [showHistory, setShowHistory] = useState(false);
  const [confirmLaunch, setConfirmLaunch] = useState(false);
  const launch = useMutation({
    mutationFn: () => launchAgentTeam(projectId, team.id),
    retry: false,
    onSuccess: () => {
      setConfirmLaunch(false);
      onChanged();
    },
    onError: () => onChanged(),
  });
  const assignment = team.assignments.find((a) => a.id === assignmentId);
  const mutation = useMutation({
    mutationFn: (action: 'stop' | 'reconcile') =>
      controlAgentTeam(projectId, team.id, action),
    retry: false,
    onSuccess: () => {
      setConfirmStop(false);
      onChanged();
    },
    onError: () => onChanged(),
  });
  const messages = useInfiniteQuery({
    queryKey: ['agent-team-history', projectId, team.id, assignmentId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      readTeamHistory(projectId, team.id, assignmentId, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: showHistory && !!assignment?.nativeThreadId,
  });
  const sources = new Set([
    team.coordinatorThreadId,
    ...(assignment?.nativeThreadId ? [assignment.nativeThreadId] : []),
  ]);
  const requests = team.requests.filter((request) =>
    sources.has(request.threadId),
  );
  const needsAdministrator =
    !team.canRespond &&
    team.attention.some((request) => sources.has(request.threadId));
  return (
    <div className="space-y-3 border-t pt-3">
      {team.state === 'draft' && team.canRespond && (
        <>
          <p className="text-xs text-muted-foreground">{t('draftReady')}</p>
          <Button size="sm" onClick={() => setConfirmLaunch(true)}>
            {t('launchTeam')}
          </Button>
        </>
      )}
      {team.lastError && (
        <p
          role="alert"
          className="break-words text-amber-700 dark:text-amber-300"
        >
          {team.lastError === 'TEAM_STOP_UNCONFIRMED'
            ? t('stopUnconfirmed')
            : t('stateNeedsVerification')}
        </p>
      )}
      {team.controlsLimited && <p>{t('controlsLimited')}</p>}
      {team.canRespond && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate('reconcile')}
          >
            {t('verifyState')}
          </Button>
          {!['completed', 'stopped'].includes(team.state) && (
            <Button
              variant="outline"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => setConfirmStop(true)}
            >
              {t('stopTeam')}
            </Button>
          )}
        </div>
      )}
      {mutation.isError && !confirmStop && (
        <p role="alert" className="break-words text-destructive">
          {getApiErrorMessage(mutation.error)}
        </p>
      )}
      {needsAdministrator && (
        <p className="text-amber-700 dark:text-amber-300">
          {t('administratorRequired')}
        </p>
      )}
      {requests.map((request) => (
        <div
          key={request.instanceId ?? request.requestId}
          className="min-w-0 space-y-2"
        >
          <p className="break-words font-medium">
            {request.threadId === team.coordinatorThreadId
              ? t('requestFromCoordinator')
              : t('requestFromMember', { name: assignment?.role ?? '' })}
          </p>
          <TeamRequest request={request} />
        </div>
      ))}
      {!!assignment?.nativeThreadId && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowHistory((value) => !value)}
        >
          {showHistory ? t('hideHistory') : t('showHistory')}
        </Button>
      )}
      {showHistory && (
        <div className="space-y-3" aria-live="polite">
          {messages.isPending && <p role="status">{t('loading')}</p>}
          {messages.isError ? (
            <p role="alert" className="break-words text-destructive">
              {getApiErrorMessage(messages.error)}
            </p>
          ) : (
            <>
              {messages.data?.pages
                .flatMap((page) => page.messages)
                .map((message) => (
                  <div key={message.id} className="space-y-1">
                    <p className="text-xs font-medium">
                      {message.role === 'agent'
                        ? assignment?.role
                        : t('coordinatorMessage')}
                    </p>
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">
                      {message.text}
                    </p>
                  </div>
                ))}
              {messages.data?.pages.every((page) => !page.messages.length) && (
                <p>{t('emptyHistory')}</p>
              )}
              {messages.hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={messages.isFetchingNextPage}
                  onClick={() => void messages.fetchNextPage()}
                >
                  {t('olderMessages')}
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <Dialog
        open={confirmLaunch}
        onOpenChange={(value) => {
          if (!launch.isPending) setConfirmLaunch(value);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('launchTitle')}</DialogTitle>
            <DialogDescription>{t('launchSafeguards')}</DialogDescription>
          </DialogHeader>
          <p className="break-words font-medium">{team.objective}</p>
          <ul className="space-y-2">
            {team.assignments.map((a) => (
              <li key={a.id} className="break-words">
                <strong>{a.role}</strong>
                <p className="whitespace-pre-wrap text-xs">{a.instructions}</p>
                {!!a.dependencies.length && (
                  <p className="text-xs">
                    {t('dependencies', {
                      names: a.dependencies
                        .map(
                          (id) =>
                            team.assignments.find((item) => item.id === id)
                              ?.role ?? t('missingDependency'),
                        )
                        .join(', '),
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {launch.isError && (
            <p role="alert" className="break-words text-destructive">
              {getApiErrorMessage(launch.error)}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={launch.isPending}
              onClick={() => setConfirmLaunch(false)}
            >
              {t('cancel')}
            </Button>
            <Button disabled={launch.isPending} onClick={() => launch.mutate()}>
              {t('confirmLaunch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmStop}
        onOpenChange={(value) => {
          if (!mutation.isPending) setConfirmStop(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('stopTitle')}</DialogTitle>
            <DialogDescription>{t('stopDescription')}</DialogDescription>
          </DialogHeader>
          {mutation.isError && (
            <p role="alert" className="break-words text-destructive">
              {getApiErrorMessage(mutation.error)}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setConfirmStop(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate('stop')}
            >
              {t('confirmStop')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
