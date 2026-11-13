import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectsApi } from '@/lib/projects-api';
import { key, post, url, type Status } from '@/lib/git-deliverables-api';
import { useSessionPaused } from '@/lib/session-recovery';
import { useGitCopyLiveUpdates } from './use-git-copy-live-updates';
import {
  deliverableGitState,
  documentGitState,
} from '@/lib/deliverable-git-state';

export function useDeliverableGitStatus(
  projectId: string,
  agentId: string | undefined,
  preferredResourceId: string | null | undefined,
  revision: string,
  canResume = false,
) {
  const client = useQueryClient();
  const paused = useSessionPaused();
  const lastResume = useRef<string | null>(null);
  const scope = JSON.stringify([projectId, agentId, preferredResourceId]);
  const [review, setReview] = useState<{
    scope: string;
    itemId?: string;
  } | null>(null);
  const [choice, choose] = useState<{ scope: string; id: string } | null>(null);
  const summary = useQuery({
    queryKey: [...key(projectId), 'sidebar-copies', agentId],
    queryFn: ({ signal }) => projectsApi<Status>(url(projectId), { signal }),
    retry: false,
    staleTime: 0,
  });
  const copies = (summary.data?.copies ?? []).filter(
    (copy) => !agentId || copy.ownerThreadIds?.includes(agentId),
  );
  const preferred = preferredResourceId
    ? copies.filter((copy) => copy.sourceResourceId === preferredResourceId)
    : copies;
  const selectedId =
    choice?.scope === scope && copies.some((copy) => copy.id === choice.id)
      ? choice.id
      : preferred.length === 1
        ? preferred[0].id
        : copies.length === 1
          ? copies[0].id
          : undefined;
  const copy = copies.find((entry) => entry.id === selectedId);
  useGitCopyLiveUpdates(
    projectId,
    copy ? { id: copy.id, localPath: copy.localPath ?? null } : undefined,
    agentId,
    true,
  );
  const enabled =
    summary.data?.boards.some((board) => board.settings?.enabled) === true;
  const detail = useQuery({
    queryKey: [
      ...key(projectId),
      'sidebar-detail',
      agentId,
      selectedId,
      copy?.context?.branch,
      copy?.context?.head,
      revision,
    ],
    queryFn: ({ signal }) =>
      projectsApi<Status>(
        url(projectId) + '?copyId=' + encodeURIComponent(selectedId!),
        { signal },
      ),
    enabled: Boolean(selectedId && enabled),
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => {
      if (!query.state.data || query.state.status === 'error') return false;
      return ['pending', 'waiting', 'syncing', 'checking'].includes(
        deliverableGitState(query.state.data, selectedId),
      )
        ? 2500
        : false;
    },
    refetchIntervalInBackground: false,
  });
  const { mutate: resume, ...resumption } = useMutation({
    mutationFn: (request: { projectId: string; copyId: string }) =>
      post(request.projectId, '/reconcile', { copyId: request.copyId }),
    retry: false,
    onSuccess: (_data, request) =>
      client.invalidateQueries({ queryKey: key(request.projectId) }),
  });
  useEffect(() => {
    if (paused) {
      lastResume.current = null;
      return;
    }
    const status = detail.data;
    const proposal = status?.proposal;
    const selected = status?.copies.find((copy) => copy.id === selectedId);
    if (
      !enabled ||
      !canResume ||
      !selectedId ||
      !selected?.eligible ||
      !selected.writable ||
      !selected.owned ||
      detail.isFetching ||
      detail.isError ||
      status?.active ||
      status?.discoveryError ||
      !proposal?.canApply ||
      !selected.context ||
      !proposal.context ||
      selected.context.branch !== proposal.context.branch ||
      selected.context.head !== proposal.context.head ||
      !proposal.changes.some((change) => change.action === 'export')
    )
      return;
    // Resume once per verified plan, including on remount/reconnect. A blocked
    // sibling must not prevent clean exports, or cause an endless POST loop.
    const token = JSON.stringify([scope, selectedId, proposal.fingerprint]);
    if (lastResume.current === token) return;
    lastResume.current = token;
    resume({ projectId, copyId: selectedId });
  }, [
    projectId,
    scope,
    selectedId,
    enabled,
    canResume,
    paused,
    detail.data,
    detail.dataUpdatedAt,
    detail.isFetching,
    detail.isError,
    resume,
  ]);
  const resumingSelected =
    resumption.variables?.projectId === projectId &&
    resumption.variables.copyId === selectedId;
  const checking =
    (resumingSelected && resumption.isPending) ||
    summary.isFetching ||
    (Boolean(selectedId && enabled) && (detail.isPending || detail.isFetching));
  const failed =
    (resumingSelected && resumption.isError) ||
    summary.isError ||
    (enabled && Boolean(selectedId) && detail.isError);
  const data =
    selectedId && enabled ? (detail.data ?? summary.data) : summary.data;
  return {
    data,
    reviewOpen: review?.scope === scope,
    reviewItemId: review?.scope === scope ? review.itemId : undefined,
    openReview: (itemId?: string) => setReview({ scope, itemId }),
    closeReview: () => setReview(null),
    copies,
    copy: data?.copies.find((entry) => entry.id === selectedId) ?? copy,
    selectedId,
    select: (id: string) => choose({ scope, id }),
    checking,
    state: (itemId?: string) =>
      deliverableGitState(data, selectedId, itemId, checking, failed),
    documentState: (itemId: string, documentId: string, name: string) =>
      documentGitState(
        data,
        selectedId,
        itemId,
        documentId,
        name,
        checking,
        failed,
      ),
    refresh: () => {
      lastResume.current = null;
      void summary.refetch();
      if (selectedId && enabled) void detail.refetch();
    },
  };
}
