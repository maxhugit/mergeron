import { ExternalLink, Tag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { guideLanguage, guideReleaseUrl, guideVersions } from './guide-content';

/** Bundled editorial history: viewing help never sends installation data to GitHub. */
export function VersionTimeline() {
  const { t, i18n } = useTranslation('guide');
  const language = guideLanguage(i18n.language);
  return (
    <ol
      aria-label={t('versionTimeline')}
      className="ml-2 border-l-2 border-primary/30 pl-6"
    >
      {guideVersions.map((version) => (
        <li key={version.tag} className="relative min-w-0 pb-8 last:pb-0">
          <span
            aria-hidden="true"
            className="absolute -left-[35px] top-1 flex size-4 items-center justify-center rounded-full border-2 border-primary bg-background"
          />
          <div className="min-w-0 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h4 className="flex items-center gap-2 text-lg font-semibold">
                <Tag
                  aria-hidden="true"
                  className="size-4 shrink-0 text-primary"
                />
                {version.tag}
              </h4>
              <time
                dateTime={version.date}
                className="text-sm text-muted-foreground"
              >
                {new Intl.DateTimeFormat(language, {
                  dateStyle: 'long',
                  timeZone: 'UTC',
                }).format(new Date(version.date + 'T00:00:00Z'))}
              </time>
            </div>
            <ul className="my-3 list-disc space-y-2 pl-5 text-sm leading-6">
              {version.highlights[language].map((highlight) => (
                <li key={highlight} className="break-words">
                  {highlight}
                </li>
              ))}
            </ul>
            <a
              href={guideReleaseUrl(version.tag)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-2 rounded text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span>{t('versionReleaseNotes', { tag: version.tag })}</span>
              <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
              <span className="sr-only">{t('manualExternalLink')}</span>
            </a>
          </div>
        </li>
      ))}
    </ol>
  );
}
