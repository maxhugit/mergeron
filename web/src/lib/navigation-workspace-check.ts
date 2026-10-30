/** Navigation maintenance is shared, not a disk-wide POST for every click. */
import type { QueryClient } from '@tanstack/react-query';
import { projectsApi, projectsQueryKey } from './projects-api';
import { invalidateThreadListSoon } from './query-invalidation';
import { showSnackbar } from '@/stores/snackbar-store';
import { getApiErrorMessage } from './api-error';
import i18n from '@/i18n';

const checks = new WeakMap<
  QueryClient,
  { completedAt: number; pending?: Promise<void> }
>();
export function checkNavigationWorkspaces(
  client: QueryClient,
  force = false,
): Promise<void> {
  let state = checks.get(client);
  if (state?.pending) return state.pending;
  if (!force && state && Date.now() - state.completedAt < 30_000)
    return Promise.resolve();
  state ??= { completedAt: -Infinity };
  checks.set(client, state);
  const current = state;
  current.pending = projectsApi<{ removed: string[]; unresolved: string[] }>(
    '/reconcile-workspaces',
    { method: 'POST' },
  )
    .then(async (result) => {
      current.completedAt = Date.now();
      if (result.removed.length) {
        await client.invalidateQueries({ queryKey: projectsQueryKey });
        invalidateThreadListSoon(client);
        showSnackbar(
          i18n.t('countMissingWorkspaceReferenceSCleanedUp', {
            count: result.removed.length,
          }),
          'info',
        );
      }
      if (result.unresolved.length)
        showSnackbar(
          i18n.t('aProjectHasNoRemainingWorkspaceOnDisk'),
          'warning',
        );
    })
    .catch((error: unknown) => {
      current.completedAt = -Infinity;
      showSnackbar(getApiErrorMessage(error), 'warning');
    })
    .finally(() => {
      current.pending = undefined;
    });
  return current.pending;
}
