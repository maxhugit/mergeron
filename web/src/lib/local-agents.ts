import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import type { ModelDto } from '@/generated/api';
export interface LocalAgentConfiguration {
  enabled: boolean;
  url: string;
  models: string;
  context: number;
}
export interface LocalAgentCatalog {
  data: ModelDto[];
  available: boolean;
  error: string | null;
}
export const localAgentModelsKey = ['local-agent-models'] as const;
export const isLocalModel = (model: string | null | undefined) =>
  !!model?.startsWith('ollama:');
export async function localAgentsApi<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/local-agents/${path}`), {
    method: body === undefined ? 'GET' : 'PUT',
    credentials: 'same-origin',
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error('Local agent request failed');
  return response.json() as Promise<T>;
}
