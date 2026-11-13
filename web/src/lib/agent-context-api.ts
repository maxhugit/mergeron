import {
  agentContextProfile,
  agentContextSaveProfile,
  agentContextStatus,
  agentContextAssociate,
  agentContextVerify,
  agentContextPreview,
} from '@/generated/api/sdk.gen';
import type {
  AgentPreferencesDto,
  AgentContextStatusDto,
  AgentContextSourceDto,
} from '@/generated/api/types.gen';

export type AgentPreferences = AgentPreferencesDto;
export type ContextSource = AgentContextSourceDto;
export type AgentContextStatus = AgentContextStatusDto;
export const agentContextKey = (threadId: string, personId?: string | null) =>
  ['agent-context', personId, threadId] as const;
export async function getAgentContext(threadId: string, signal?: AbortSignal) {
  const { data } = await agentContextStatus({
    path: { threadId },
    signal,
    throwOnError: true,
  });
  return data;
}
export async function setAgentInstructionSource(
  threadId: string,
  copyId: string | null,
  version: number,
) {
  const { data } = await agentContextAssociate({
    path: { threadId },
    body: { copyId, version },
    throwOnError: true,
  });
  return data;
}
export async function verifyAgentContext(threadId: string) {
  const { data } = await agentContextVerify({
    path: { threadId },
    throwOnError: true,
  });
  return data;
}
export async function getAgentPreferences(signal?: AbortSignal) {
  const { data } = await agentContextProfile({ signal, throwOnError: true });
  return data;
}
export async function setAgentPreferences(preferences: AgentPreferences) {
  const { data } = await agentContextSaveProfile({
    body: preferences,
    throwOnError: true,
  });
  return data;
}
export async function previewGitInstructions(
  threadId: string,
  signal?: AbortSignal,
) {
  const { data } = await agentContextPreview({
    path: { threadId },
    signal,
    throwOnError: true,
  });
  return data;
}
