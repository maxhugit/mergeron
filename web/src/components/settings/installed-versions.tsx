import { useTranslation } from 'react-i18next';
import type { InstalledBuild, ManagerStatus } from './manager-status-api';

export function InstalledVersions({
  application,
  status,
}: {
  application: InstalledBuild;
  status?: ManagerStatus;
}) {
  const { t, i18n } = useTranslation('manager');
  const components = status?.available ? status.components : [];
  const rows = [
    {
      id: 'application',
      name: t('versionApplication'),
      build: application,
      imageId: components.find((item) => item.id === 'application')?.imageId,
    },
    {
      id: 'manager',
      name: 'Manager',
      build: status?.available ? status.manager?.build : null,
      imageId: status?.available ? status.manager?.imageId : null,
    },
    {
      id: 'browser',
      name: t('versionBrowser'),
      build: components.find((item) => item.id === 'browser')?.build,
      imageId: components.find((item) => item.id === 'browser')?.imageId,
    },
    ...components
      .filter((item) => ['ingress', 'egress'].includes(item.id))
      .map((item) => ({
        id: item.id,
        name: item.displayName,
        build: item.build,
        imageId: item.imageId,
      })),
  ];
  const unknown = t('versionUnknown');
  const date = (value?: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(i18n.language)
      : unknown;
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t('versionsInstalledTitle')}</h3>
      <p className="text-xs text-muted-foreground">
        {t('versionsInstalledHelp')}
      </p>
      <p className="text-xs text-muted-foreground sm:hidden">
        {t('versionsScrollHint')}
      </p>
      <div
        tabIndex={0}
        role="region"
        aria-label={t('versionsInstalledTitle')}
        className="max-w-full overflow-x-auto rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-ring"
      >
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="p-3">
                {t('versionComponent')}
              </th>
              <th scope="col" className="p-3">
                {t('versionInstalled')}
              </th>
              <th scope="col" className="p-3">
                {t('versionBuildChannel')}
              </th>
              <th scope="col" className="p-3">
                {t('versionRevision')}
              </th>
              <th scope="col" className="p-3">
                {t('versionBuiltAt')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <th scope="row" className="p-3 font-medium">
                  {row.name}
                </th>
                <td className="p-3">
                  {row.build?.version &&
                  /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(
                    row.build.version,
                  )
                    ? row.build.version
                    : unknown}
                  {row.imageId && /^sha256:[a-f0-9]{64}$/.test(row.imageId) && (
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
                <td className="p-3">
                  {row.build?.channel === 'edge'
                    ? t('versionEdge')
                    : row.build?.channel === 'stable'
                      ? t('versionStable')
                      : unknown}
                </td>
                <td className="p-3 font-mono text-xs">
                  {row.build?.revision &&
                  /^[a-f0-9]{40}$/.test(row.build.revision) ? (
                    ['application', 'manager', 'browser'].includes(row.id) ? (
                      <a
                        className="text-primary underline"
                        title={row.build.revision}
                        href={`https://github.com/maxhugit/mergeron/commit/${row.build.revision}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {row.build.revision.slice(0, 7)}
                      </a>
                    ) : (
                      <span title={row.build.revision}>
                        {row.build.revision.slice(0, 7)}
                      </span>
                    )
                  ) : (
                    unknown
                  )}
                </td>
                <td className="p-3 text-xs">{date(row.build?.builtAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('versionsIndependentHelp')}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('versionsManagerHostHelp')}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('versionsObservedAt', { date: date(status?.observedAt) })}
      </p>
    </section>
  );
}
