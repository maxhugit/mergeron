import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  readUpdateMonitor,
  type UpdateMonitorSnapshot,
} from './update-monitor-api';

/** This path-scoped cookie grants read-only access even while SSO/app APIs are down. */
export function useIndependentUpdateMonitor({
  enabled,
  session,
  expectedId,
  excludedId,
}: {
  enabled: boolean;
  session: number;
  expectedId?: string | null;
  excludedId: string | null;
}) {
  const client = useQueryClient();
  const key = [
    'administration',
    'independent-update-progress',
    session,
    expectedId ?? null,
    excludedId,
  ];
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const result = await readUpdateMonitor(signal);
      const previous = client.getQueryData<UpdateMonitorSnapshot>(key);
      const pinnedId = expectedId ?? previous?.operation?.id;
      if (result.operation?.id === excludedId) {
        if (previous?.operation)
          throw new Error('updateMonitorOperationChanged');
        return { ...result, operation: null };
      }
      if (result.operation && pinnedId && result.operation.id !== pinnedId)
        throw new Error('updateMonitorOperationChanged');
      if (!result.operation && previous?.operation)
        throw new Error('updateMonitorUnavailable');
      return result;
    },
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      if (
        !enabled ||
        query.state.error?.message === 'updateMonitorOperationChanged'
      )
        return false;
      if (
        query.state.data?.operation &&
        query.state.data.operation.status !== 'running'
      )
        return false;
      return Math.min(
        1000 * 2 ** Math.min(query.state.fetchFailureCount, 3),
        8000,
      );
    },
    // Polling must continue when this dedicated monitor is behind another tab.
    refetchIntervalInBackground: true,
  });
}
