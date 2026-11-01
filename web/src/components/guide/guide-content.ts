import french from './manual.fr.json';
import english from './manual.en.json';

// Fixed destinations: opening help never sends a project URL, account, log or
// conversation to GitHub. Localized content only chooses one of these targets.
const guideDestinations = {
  project: 'https://github.com/maxhugit/mergeron',
  issues: 'https://github.com/maxhugit/mergeron/issues',
  bug: 'https://github.com/maxhugit/mergeron/issues/new?template=bug_report.yml',
  improvement:
    'https://github.com/maxhugit/mergeron/issues/new?template=feature_request.yml',
  security: 'https://github.com/maxhugit/mergeron/security/advisories/new',
} as const;

export function guideExternalUrl(destination: string): string | undefined {
  return Object.hasOwn(guideDestinations, destination)
    ? guideDestinations[destination as keyof typeof guideDestinations]
    : undefined;
}

export interface GuideSection {
  title: string;
  paragraphs?: string[];
  steps?: string[];
  actions?: { label: string; effect: string }[];
  links?: { destination: string; label: string; description?: string }[];
  warning?: string;
}
export interface GuideArticle {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  sections: GuideSection[];
  related?: string[];
  screenshot?: string;
}
export interface GuideChapter {
  id: string;
  title: string;
  articles: GuideArticle[];
}
export const guideManuals: Record<'fr' | 'en', GuideChapter[]> = {
  fr: french,
  en: english,
};
export function guideLanguage(language: string): 'fr' | 'en' {
  return language.startsWith('fr') ? 'fr' : 'en';
}
export function normalizeGuideText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
export function guideArticles(chapters: GuideChapter[]) {
  return chapters.flatMap((chapter) =>
    chapter.articles.map((article) => ({ chapter, article })),
  );
}
export function searchGuide(chapters: GuideChapter[], query: string) {
  const terms = normalizeGuideText(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return guideArticles(chapters)
    .map(({ chapter, article }) => {
      const title = normalizeGuideText(article.title);
      const summary = normalizeGuideText(article.summary);
      const keywords = normalizeGuideText(article.keywords.join(' '));
      const sections = article.sections.map((section) =>
        [
          section.title,
          ...(section.paragraphs ?? []),
          ...(section.steps ?? []),
          ...(section.actions ?? []).flatMap((action) => [
            action.label,
            action.effect,
          ]),
          ...(section.links ?? []).flatMap((link) => [
            link.label,
            link.description ?? '',
          ]),
          section.warning ?? '',
        ].join(' '),
      );
      const full = normalizeGuideText(
        [
          chapter.title,
          article.title,
          article.summary,
          keywords,
          ...sections,
        ].join(' '),
      );
      if (!terms.every((term) => full.includes(term))) return null;
      const score = terms.reduce(
        (sum, term) =>
          sum +
          (title.includes(term) ? 10 : 0) +
          (summary.includes(term) ? 5 : 0) +
          (keywords.includes(term) ? 3 : 0),
        0,
      );
      const excerpt =
        sections.find((section) =>
          terms.some((term) => normalizeGuideText(section).includes(term)),
        ) ?? article.summary;
      const index = normalizeGuideText(excerpt).indexOf(terms[0]);
      const start = Math.max(0, index - 60);
      const snippet = `${start ? '…' : ''}${excerpt.slice(start, start + 200)}${excerpt.length > start + 200 ? '…' : ''}`;
      return { chapter, article, score, snippet };
    })
    .filter((result) => result !== null)
    .sort((a, b) => b.score - a.score);
}
export function guideHash(id: string) {
  return `#guide/${encodeURIComponent(id)}`;
}
export function articleFromHash(
  chapters: GuideChapter[],
  hash: string,
): string {
  let id = '';
  try {
    id = decodeURIComponent(hash.replace(/^#guide\//, ''));
  } catch {
    /* Invalid links return to the introduction. */
  }
  return guideArticles(chapters).some(({ article }) => article.id === id)
    ? id
    : chapters[0].articles[0].id;
}
