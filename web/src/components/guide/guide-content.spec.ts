import { describe, expect, it } from 'vitest';
import {
  articleFromHash,
  guideArticles,
  guideLanguage,
  guideManuals,
  searchGuide,
} from './guide-content';
describe('guide content integrity', () => {
  it('has matching stable chapter and article IDs in both languages', () => {
    expect(guideManuals.fr.map((c) => c.id)).toEqual(
      guideManuals.en.map((c) => c.id),
    );
    expect(
      guideArticles(guideManuals.fr).map(({ article }) => article.id),
    ).toEqual(guideArticles(guideManuals.en).map(({ article }) => article.id));
  });
  for (const language of ['fr', 'en'] as const)
    it(`validates every ${language} article and related link`, () => {
      const chapters = guideManuals[language];
      const articles = guideArticles(chapters);
      const ids = articles.map(({ article }) => article.id);
      expect(ids.length).toBeGreaterThanOrEqual(40);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(chapters.map((c) => c.id)).size).toBe(chapters.length);
      for (const { article } of articles) {
        expect(article.title.length).toBeGreaterThan(10);
        expect(article.summary.length).toBeGreaterThan(20);
        expect(article.sections.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(article).length).toBeGreaterThan(700);
        expect(article.sections.some((s) => s.warning)).toBe(true);
        for (const id of article.related ?? []) expect(ids).toContain(id);
        if (article.screenshot)
          expect(['tasks', 'deliverables']).toContain(article.screenshot);
      }
    });
  it('matches body text, ignores accents and requires all query terms', () => {
    expect(searchGuide(guideManuals.fr, 'retention')).toEqual(
      searchGuide(guideManuals.fr, 'RÉTENTION'),
    );
    expect(
      searchGuide(guideManuals.fr, 'pondérée').map((r) => r.article.id),
    ).toContain('task-board');
    expect(searchGuide(guideManuals.fr, 'snapshot impossible')).toHaveLength(0);
    expect(
      searchGuide(guideManuals.en, 'passkey').map((r) => r.article.id),
    ).toContain('browser-live');
    expect(searchGuide(guideManuals.fr, '   ')).toHaveLength(0);
  });
  it('ranks direct title matches first and uses safe language and hash fallbacks', () => {
    expect(searchGuide(guideManuals.fr, 'OnlyOffice')[0].article.id).toBe(
      'onlyoffice',
    );
    expect(guideLanguage('fr-FR')).toBe('fr');
    expect(guideLanguage('de')).toBe('en');
    expect(articleFromHash(guideManuals.en, '#guide/not-existing')).toBe(
      'overview',
    );
  });
});
