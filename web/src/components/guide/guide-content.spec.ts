import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  articleFromHash,
  guideArticles,
  guideLanguage,
  guideManuals,
  guideExternalUrl,
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
        for (const section of article.sections)
          for (const link of section.links ?? []) {
            expect(link.label.trim()).not.toBe('');
            expect(guideExternalUrl(link.destination)).toBeDefined();
          }
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
  it('opens the existing GitHub forms without prefilling private Mergeron context', () => {
    for (const [destination, template] of [
      ['bug', 'bug_report.yml'],
      ['improvement', 'feature_request.yml'],
    ]) {
      const url = new URL(guideExternalUrl(destination)!);
      expect(url.origin).toBe('https://github.com');
      expect(url.pathname).toBe('/maxhugit/mergeron/issues/new');
      expect([...url.searchParams]).toEqual([['template', template]]);
      expect(
        existsSync(
          resolve(
            dirname(fileURLToPath(import.meta.url)),
            '../../../../.github/ISSUE_TEMPLATE',
            template,
          ),
        ),
      ).toBe(true);
    }
    expect(guideExternalUrl('https://unrelated.example')).toBeUndefined();
    expect(guideExternalUrl('__proto__')).toBeUndefined();
  });
  it('makes the contribution paths and managed preview discoverable in both languages', () => {
    expect(searchGuide(guideManuals.fr, 'signaler bug')[0].article.id).toBe(
      'report-bug',
    );
    expect(
      searchGuide(guideManuals.en, 'request improvement')[0].article.id,
    ).toBe('request-improvement');
    expect(
      searchGuide(guideManuals.fr, 'stockage URL').some(
        ({ article }) => article.id === 'agent-preview',
      ),
    ).toBe(true);
    for (const chapters of Object.values(guideManuals)) {
      const overview = chapters[0].articles[0];
      expect(overview.id).toBe('overview');
      expect(
        overview.sections.some((section) =>
          section.links?.some((link) => link.destination === 'project'),
        ),
      ).toBe(true);
      expect(overview.related).toEqual(
        expect.arrayContaining(['report-bug', 'request-improvement']),
      );
    }
  });
});
