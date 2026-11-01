import { useLayoutEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  platformSessionKey,
  updateAuthResource,
  usePlatformSession,
  type PlatformSession,
} from '@/lib/platform-session';
import {
  isSessionPaused,
  sessionOwner,
  sessionVerificationGeneration,
} from '@/lib/session-recovery';
import { useAgentViewCacheStore } from '@/stores/agent-view-cache-store';
import { useSnackbarStore } from '@/stores/snackbar-store';

export function useProjectNavigationPreference() {
  const session = usePlatformSession();
  const client = useQueryClient();
  const { t } = useTranslation('workspaces');
  const inFlight = useRef(false);
  const person = session.data;
  const ready = !!(
    person?.kind === 'person' &&
    person.active &&
    !session.paused &&
    !session.isPending &&
    !session.isError
  );
  const owner = ready ? sessionOwner(person!) : null;
  const projectId = person?.fastNavigationProjectId ?? null;
  useLayoutEffect(() => {
    if (ready)
      useAgentViewCacheStore.getState().restorePreference(owner, projectId);
  }, [ready, owner, projectId]);
  const save = useMutation({
    mutationFn: async (input: {
      projectId: string | null;
      owner: string;
      generation: number;
    }) => {
      const result = await updateAuthResource<{
        fastNavigationProjectId: string | null;
      }>('preferences', { fastNavigationProjectId: input.projectId });
      if (
        result.fastNavigationProjectId !== null &&
        result.fastNavigationProjectId !== input.projectId
      )
        throw new Error('Invalid navigation preference response');
      return { ...result, input };
    },
    onSuccess: (result) => {
      const current = client.getQueryData<PlatformSession>(platformSessionKey);
      if (
        !current?.active ||
        sessionOwner(current) !== result.input.owner ||
        isSessionPaused() ||
        sessionVerificationGeneration() !== result.input.generation
      )
        return;
      client.setQueryData<PlatformSession>(platformSessionKey, {
        ...current,
        fastNavigationProjectId: result.fastNavigationProjectId,
      });
      useAgentViewCacheStore
        .getState()
        .restorePreference(result.input.owner, result.fastNavigationProjectId);
    },
    onError: () =>
      useSnackbarStore.getState().show(t('agentCacheSaveError'), 'error'),
    onSettled: () => {
      inFlight.current = false;
    },
  });
  return {
    available: ready,
    pending: save.isPending,
    enable: async (selected: string): Promise<boolean> => {
      if (!ready || !owner || inFlight.current || isSessionPaused())
        return false;
      if (useAgentViewCacheStore.getState().projectId === selected) return true;
      inFlight.current = true;
      try {
        await save.mutateAsync({
          projectId: selected,
          owner,
          generation: sessionVerificationGeneration(),
        });
        return (
          !isSessionPaused() &&
          useAgentViewCacheStore.getState().owner === owner &&
          useAgentViewCacheStore.getState().projectId === selected
        );
      } catch {
        return false;
      }
    },
    toggle: (selected: string) => {
      if (!ready || !owner || inFlight.current || isSessionPaused()) return;
      inFlight.current = true;
      save.mutate({
        projectId:
          useAgentViewCacheStore.getState().projectId === selected
            ? null
            : selected,
        owner,
        generation: sessionVerificationGeneration(),
      });
    },
  };
}
