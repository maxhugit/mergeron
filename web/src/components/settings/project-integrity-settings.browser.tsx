import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { ProjectIntegritySettings } from './project-integrity-settings';
import { integrityRequest } from './project-integrity-api';
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
vi.mock('./project-integrity-api', () => ({ integrityRequest: vi.fn() }));
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});
for (const width of [320, 390, 1100])
  test(`shows project anomalies and a confirmation without overflow at ${width}px`, async () => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    const height = width < 600 ? 600 : 850;
    await page.viewport(width, height);
    document.documentElement.classList.add('dark');
    const root = '/workspaces/81f92635-f4b2-4b69-ba9c-cd8763336ad4';
    vi.mocked(integrityRequest).mockImplementation(async (p = '') =>
      p === ''
        ? { projects: [{ id: 'p', name: 'Projet exemple' }] }
        : {
            projectId: 'p',
            name: 'Projet exemple',
            root,
            inspectedAt: Date.now(),
            fingerprint: 'test',
            limited: false,
            counts: { documents: 10, versions: 23, copies: 6 },
            issues: [
              {
                id: 'missing',
                kind: 'directory-missing',
                path: root + '/dossiers/un-dossier-au-nom-long',
                severity: 'error',
                action: 'create-directory',
              },
              {
                id: 'document',
                kind: 'document-missing',
                path:
                  root +
                  '/.mergeron-system/livrables/0123456789/document-important.docx',
                severity: 'error',
                action: null,
              },
            ],
          },
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <div className="dark min-h-screen bg-background p-4 text-foreground">
          <ProjectIntegritySettings />
        </div>
      </QueryClientProvider>,
    );
    await screen.findByRole('option', { name: 'Projet exemple' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p' } });
    await screen.findByText('Un document enregistré est introuvable');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-integrity-${width}.png`,
    });
    await page
      .getByRole('button', { name: /^Corrections : Dossier attendu/ })
      .click();
    const dialog = await screen.findByRole('dialog');
    await expect.poll(() => getComputedStyle(dialog).opacity).toBe('1');
    expect(dialog.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    const engine = navigator.userAgent.includes('Chrome')
      ? 'chromium'
      : 'webkit';
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-integrity-corrections-${width}-${engine}.png`,
    });
    await page
      .getByRole('button', { name: 'Après correction', exact: true })
      .click();
    expect(
      screen.getByRole('img', { name: /Dossier créé — Dossier vide/ }),
    ).toBeVisible();
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-integrity-preview-${width}-${engine}.png`,
    });
    await page
      .getByRole('button', { name: 'Recréer ce dossier vide', exact: true })
      .click();
    await screen.findByRole('alertdialog');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await page
      .getByRole('button', { name: /^Corrections : Document référencé/ })
      .click();
    await screen.findByRole('dialog');
    await expect
      .poll(() => getComputedStyle(screen.getByRole('dialog')).opacity)
      .toBe('1');
    expect(
      await screen.findByText(/Aucune correction automatique n’est disponible/),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Appliquer la correction' }),
    ).toBeNull();
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-integrity-manual-${width}-${engine}.png`,
    });
    expect(
      vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
    ).toBe(false);
    client.clear();
  });
