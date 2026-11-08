/** Real optional-mode UI; all repository responses are synthetic. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { catalogFixture, json } from '../settings/catalog/catalog.testing';
import { GitDeliverablesSettings } from './git-deliverables-settings';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test.each([
  { width: 390, context: false },
  { width: 1280, context: false },
  { width: 390, context: true },
  { width: 1280, context: true },
])(
  'reviews Git deliverables in French at $width px (copy context: $context)',
  async ({ width, context }) => {
    const fixture = catalogFixture();
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 1000);
    const writes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          writes.push(url);
          return Promise.resolve(
            json({
              fingerprint: 'preview',
              canApply: false,
              context: {
                branch: 'refs/heads/agent-presentation',
                head: '1234567890abcdef',
              },
              changes: [
                {
                  deliverable: 'Cadrage du projet et décisions partagées',
                  document: 'compte-rendu-de-la-réunion.md',
                  action: 'conflict',
                  reason: 'document_changed_both',
                },
                {
                  deliverable: 'Budget confidentiel',
                  action: 'excluded',
                  reason: 'restricted',
                },
              ],
            }),
          );
        }
        return Promise.resolve(
          json({
            boards: [
              {
                id: 'board',
                name: 'Gestion des livrables',
                restricted: [{ id: 'private', title: 'Budget confidentiel' }],
                settings: null,
              },
            ],
            copies: [
              {
                id: 'copy',
                name: 'Copie Git de l’agent',
                writable: true,
                owned: true,
                eligible: true,
                context: {
                  branch: 'refs/heads/agent-presentation',
                  head: '1234567890abcdef',
                },
                pending: true,
                lastError: 'GIT_DELIVERABLES_REVIEW_REQUIRED',
                lastSyncAt: null,
              },
            ],
            discovered: [],
            discoveryError: null,
          }),
        );
      }),
    );
    fixture.render(
      <main className="min-h-dvh bg-background p-4 text-foreground">
        <GitDeliverablesSettings
          projectId="p"
          preferredCopyId={context ? 'copy' : undefined}
        />
      </main>,
    );
    try {
      const user = userEvent.setup();
      await user.click(await screen.findByRole('switch'));
      expect(screen.queryByRole('combobox')).toBeNull();
      if (context) {
        await user.click(
          screen.getByRole('button', { name: 'Prévisualiser les changements' }),
        );
        expect(
          await screen.findByRole('button', {
            name: 'Confirmer et synchroniser',
          }),
        ).toBeDisabled();
      } else {
        await user.click(
          screen.getByRole('button', {
            name: 'Enregistrer le mode Livrables Git',
          }),
        );
        expect(await screen.findByRole('status')).toBeVisible();
        expect(writes[0]).toContain('/configure');
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      expect(writes).toHaveLength(1);
      await page.screenshot({
        path: `../../../.vitest-screenshots/git-deliverables-${context ? 'copy' : 'project'}-${width}.png`,
      });
    } finally {
      fixture.dispose();
    }
  },
);
