import { useQuery } from '@tanstack/react-query';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
export type Capability = {
  id: string;
  title?: Record<string, string>;
  description?: Record<string, string>;
  installed: boolean;
  state: string;
  activeLeases: number;
};
type Catalogue = {
  capabilities: Capability[];
  operation: { id: string; action: string } | null;
  error: string | null;
};
export const capabilitiesKey = ['administration', 'server-capabilities'];
export async function requestCapabilities(
  change?: { id: string; action: string; confirmation: string },
  signal?: AbortSignal,
): Promise<Catalogue> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath('/api/settings/manager/capabilities'),
    {
      method: change ? 'POST' : 'GET',
      signal,
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(change ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(change ? { body: JSON.stringify(change) } : {}),
    },
  );
  if (!response.ok) throw Error('capabilitiesUnavailable');
  return response.json() as Promise<Catalogue>;
}
export function useServerCapabilities(enabled = true) {
  return useQuery({
    queryKey: capabilitiesKey,
    queryFn: ({ signal }) => requestCapabilities(undefined, signal),
    enabled,
    refetchInterval: 5000,
  });
}
