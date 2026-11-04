import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { projectsApi } from './projects-api';
export type DocumentLabel = { id: string; name: string };
export type DocumentLabelPlan = {
  labels: DocumentLabel[];
  assignments: Record<string, string[]>;
  reason: string;
};
export type DocumentOrganization = {
  labels: DocumentLabel[];
  assignments: Record<string, string[]>;
  revision: number;
  deliverableVersion?: number;
  fingerprint: string;
  automaticEnabled: boolean;
  jobs: Array<{
    id: string;
    mode: 'proposal' | 'automatic';
    documentId: string | null;
    status: 'queued' | 'running' | 'proposed' | 'applied' | 'failed' | 'stale';
    result: DocumentLabelPlan | null;
    error: string | null;
    createdAt: number;
  }>;
};
export function useDocumentOrganization(
  base: string | undefined,
  id: string | undefined,
  version?: number,
) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['document-organization', base, id, version],
    queryFn: async () => {
      const value = await projectsApi<DocumentOrganization>(
        `${base}/${id}/organization`,
      );
      if (
        !Array.isArray(value.labels) ||
        !Array.isArray(value.jobs) ||
        !value.assignments
      )
        throw new Error('Invalid document organization');
      return value;
    },
    enabled: !!base && !!id,
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) =>
        ['queued', 'running'].includes(j.status),
      )
        ? 2000
        : 15000,
    retry: false,
  });
  useEffect(() => {
    if (
      version !== undefined &&
      query.data?.deliverableVersion !== undefined &&
      query.data.deliverableVersion !== version
    )
      void client.invalidateQueries({ queryKey: ['project-deliverables'] });
  }, [client, version, query.data?.deliverableVersion]);
  return query;
}
