import { lazy, Suspense, type ReactNode } from 'react';
import { suffix } from '@/lib/git-deliverables-api';
import { translationKey } from '@/locales/translation-key';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  AlertCircle,
  Clock3,
  GitBranch,
  Loader2,
  Minus,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
const GitDeliverablesSettings = lazy(() =>
  import('@/components/projects/git-deliverables-settings').then((module) => ({
    default: module.GitDeliverablesSettings,
  })),
);
import type { useDeliverableGitStatus } from '@/hooks/use-deliverable-git-status';
import type { DeliverableGitState } from '@/lib/deliverable-git-state';
const icons = {
  ready: CheckCircle2,
  error: AlertCircle,
  review: AlertCircle,
  checking: Loader2,
  syncing: Loader2,
  pending: Clock3,
  waiting: Clock3,
  off: Minus,
  noCopy: Minus,
  readOnly: Minus,
  excluded: Minus,
};
const labels = {
  ready: 'deliverableGitStateReady',
  error: 'deliverableGitStateError',
  review: 'deliverableGitStateReview',
  checking: 'deliverableGitStateChecking',
  syncing: 'deliverableGitStateSyncing',
  pending: 'deliverableGitStatePending',
  waiting: 'deliverableGitStateWaiting',
  off: 'deliverableGitStateOff',
  noCopy: 'deliverableGitStateNoCopy',
  readOnly: 'deliverableGitStateReadOnly',
  excluded: 'deliverableGitStateExcluded',
} as const;
const colors = (state: DeliverableGitState) =>
  state === 'ready'
    ? 'text-emerald-600 dark:text-emerald-400'
    : state === 'error'
      ? 'text-destructive'
      : ['pending', 'waiting', 'review'].includes(state)
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';
type Sync = ReturnType<typeof useDeliverableGitStatus>;
export function DeliverableGitBadge({
  sync,
  itemId,
}: {
  sync: Sync;
  itemId: string;
}) {
  const { t } = useTranslation('workspaces');
  const state = sync.state(itemId),
    Icon = icons[state];
  if (!sync.data?.boards.some((board) => board.settings?.enabled)) return null;
  return (
    <button
      type="button"
      onClick={() => sync.openReview(itemId)}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[11px] hover:bg-muted ${colors(state)}`}
      title={t(translationKey(labels[state]))}
    >
      <Icon
        className={`h-3.5 w-3.5 ${['checking', 'syncing'].includes(state) ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      <span className="sr-only">
        {t('deliverableGitStatus')}: {t(translationKey(labels[state]))}
      </span>
    </button>
  );
}
export function DeliverableGitBanner({
  sync,
  projectId,
  canManage,
  children,
}: {
  sync: Sync;
  projectId: string;
  canManage: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation('workspaces');
  const enabled = sync.data?.boards.some((board) => board.settings?.enabled);
  const open = sync.reviewOpen && enabled;
  const state = sync.state(),
    Icon = icons[state];
  const branch =
    sync.copy?.context?.branch?.replace(/^refs\/heads\//, '') ??
    (sync.copy?.context?.head
      ? `${t('deliverableGitDetached')} ${sync.copy.context.head.slice(0, 7)}`
      : t('deliverableGitUnknownBranch'));
  return (
    <>
      <section
        className="flex h-12 shrink-0 min-w-0 items-center gap-1 border-b px-2 text-xs"
        aria-label={t('deliverableGitStatus')}
      >
        {sync.data?.boards.some((board) => board.settings?.enabled) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 min-w-0 max-w-[50%] gap-1.5 px-1.5"
            onClick={() => sync.openReview()}
            aria-label={`${t('gitDeliverablesReview')} · ${branch} · ${t(translationKey(labels[state]))}`}
            title={`${sync.copy?.name ?? t('deliverableGitChooseCopy')} · ${branch} · ${t(translationKey(labels[state]))}`}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">
              {sync.selectedId ? branch : t('deliverableGitChooseCopy')}
            </span>
            <span
              role="status"
              className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${colors(state)}`}
              aria-label={t(translationKey(labels[state]))}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </Button>
        )}
        <span className="flex-1" />
        {children}
      </section>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) sync.closeReview();
        }}
      >
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('gitDeliverablesReview')}</DialogTitle>
            <DialogDescription className="text-xs">
              {t('deliverableGitLocalHelp')}
            </DialogDescription>
          </DialogHeader>
          {sync.copies.length > 1 && (
            <select
              className="min-w-0 rounded border bg-background p-1"
              aria-label={t('deliverableGitCopy')}
              value={sync.selectedId ?? ''}
              onChange={(event) => sync.select(event.target.value)}
            >
              <option value="" disabled>
                {t('deliverableGitChooseCopy')}
              </option>
              {sync.copies.map((copy) => (
                <option key={copy.id} value={copy.id}>
                  {copy.name}
                </option>
              ))}
            </select>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 self-start"
            aria-label={t('deliverableGitRefresh')}
            onClick={sync.refresh}
            disabled={sync.checking}
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {t('deliverableGitRefresh')}
          </Button>
          <p
            role="status"
            aria-label={t(
              translationKey(labels[sync.state(sync.reviewItemId)]),
            )}
            className={`text-xs ${colors(sync.state(sync.reviewItemId))}`}
          >
            {t(translationKey(labels[sync.state(sync.reviewItemId)]))}
          </p>
          <p className="break-words text-xs">
            {sync.copy?.name} · {branch}
          </p>
          {sync.data?.verifiedAt && (
            <p className="text-xs text-muted-foreground">
              {t('deliverableGitVerifiedAt')}{' '}
              {new Date(sync.data.verifiedAt).toLocaleString()}
            </p>
          )}
          <div className="min-h-0 overflow-auto">
            <ul className="mb-3 space-y-1 text-xs">
              {sync.data?.proposal?.changes
                .filter(
                  (change) =>
                    !sync.reviewItemId ||
                    !change.deliverableId ||
                    change.deliverableId === sync.reviewItemId,
                )
                .map((change, index) => (
                  <li key={index}>
                    {change.deliverable}
                    {change.document ? ` · ${change.document}` : ''} —{' '}
                    {t(
                      translationKey(
                        `gitDeliverablesReason${suffix(change.reason)}`,
                      ),
                    )}
                  </li>
                ))}
            </ul>
            {open && canManage && sync.selectedId && (
              <Suspense
                fallback={
                  <p role="status">{t('deliverableGitStateChecking')}</p>
                }
              >
                <GitDeliverablesSettings
                  key={`${projectId}:${sync.selectedId}`}
                  projectId={projectId}
                  preferredCopyId={sync.selectedId}
                />
              </Suspense>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
