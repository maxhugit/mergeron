import { Languages } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  platformSessionKey,
  updateAuthResource,
  usePlatformSession,
  type PlatformSession,
} from '@/lib/platform-session';
import type { SupportedLocale } from '@/locales';

export function ProfileLanguageSwitch() {
  const { t, i18n } = useTranslation();
  const session = usePlatformSession();
  const client = useQueryClient();
  const language = (i18n.resolvedLanguage ?? i18n.language).split('-')[0];
  const save = useMutation({
    mutationFn: async ({
      language,
      owner,
    }: {
      language: SupportedLocale;
      owner: string | undefined;
    }) => {
      if (owner) await updateAuthResource('preferences', { language });
      return { language, owner };
    },
    onSuccess: ({ language, owner }) =>
      client.setQueryData<PlatformSession>(platformSessionKey, (current) =>
        current && current.personId === owner
          ? { ...current, language }
          : current,
      ),
  });
  return (
    <section className="space-y-1" aria-label={t('language')}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2">
          <Languages className="size-4" aria-hidden="true" />
          {t('language')}
        </span>
        <div className="flex gap-1" role="group" aria-label={t('language')}>
          {(['fr', 'en'] as const).map((code) => (
            <Button
              key={code}
              size="sm"
              variant={language === code ? 'secondary' : 'ghost'}
              aria-pressed={language === code}
              aria-label={code === 'fr' ? 'Français' : 'English'}
              disabled={save.isPending || !!session.data?.impersonation}
              onClick={() => {
                void i18n.changeLanguage(code);
                save.mutate({
                  language: code,
                  owner:
                    session.data?.kind === 'person'
                      ? (session.data.personId ?? undefined)
                      : undefined,
                });
              }}
            >
              {code.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>
      {save.isError && (
        <p role="alert" className="text-xs text-destructive">
          {t('unableToSaveProfilePreferences')}
        </p>
      )}
    </section>
  );
}
