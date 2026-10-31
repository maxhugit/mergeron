import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export function InstalledImageChanges({
  revision,
  enabled,
}: {
  revision: string | null;
  enabled: boolean;
}) {
  const { t } = useTranslation('manager');
  const valid = Boolean(revision && /^[a-f0-9]{40}$/.test(revision));
  const query = useQuery({
    queryKey: ['administration', 'installed-image-changes', revision],
    enabled: enabled && valid,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const authorization = getAuthorizationHeader();
      const response = await fetch(
        withBasePath('/api/settings/release/installed-changes'),
        {
          headers: authorization ? { Authorization: authorization } : {},
        },
      );
      if (!response.ok) throw new Error('installedChangesUnavailable');
      const data = (await response.json()) as {
        revision: string;
        items: string[];
        checkError: string | null;
      };
      if (
        data.revision !== revision ||
        data.checkError ||
        !Array.isArray(data.items)
      )
        throw new Error('installedChangesUnavailable');
      return data;
    },
  });
  if (!valid) return null;
  return (
    <section
      className="space-y-2 border-t border-border pt-4"
      aria-label={t('installedImprovementsTitle')}
    >
      <h3 className="text-sm font-semibold">
        {t('installedImprovementsTitle')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t('installedImprovementsDescription')}
      </p>
      {query.isError && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('installedChangesUnavailable')}
        </p>
      )}
      {query.data?.items.map((item, index) => (
        <p key={index} className="text-sm">
          {item}
        </p>
      ))}
      <a
        href={`https://github.com/maxhugit/mergeron/commit/${revision}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex text-sm text-primary underline"
      >
        {t('installedImprovementsLink')}
      </a>
    </section>
  );
}
