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
afterEach(cleanup);
for (const width of [390, 1100])
  test(`shows project anomalies and a confirmation without overflow at ${width}px`, async () => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 850);
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
    await screen.findByText('Document référencé absent ou invalide');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-integrity-${width}.png`,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Recréer ce dossier vide' }),
    );
    await screen.findByRole('alertdialog');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(
      vi.mocked(integrityRequest).mock.calls.some(([, body]) => !!body),
    ).toBe(false);
    client.clear();
  });
