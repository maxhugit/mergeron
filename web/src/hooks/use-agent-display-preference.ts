import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import {
  useAgentDisplayStore,
  type AgentDisplayMode,
} from '@/stores/agent-display-store';
type Detail = AgentDisplayMode;

export async function request(
  threadId: string,
  mode?: Detail,
): Promise<{ mode: Detail }> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath(
      `/api/threads/${encodeURIComponent(threadId)}/response-detail`,
    ),
    {
      credentials: 'same-origin',
      redirect: 'error',
      method: mode ? 'PATCH' : 'GET',
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(mode ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(mode ? { body: JSON.stringify({ mode }) } : {}),
    },
  );
  if (!response.ok) throw new Error('Response detail unavailable');
  const result = (await response.json()) as { mode: Detail };
  if (!['hidden', 'collapsed', 'expanded'].includes(result.mode))
    throw new Error('Invalid response detail');
  return result;
}

export function useAgentDisplayPreference(threadId: string | null) {
  const key = ['agent-response-detail', threadId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => request(threadId!),
    enabled: !!threadId,
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    if (threadId && query.data)
      useAgentDisplayStore.getState().record(threadId, query.data.mode);
  }, [threadId, query.data]);
  return query;
}
