import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { projectsApi } from '@/lib/projects-api';
import { key, url, type Status } from '@/lib/git-deliverables-api';
const GitDeliverablesSettings = lazy(() =>
  import('./git-deliverables-settings').then((m) => ({
    default: m.GitDeliverablesSettings,
  })),
);

/** Read-only recognition when a repository is opened; imports stay explicit. */
export function GitDeliverablesDiscovery({
  projectId,
  copyId,
  inspectedAt,
}: {
  projectId: string;
  copyId: string;
  inspectedAt?: number;
}) {
  const { t } = useTranslation(['workspaces', 'common'], {
    nsMode: 'fallback',
  });
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: [...key(projectId), 'discovery', copyId, inspectedAt],
    queryFn: () =>
      projectsApi<Status>(
        url(projectId) + `?copyId=${encodeURIComponent(copyId)}`,
      ),
    staleTime: 30_000,
    gcTime: 60_000,
    retry: false,
  });
  const active = query.data?.boards?.some(
    (b) =>
      b.settings?.enabled &&
      query.data?.copies.some((c) => c.id === copyId && c.eligible),
  );
  if (!active && !query.data?.discovered?.length && !query.data?.discoveryError)
    return null;
  return (
    <section className="shrink-0 space-y-2 border-b p-2 text-xs">
      <p>
        {active
          ? t('gitDeliverablesActive')
          : t('gitDeliverablesDetected', {
              count: query.data?.discovered?.length ?? 0,
            })}
      </p>
      {query.data?.discoveryError && (
        <p role="alert">{t('gitDeliverablesUnavailable')}</p>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t('gitDeliverablesReview')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('gitDeliverablesTitle')}</DialogTitle>
          </DialogHeader>
          <Suspense fallback={<p>{t('loading')}</p>}>
            <GitDeliverablesSettings
              projectId={projectId}
              preferredCopyId={copyId}
            />
          </Suspense>
        </DialogContent>
      </Dialog>
    </section>
  );
}
