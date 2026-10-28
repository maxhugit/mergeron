import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Link,
  ListTree,
  Search,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useTimelineStore } from '@/stores/timeline-store';
import { withBasePath } from '@/base-path';
import {
  articleFromHash,
  guideArticles,
  guideHash,
  guideLanguage,
  guideManuals,
  searchGuide,
} from '@/components/guide/guide-content';

export function HelpRoute() {
  const { i18n } = useTranslation();
  const { t } = useTranslation('guide');
  const language = guideLanguage(i18n.language);
  const chapters = guideManuals[language];
  const articles = useMemo(() => guideArticles(chapters), [chapters]);
  const [articleId, setArticleId] = useState(() =>
    articleFromHash(chapters, window.location.hash),
  );
  const [query, setQuery] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [expanded, setExpanded] = useState(
    () =>
      new Set([
        'start',
        articles.find(
          ({ article }) =>
            article.id === articleFromHash(chapters, window.location.hash),
        )?.chapter.id ?? 'start',
      ]),
  );
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>(
    'idle',
  );
  const panel = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selectedIndex = Math.max(
    0,
    articles.findIndex(({ article }) => article.id === articleId),
  );
  const { chapter, article } = articles[selectedIndex];
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => searchGuide(chapters, query),
    [chapters, query],
  );
  const selectThread = useTimelineStore((state) => state.selectThread);
  useEffect(() => {
    selectThread(null);
  }, [selectThread]);
  useEffect(() => {
    const update = () => {
      const id = articleFromHash(chapters, window.location.hash);
      setArticleId(id);
      setCopyStatus('idle');
      const parent = guideArticles(chapters).find(
        ({ article }) => article.id === id,
      )?.chapter.id;
      if (parent) setExpanded((previous) => new Set([...previous, parent]));
    };
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
    };
  }, [chapters]);
  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [article.id, chapter.id]);
  useEffect(() => {
    const container = navigation.current;
    const link = container?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!container || !link || !container.offsetHeight || !link.offsetHeight)
      return;
    const bounds = container.getBoundingClientRect();
    const selected = link.getBoundingClientRect();
    if (selected.bottom > bounds.bottom)
      container.scrollTop += selected.bottom - bounds.bottom + 8;
    else if (selected.top < bounds.top)
      container.scrollTop -= bounds.top - selected.top + 8;
  }, [article.id, searching, expanded, navigationOpen]);
  const navigate = (id: string) => {
    if (window.location.hash !== guideHash(id))
      window.history.pushState(window.history.state, '', guideHash(id));
    setArticleId(id);
    setCopyStatus('idle');
    const parent = articles.find(({ article }) => article.id === id)?.chapter
      .id;
    if (parent) setExpanded((previous) => new Set([...previous, parent]));
    setNavigationOpen(false);
    panel.current?.focus({ preventScroll: true });
  };
  const articleLink = (id: string, label: string, className?: string) => (
    <a
      href={guideHash(id)}
      onClick={(event) => {
        event.preventDefault();
        navigate(id);
      }}
      className={className}
    >
      {label}
    </a>
  );
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 space-y-3 border-b p-4">
        <div className="flex items-start gap-3">
          <BookOpen
            aria-hidden="true"
            className="mt-1 h-6 w-6 shrink-0 text-primary"
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold">{t('manualTitle')}</h1>
            <p className="text-sm text-muted-foreground">
              {t('manualIntroduction')}
            </p>
          </div>
          <button
            type="button"
            aria-expanded={navigationOpen}
            aria-controls="guide-navigation"
            onClick={() => setNavigationOpen((open) => !open)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-2 text-sm md:hidden"
          >
            <ListTree aria-hidden="true" className="h-4 w-4" />
            {t('manualContents')}
          </button>
        </div>
        <div role="search" className="relative max-w-2xl">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-muted-foreground"
          />
          <input
            ref={search}
            type="search"
            aria-label={t('manualSearch')}
            placeholder={t('manualSearch')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setNavigationOpen(true);
            }}
            className="h-10 w-full min-w-0 rounded-md border bg-background pr-10 pl-9 text-sm focus-visible:outline-2 focus-visible:outline-ring"
          />
          {query && (
            <button
              type="button"
              aria-label={t('manualClear')}
              onClick={() => {
                setQuery('');
                search.current?.focus();
              }}
              className="absolute top-1 right-1 rounded-md p-2 hover:bg-accent"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          )}
        </div>
        <p role="status" className="text-xs text-muted-foreground">
          {searching
            ? t('manualResults', { count: results.length })
            : t('manualArticles', { count: articles.length })}
        </p>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <aside
          ref={navigation}
          id="guide-navigation"
          className={cn(
            'min-h-0 shrink-0 flex-col overflow-y-auto border-b bg-muted/20 p-3 md:flex md:max-h-none md:w-72 md:border-r md:border-b-0',
            navigationOpen ? 'flex max-h-[45vh]' : 'hidden',
          )}
        >
          <nav aria-label={searching ? t('manualSearch') : t('manualContents')}>
            {searching ? (
              results.length ? (
                <ul className="space-y-2">
                  {results.map(
                    ({ article: result, chapter: parent, snippet }) => (
                      <li key={result.id}>
                        <a
                          href={guideHash(result.id)}
                          aria-current={
                            article.id === result.id ? 'page' : undefined
                          }
                          onClick={(event) => {
                            event.preventDefault();
                            navigate(result.id);
                          }}
                          className="block rounded-md border p-3 text-sm hover:bg-accent aria-[current=page]:border-primary"
                        >
                          <span className="text-xs text-muted-foreground">
                            {parent.title}
                          </span>
                          <span className="mt-1 block font-medium">
                            {result.title}
                          </span>
                          <span className="mt-1 block text-xs leading-relaxed break-words text-muted-foreground">
                            {snippet}
                          </span>
                        </a>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p className="p-2 text-sm text-muted-foreground">
                  {t('manualNoResults')}
                </p>
              )
            ) : (
              <ul className="space-y-1">
                {chapters.map((group) => (
                  <li key={group.id}>
                    <button
                      type="button"
                      aria-expanded={expanded.has(group.id)}
                      aria-controls={`guide-chapter-${group.id}`}
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        })
                      }
                      className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {expanded.has(group.id) ? (
                        <ChevronDown
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0"
                        />
                      ) : (
                        <ChevronRight
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0"
                        />
                      )}
                      <span className="min-w-0 flex-1">{group.title}</span>
                      <span
                        aria-hidden="true"
                        className="text-xs text-muted-foreground"
                      >
                        {group.articles.length}
                      </span>
                    </button>
                    <ul
                      id={`guide-chapter-${group.id}`}
                      hidden={!expanded.has(group.id)}
                      className="ml-4 space-y-1 border-l pl-2"
                    >
                      {group.articles.map((item) => (
                        <li key={item.id}>
                          <a
                            href={guideHash(item.id)}
                            aria-current={
                              article.id === item.id ? 'page' : undefined
                            }
                            onClick={(event) => {
                              event.preventDefault();
                              navigate(item.id);
                            }}
                            className="block rounded-md px-2 py-2 text-sm break-words hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-primary"
                          >
                            {item.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </nav>
        </aside>
        <article
          ref={panel}
          tabIndex={-1}
          aria-labelledby="guide-article-title"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 focus-visible:outline-2 focus-visible:outline-ring sm:p-6"
        >
          <div className="mx-auto w-full max-w-4xl space-y-6 pb-8">
            <nav
              aria-label={t('manualBreadcrumb')}
              className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
            >
              <span>{t('manualContents')}</span>
              <ChevronRight aria-hidden="true" className="h-3 w-3" />
              <span>{chapter.title}</span>
            </nav>
            <header className="space-y-3 border-b pb-5">
              <div className="flex items-start gap-3">
                <h2
                  id="guide-article-title"
                  className="min-w-0 flex-1 text-2xl font-semibold tracking-tight"
                >
                  {article.title}
                </h2>
                <button
                  type="button"
                  title={t('manualCopyLink')}
                  aria-label={t('manualCopyLink')}
                  className="shrink-0 rounded-md border p-2 hover:bg-accent"
                  onClick={() => {
                    const url = new URL(window.location.href);
                    url.hash = guideHash(article.id);
                    void Promise.resolve()
                      .then(() => navigator.clipboard.writeText(url.href))
                      .then(() => setCopyStatus('success'))
                      .catch(() => setCopyStatus('error'));
                  }}
                >
                  <Link aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
              {copyStatus !== 'idle' && (
                <p role="status" className="text-sm">
                  {t(
                    copyStatus === 'success'
                      ? 'manualLinkCopied'
                      : 'manualLinkFailed',
                  )}
                </p>
              )}
              <p className="leading-relaxed text-muted-foreground">
                {article.summary}
              </p>
              <nav aria-label={t('manualOnThisPage')}>
                <p className="mb-2 text-sm font-medium">
                  {t('manualOnThisPage')}
                </p>
                <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                  {article.sections.map((section, index) => (
                    <li key={section.title}>
                      <button
                        type="button"
                        className="text-primary underline-offset-4 hover:underline"
                        onClick={() =>
                          document
                            .getElementById(
                              `guide-section-${article.id}-${index}`,
                            )
                            ?.scrollIntoView({ block: 'start' })
                        }
                      >
                        {section.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            </header>
            {article.sections.map((section, index) => (
              <section
                key={section.title}
                id={`guide-section-${article.id}-${index}`}
                aria-labelledby={`guide-heading-${article.id}-${index}`}
                className="scroll-mt-4 space-y-3"
              >
                <h3
                  id={`guide-heading-${article.id}-${index}`}
                  className="text-lg font-semibold"
                >
                  {section.title}
                </h3>
                {section.paragraphs?.map((paragraph) => (
                  <p key={paragraph} className="text-sm leading-7">
                    {paragraph}
                  </p>
                ))}
                {section.steps && (
                  <ol className="list-decimal space-y-3 pl-6 text-sm leading-7">
                    {section.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                )}
                {section.actions && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b">
                        <tr>
                          <th scope="col" className="py-2 pr-4">
                            {t('button')}
                          </th>
                          <th scope="col" className="py-2">
                            {t('effect')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.actions.map((action) => (
                          <tr key={action.label} className="border-b">
                            <th
                              scope="row"
                              className="w-1/3 py-3 pr-4 align-top font-medium"
                            >
                              {action.label}
                            </th>
                            <td className="py-3 leading-7">{action.effect}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {section.warning && (
                  <aside className="space-y-1 rounded-r-md border-l-2 border-primary bg-muted/40 p-4">
                    <h4 className="text-sm font-semibold">
                      {t('manualCaution')}
                    </h4>
                    <p className="text-sm leading-7">{section.warning}</p>
                  </aside>
                )}
              </section>
            ))}
            {['tasks', 'deliverables'].includes(article.screenshot ?? '') && (
              <figure className="space-y-3 rounded-lg border p-3">
                <img
                  loading="lazy"
                  className="h-auto w-full rounded-md"
                  src={withBasePath(
                    `/guide/${article.screenshot}-${language}.png`,
                  )}
                  alt={t(
                    article.screenshot === 'tasks'
                      ? 'tasksCaption'
                      : 'lifecycleCaption',
                  )}
                />
                <figcaption className="text-xs leading-relaxed text-muted-foreground">
                  {t('captureNotice')}
                </figcaption>
              </figure>
            )}
            {article.related && (
              <nav
                aria-label={t('manualRelated')}
                className="space-y-2 border-t pt-4"
              >
                <h3 className="font-semibold">{t('manualRelated')}</h3>
                <ul className="list-disc space-y-2 pl-5 text-sm">
                  {article.related.map((id) => {
                    const item = articles.find(
                      ({ article: candidate }) => candidate.id === id,
                    );
                    return item ? (
                      <li key={id}>
                        {articleLink(
                          id,
                          item.article.title,
                          'text-primary hover:underline',
                        )}
                      </li>
                    ) : null;
                  })}
                </ul>
              </nav>
            )}
            <nav
              aria-label={t('manualContents')}
              className="grid gap-3 border-t pt-4 text-sm sm:grid-cols-2"
            >
              <div>
                {selectedIndex > 0 && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {t('manualPrevious')}
                    </p>
                    {articleLink(
                      articles[selectedIndex - 1].article.id,
                      articles[selectedIndex - 1].article.title,
                      'text-primary hover:underline',
                    )}
                  </>
                )}
              </div>
              <div className="sm:text-right">
                {selectedIndex < articles.length - 1 && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {t('manualNext')}
                    </p>
                    {articleLink(
                      articles[selectedIndex + 1].article.id,
                      articles[selectedIndex + 1].article.title,
                      'text-primary hover:underline',
                    )}
                  </>
                )}
              </div>
            </nav>
          </div>
        </article>
      </div>
    </main>
  );
}
