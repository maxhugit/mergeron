import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import i18n from '@/i18n';
import type { IntegrityIssue } from './project-integrity-api';
import {
  IntegrityDiagram,
  IntegrityExplanation,
  IntegrityIssueTitle,
} from './project-integrity-diagram';
import fr from '@/locales/fr/integrity.json';

afterEach(cleanup);
const issue = (
  kind: string,
  action: IntegrityIssue['action'] = null,
): IntegrityIssue => ({
  id: 'test',
  kind,
  path: '/workspaces/p',
  severity: 'error',
  action,
});
// Cover every server-facing kind, including limits and security checks, in both locales.
const kinds = [
  'outside-project',
  'symbolic-link',
  'path-collision',
  'project-root-missing',
  'project-location-mismatch',
  'migration-required',
  'project-identity-mismatch',
  'directory-missing',
  'document-missing',
  'current-version-missing',
  'snapshot-missing',
  'document-location-mismatch',
  'snapshot-location-mismatch',
  'copy-registration-missing',
  'copy-location-mismatch',
  'copy-missing',
  'git-metadata-missing',
  'agent-reference-obsolete',
  'agent-override-obsolete',
  'agent-reference-missing',
  'unregistered-document',
  'unregistered-deliverable-directory',
  'unregistered-copy',
  'scan-limited',
  'transfer-running',
  'primary-location-mismatch',
  'active-folder-registration-missing',
  'active-folder-outside-workspace',
  'active-folder-missing',
];
it.each(['fr', 'en'])(
  'explains every diagnostic kind with translated text and an accessible diagram in %s',
  async (language) => {
    await i18n.changeLanguage(language);
    expect(kinds).toHaveLength(Object.keys(fr.kind).length);
    for (const kind of kinds) {
      const { unmount } = render(
        <>
          <IntegrityIssueTitle kind={kind} />
          <IntegrityDiagram issue={issue(kind)} />
          <IntegrityExplanation kind={kind} />
        </>,
      );
      expect(screen.getByRole('img').getAttribute('aria-label')).not.toMatch(
        /visual\.|undefined|État à vérifier|State to check/,
      );
      expect(document.body.textContent).not.toMatch(/visual\.|undefined/);
      expect(document.body.textContent).not.toContain(
        language === 'fr' ? 'Anomalie à vérifier' : 'Issue to inspect',
      );
      unmount();
    }
  },
);
it('keeps an unknown diagnostic readable without fabricating a repair', async () => {
  await i18n.changeLanguage('fr');
  render(
    <>
      <IntegrityIssueTitle kind="future-kind" />
      <IntegrityDiagram issue={issue('future-kind')} preview />
      <IntegrityExplanation kind="future-kind" />
    </>,
  );
  expect(screen.getByRole('img')).toHaveAccessibleName(
    'Élément du projet — À examiner — État à vérifier',
  );
  expect(screen.getByText('Anomalie à vérifier')).toBeVisible();
  expect(screen.queryByText('Lien rétabli')).toBeNull();
});
it.each([
  'create-directory',
  'realign-agent',
  'realign-override',
  'select-project-folder',
] as const)(
  'only previews the effect of the declared %s action',
  async (action) => {
    await i18n.changeLanguage('fr');
    render(
      <IntegrityDiagram issue={issue('directory-missing', action)} preview />,
    );
    expect(screen.getByRole('img')).toHaveAccessibleName(
      action === 'create-directory'
        ? /Dossier créé — Dossier vide/
        : /Lien rétabli — Référence rétablie/,
    );
  },
);
