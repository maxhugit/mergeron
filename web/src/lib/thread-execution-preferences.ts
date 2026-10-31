import { withBasePath } from '@/base-path';
import { getAuthorizationHeader } from '@/auth-token';
import type { PatchThreadSecurityPolicyDto } from '@/generated/api';
import type { ReasoningEffort } from '@/stores/model-store';
import { currentThreadEpoch } from './thread-recovery-epoch';

export interface AgentExecutionPreferences {
  revision: number;
  model?: string | null;
  effort?: ReasoningEffort | null;
  serviceTier?: string | null;
  security?: PatchThreadSecurityPolicyDto;
  securitySaveState?: 'pending' | 'failed' | null;
}
export type AgentModelChoices = Pick<
  AgentExecutionPreferences,
  'model' | 'effort' | 'serviceTier'
>;
export const executionPreferenceKey = (threadId: string | null) =>
  ['agent-execution-preferences', threadId] as const;
export async function requestExecutionPreferences(
  threadId: string,
  patch?: AgentModelChoices,
  signal?: AbortSignal,
): Promise<AgentExecutionPreferences> {
  const epoch = currentThreadEpoch(threadId);
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath(
      `/api/threads/${encodeURIComponent(threadId)}/execution-preferences`,
    ),
    {
      method: patch ? 'PATCH' : 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(patch ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(patch ? { body: JSON.stringify(patch) } : {}),
    },
  );
  if (!response.ok) throw new Error('Agent execution preferences unavailable');
  const result = (await response.json()) as AgentExecutionPreferences;
  if (currentThreadEpoch(threadId) !== epoch)
    throw new Error('Discarded stale agent preferences');
  if (!Number.isSafeInteger(result.revision) || result.revision < 0)
    throw new Error('Invalid agent preferences');
  return result;
}
