/** Read-only refresh for the displayed copy, independent of the explorer's tab/root. */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/socket';
import { acquireFileWatch } from '@/lib/file-watch-leases';
import {
  filePathChanges,
  pathIsWithin,
  subscribeFileChanges,
  type FileChange,
} from '@/lib/file-change-events';
import type { ProjectWorkspaceCopySummary } from '@/lib/projects-api';

export function useGitCopyLiveUpdates(
  projectId: string,
  copy?: ProjectWorkspaceCopySummary,
  threadId?: string,
) {
  const client = useQueryClient();
  const copyId = copy?.id,
    root = copy?.localPath;
  useEffect(() => {
    if (!copyId || !root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) return;
      // Coalesce file storms; do not starve refresh until an agent stops writing.
      timer = setTimeout(() => {
        timer = undefined;
        for (const family of [
          'workspace-git',
          'workspace-git-staged',
          'workspace-git-diff',
          'workspace-git-commits',
          'workspace-git-graph',
        ])
          void client.invalidateQueries({
            queryKey: [family, projectId, copyId],
          });
      }, 400);
    };
    const touches = (paths: string[]) =>
      paths.some(
        (path) => pathIsWithin(path, root) || pathIsWithin(root, path),
      );
    const onFile = (change: FileChange) => {
      const paths = filePathChanges(change).flatMap((fact) =>
        fact.kind === 'rename'
          ? [fact.oldPath, fact.newPath]
          : fact.kind === 'delete'
            ? [fact.path]
            : fact.paths,
      );
      if (touches(paths)) refresh();
    };
    const socket = getSocket();
    const onWatch = (change: {
      watchPath: string;
      changedPaths: string[];
      refresh?: boolean;
    }) => {
      if (
        touches(change.changedPaths) ||
        (change.refresh && touches([change.watchPath]))
      )
        refresh();
    };
    const onNotification = (note: {
      method: string;
      params?: { threadId?: string };
    }) => {
      if (
        threadId &&
        note.params?.threadId === threadId &&
        ['turn/completed', 'item/completed'].includes(note.method)
      )
        refresh();
    };
    const unsubscribe = subscribeFileChanges(onFile);
    socket.on('fs.changed', onWatch);
    socket.on('codex.notification', onNotification);
    socket.on('connect', refresh);
    const release = acquireFileWatch(root);
    return () => {
      release();
      unsubscribe();
      socket.off('fs.changed', onWatch);
      socket.off('codex.notification', onNotification);
      socket.off('connect', refresh);
      if (timer) clearTimeout(timer);
    };
  }, [client, projectId, copyId, root, threadId]);
}
