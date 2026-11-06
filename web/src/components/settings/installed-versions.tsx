import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { translationKey } from '@/locales/translation-key';
import { Button } from '@/components/ui/button';
import type { InstalledBuild, ManagerStatus } from './manager-status-api';
import {
  componentUpdatesKey,
  requestComponentUpdates,
  type ComponentImageUpdate,
} from './manager-image-updates-api';
import type { ServerReleaseStatus } from './server-release-api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

function target(item?: ComponentImageUpdate) {
  if (
    !item?.targetImage ||
    !item.targetDigest ||
    !/^sha256:[a-f0-9]{64}$/.test(item.targetDigest) ||
    item.id === 'manager' ||
    item.updateManagedBy === 'manager'
  )
    return null;
  if ((!item.updateAvailable || item.checkError) && !item.migrationAvailable)
    return null;
  return `${item.targetImage.replace(/:[^/:]+$/, '')}@${item.targetDigest}`;
}
export function InstalledVersions({
  application,
  status,
  release,
  disabled = true,
  onUpdate,
  trailingActions,
}: {
  application: InstalledBuild;
  status?: ManagerStatus;
  release?: ServerReleaseStatus;
  disabled?: boolean;
  onUpdate?: (images: Record<string, string>) => void;
  trailingActions?: ReactNode;
}) {
  const { t, i18n } = useTranslation('manager');
  const [details, setDetails] = useState<string | null>(null);
  const updates = useQuery({
    queryKey: componentUpdatesKey,
    queryFn: () => requestComponentUpdates(),
    enabled: !!status?.available,
    staleTime: 60000,
    refetchInterval: 300000,
    retry: false,
  });
  const components = status?.available ? status.components : [];
  const rows = [
    {
      id: 'application',
      name: t('versionApplication'),
      build: application,
      imageId: components.find((c) => c.id === 'application')?.imageId,
    },
    {
      id: 'manager',
      name: 'Manager',
      build: status?.available ? status.manager?.build : null,
      imageId: status?.manager?.imageId,
    },
    {
      id: 'browser',
      name: 'Mergeron Browser',
      build: components.find((c) => c.id === 'browser')?.build,
      imageId: components.find((c) => c.id === 'browser')?.imageId,
    },
    ...(status?.optionalServices?.transcription?.enabled
      ? [
          {
            id: 'transcription',
            name: 'Mergeron Transcription',
            build: status.optionalServices.transcription.build,
            imageId: status.optionalServices.transcription.installedImageId,
          },
        ]
      : []),
    ...[
      'ingress',
      'egress',
      ...(components.some((c) => c.id === 'appCatalog') ? ['appCatalog'] : []),
    ].map((id) => {
      const item = components.find((component) => component.id === id);
      return {
        id,
        name:
          id === 'ingress'
            ? 'Ingress · Nginx'
            : id === 'egress'
              ? 'Squid'
              : 'Byparr',
        build: item?.build,
        imageId: item?.imageId,
      };
    }),
  ];
  const candidates =
    updates.data?.components.filter((item) => target(item)) ?? [];
  const compatible =
    !!status?.capabilities?.backupSelection &&
    !!status.capabilities.updateHistory &&
    !!status.capabilities.backupRestore;
  const blocked = disabled || !compatible;
  const date = (value?: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(i18n.language)
      : t('versionUnknown');
  const perform = () => {
    if (!blocked) onUpdate?.({});
  };
  const active = updates.data?.components.find((c) => c.id === details);
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-4"
      aria-label={t('versionsInstalledTitle')}
    >
      <div>
        <h2 className="text-sm font-medium">{t('versionsInstalledTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('managerAutomaticDetection')}
        </p>
      </div>
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
      >
        <span>
          {t(compatible ? 'consoleManagerCompatible' : 'consoleManagerUpgrade')}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDetails('manager')}
        >
          {t('consoleHostProcedure')}
        </Button>
      </div>
      {updates.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('componentUpdatesUnavailable')}
        </p>
      )}
      <div
        className="min-h-0 max-w-full flex-1 overflow-auto overscroll-contain rounded-lg border border-border"
        role="region"
        aria-label={t('versionsInstalledTitle')}
        tabIndex={0}
      >
        <table className="w-full min-w-[850px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-background text-xs text-muted-foreground">
            <tr>
              {[
                'versionComponent',
                'versionInstalled',
                'consoleSource',
                'consoleAvailable',
                'consoleState',
                'managerBackupActionsColumn',
              ].map((key) => (
                <th scope="col" className="p-3 font-medium" key={key}>
                  {t(translationKey(key))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const item = updates.data?.components.find(
                (c) => c.id === row.id,
              );
              const known =
                !!item &&
                !item.checkError &&
                (item.versionStatus === 'current' || item.updateAvailable);
              const vendor = ['ingress', 'egress'].includes(row.id);
              return (
                <tr className="border-t border-border" key={row.id}>
                  <th scope="row" className="whitespace-nowrap p-3 font-medium">
                    {row.name}
                    {components.find((c) => c.id === row.id)?.state ===
                      'stopped' && (
                      <span className="mt-1 block text-xs font-normal text-muted-foreground">
                        {t('optionalServiceStopped')}
                      </span>
                    )}
                  </th>
                  <td className="p-3">
                    <span>{row.build?.version ?? t('versionUnknown')}</span>
                    {row.build?.revision &&
                      /^[a-f0-9]{40}$/.test(row.build.revision) && (
                        <a
                          className="mt-1 block font-mono text-xs text-primary underline"
                          href={`https://github.com/maxhugit/mergeron/commit/${row.build.revision}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {row.build.revision.slice(0, 7)}
                        </a>
                      )}
                    <span className="block text-xs text-muted-foreground">
                      {vendor ? t('consoleImageDate') : t('versionBuiltAt')} ·{' '}
                      {date(row.build?.builtAt)}
                    </span>
                    {row.imageId && (
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">
                          {t('versionImageIdentity')}
                        </summary>
                        <span className="block max-w-48 break-all font-mono">
                          {row.imageId}
                        </span>
                      </details>
                    )}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {vendor
                      ? (item?.targetImage ?? t('versionUnknown'))
                      : row.build?.channel === 'edge'
                        ? t('versionEdge')
                        : row.build?.channel === 'stable'
                          ? t('versionStable')
                          : t('versionUnknown')}
                  </td>
                  <td className="p-3 text-xs">
                    {item?.updateAvailable
                      ? (item.targetBuild?.version ??
                        (row.id === 'application'
                          ? release?.latestVersion
                          : null) ??
                        t('consoleNewImage'))
                      : '—'}
                    {item?.updateAvailable && item.targetBuild?.revision && (
                      <span className="block font-mono text-muted-foreground">
                        {item.targetBuild.revision.slice(0, 7)}
                      </span>
                    )}
                    {item?.updateAvailable && (
                      <button
                        className="mt-1 block cursor-pointer text-xs text-primary underline"
                        onClick={() => setDetails(row.id)}
                      >
                        {t('consoleDetails')}
                      </button>
                    )}
                  </td>
                  <td className="p-3 text-xs">
                    <span
                      className={
                        !known
                          ? 'text-muted-foreground'
                          : item.updateAvailable
                            ? 'text-primary'
                            : 'text-emerald-700 dark:text-emerald-300'
                      }
                    >
                      {t(
                        !known
                          ? 'componentUpdatesUnknown'
                          : item.updateAvailable
                            ? 'componentUpdatesAvailable'
                            : 'componentUpdatesCurrent',
                      )}
                    </span>
                    {item?.migrationAvailable && (
                      <p>{t('componentUpdatesMigrate', { name: row.name })}</p>
                    )}
                  </td>
                  <td className="p-3">
                    {row.id === 'appCatalog' ? (
                      <span className="text-xs text-muted-foreground">
                        {t('byparrManagedUpdates')}
                      </span>
                    ) : row.id === 'manager' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDetails('manager')}
                      >
                        {t('consoleHostProcedure')}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t('globalUpdateManaged')}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="order-last flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-background pt-3">
        <p className="mr-auto text-xs text-muted-foreground">
          {t('globalUpdateHelp')}
        </p>
        {trailingActions}
        <Button
          disabled={blocked || !candidates.length || updates.isFetching}
          onClick={perform}
        >
          {t('globalUpdateAction')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('globalUpdateHelp')}</p>
      <Dialog
        open={details !== null}
        onOpenChange={(open) => {
          if (!open) setDetails(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {details === 'manager'
                ? t('consoleHostProcedure')
                : t('consoleDetails')}
            </DialogTitle>
            <DialogDescription>
              {details === 'manager'
                ? t('consoleManagerHostHelp')
                : t('componentUpdatesNotesHelp')}
            </DialogDescription>
          </DialogHeader>
          {details !== 'manager' && (
            <>
              <p className="break-all text-xs">
                {active?.targetImage} · {active?.targetDigest}
              </p>
              {details === 'application' &&
                release?.releases.map((note) => (
                  <section key={note.version} className="space-y-2 text-sm">
                    {note.sections.map((section) => (
                      <ul className="list-disc pl-5" key={section.heading}>
                        {section.items.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    ))}
                  </section>
                ))}
              {active?.notesUrl && (
                <a
                  href={active.notesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-primary underline"
                >
                  {t('componentUpdatesNotes')}
                </a>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
