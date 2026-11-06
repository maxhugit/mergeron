import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { type MockupReference, readMockup } from '@/lib/mockups';
import { RememberedMockupFrame } from './remembered-mockup-frame';
import { useMockupOwner } from '@/lib/use-mockup-owner';
/** Reopen the pinned reference with fresh presentation state; source/history remain cached. */
export function MockupPanel({
  reference,
  active,
}: {
  reference: MockupReference;
  active: boolean;
}) {
  return active ? (
    <ActiveMockupPanel
      key={`${reference.id}:${reference.revision}`}
      reference={reference}
    />
  ) : null;
}
function ActiveMockupPanel({ reference }: { reference: MockupReference }) {
  const { t } = useTranslation('mockups');
  const owner = useMockupOwner();
  const [revision, setRevision] = useState(reference.revision);
  const [mobile, setMobile] = useState(false);
  const [reload, setReload] = useState(0);
  const query = useQuery({
    queryKey: [
      'mockup',
      reference.projectId,
      reference.threadId,
      reference.id,
      revision,
    ],
    queryFn: ({ signal }) => readMockup({ ...reference, revision }, signal),
    staleTime: Infinity,
  });
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('title')}>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b p-3 text-sm">
        <strong className="mr-auto min-w-0 max-w-full break-words">
          {query.data?.reference.title ?? reference.title}
        </strong>
        <label>
          {t('revision')}{' '}
          <select
            aria-label={t('revision')}
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            className="rounded border bg-background p-1"
          >
            {(
              query.data?.history ?? [
                { id: reference.revision, number: reference.number },
              ]
            ).map((r) => (
              <option key={r.id} value={r.id}>
                v{r.number}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-pressed={!mobile}
          onClick={() => setMobile(false)}
        >
          {t('desktop')}
        </button>
        <button
          type="button"
          aria-pressed={mobile}
          onClick={() => setMobile(true)}
        >
          {t('mobile')}
        </button>
        <button type="button" onClick={() => setReload((n) => n + 1)}>
          {t('restart')}
        </button>
      </div>
      <p className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
        {t('simulation')}
      </p>
      {query.isError ? (
        <div role="alert" className="p-4">
          {t('loadError')}{' '}
          <button onClick={() => void query.refetch()}>{t('retry')}</button>
        </div>
      ) : !query.data ? (
        <p role="status" className="p-4">
          {t('loading')}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-3">
          <div
            className="mx-auto h-full min-h-96"
            style={{
              width: mobile ? 'min(390px, 100%)' : '100%',
              minWidth: mobile ? undefined : 960,
            }}
          >
            <RememberedMockupFrame
              key={`${revision}:${reload}:${owner ?? 'anonymous'}`}
              reference={query.data.reference}
              owner={owner}
              html={query.data.html}
            />
          </div>
        </div>
      )}
    </section>
  );
}
