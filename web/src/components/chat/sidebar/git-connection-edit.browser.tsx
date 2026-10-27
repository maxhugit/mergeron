import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { GitConnectionEdit } from './git-connection-edit';
import type { ProjectWorkspaceResourceSummary } from '@/lib/projects-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
afterEach(() => {
  cleanup();
  api.mockReset();
});
test.each([390, 1100])(
  'keeps the Git connection editor usable at %ipx without exposing credentials',
  async (width) => {
    await page.viewport(width, 800);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const client = new QueryClient();
    const resource = {
      id: 'git',
      name: 'Git Test',
      type: 'git',
      address: 'https://github.com/example/test.git',
      hasSecret: true,
    } as ProjectWorkspaceResourceSummary;
    const view = render(
      <QueryClientProvider client={client}>
        <GitConnectionEdit
          projectId="p"
          resource={resource}
          onSaved={async () => {}}
        />
      </QueryClientProvider>,
    );
    try {
      await page.getByRole('button', { name: 'Modifier', exact: true }).click();
      const dialog = screen.getByRole('dialog');
      expect(
        screen.getByLabelText('Nouveau jeton d’accès', { exact: true }),
      ).toHaveValue('');
      expect(
        screen.getByLabelText('Nouveau jeton d’accès', { exact: true }),
      ).toHaveAttribute('type', 'password');
      expect(
        screen.getByText(
          'Des identifiants sont déjà enregistrés. Ils ne sont jamais affichés.',
        ),
      ).toBeVisible();
      expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../../.vitest-screenshots/git-connection-edit-${width}.png`,
      });
      await page.getByRole('button', { name: 'Annuler', exact: true }).click();
      await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
      expect(api).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
