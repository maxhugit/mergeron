import type { TurnItem } from '@/types/timeline';
export interface TechnicalFileActivity {
  path: string;
  action: 'read' | 'add' | 'update' | 'delete';
  state: 'running' | 'completed' | 'failed' | 'declined';
}
/** Only structured runtime evidence; no inference from arbitrary commands/output. */
export function technicalFileActivity(
  items: TurnItem[],
): TechnicalFileActivity[] {
  const rows = new Map<string, TechnicalFileActivity>();
  for (const item of items) {
    if (item.type === 'imageView' && item.path) {
      rows.set(`read:${item.path}`, {
        path: item.path,
        action: 'read',
        state: item.completed ? 'completed' : 'running',
      });
    }
    if (item.type === 'commandExecution') {
      for (const path of item.readPaths ?? []) {
        const state = !item.completed
          ? 'running'
          : item.exitCode != null && item.exitCode !== 0
            ? 'failed'
            : 'completed';
        rows.set(`read:${path}`, { path, action: 'read', state });
      }
    }
    if (item.type === 'fileChange') {
      const changes = item.fileChanges?.length
        ? item.fileChanges
        : item.filePath
          ? [{ path: item.filePath, changeKind: undefined }]
          : [];
      for (const change of changes) {
        const action = change.changeKind ?? 'update';
        const state =
          item.status === 'failed'
            ? 'failed'
            : item.status === 'declined'
              ? 'declined'
              : !item.completed
                ? 'running'
                : 'completed';
        rows.set(`${action}:${change.path}`, {
          path: change.path,
          action,
          state,
        });
        if ('movePath' in change && change.movePath)
          rows.set(`add:${change.movePath}`, {
            path: change.movePath,
            action: 'add',
            state,
          });
      }
    }
  }
  return [...rows.values()];
}
