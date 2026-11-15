import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { GitCommitDelivery } from './git-commit-delivery';
import type { GitCommitDeliveryDto } from '@/generated/api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const read = vi.hoisted(() => vi.fn());
vi.mock('@/generated/api', () => ({ workspaceGitCommitDelivery1: read }));
afterEach(() => {
  cleanup();
  read.mockReset();
});
const revision = 'a'.repeat(40);
function fixture(index: number): GitCommitDeliveryDto {
  return {
    revision,
    repository: 'example/demo',
    commitUrl: `https://github.com/example/demo/commit/${revision}`,
    inspectedAt: 1700000000000,
    image: { state: 'unverified', reason: 'registry_receipt_required' },
    deployment: { state: 'unverified', reason: 'runtime_receipt_required' },
    actions: {
      total: 51,
      limited: true,
      nextPage: index === 1 ? 2 : null,
      inspectedAt: 1700000000000,
      items: [
        {
          id: index,
          name: `Publication ${index}`,
          title: 'Deploy',
          event: 'push',
          branch: 'main',
          revision,
          attempt: 2,
          status: 'completed',
          conclusion: 'success',
          createdAt: null,
          updatedAt: null,
          url: `https://github.com/example/demo/actions/runs/${index}`,
        },
      ],
    },
  };
}
test.each([390, 1180])(
  'shows independent delivery evidence and commit-bound pages at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 900);
    read.mockImplementation(async ({ path, query }) => {
      expect(path.revision).toBe(revision);
      return { data: fixture(query.page) };
    });
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <div style={{ width: '100%', padding: 12 }}>
          <GitCommitDelivery projectId="p" resourceId="c" revision={revision} />
        </div>
      </QueryClientProvider>,
    );
    try {
      expect(read).not.toHaveBeenCalled();
      await page.getByText('Livraison de ce commit', { exact: true }).click();
      await screen.findByText('Publication 1');
      await screen.findByText(/Publication d’image : non vérifiée/);
      await screen.findByText(/Déploiement : non vérifié/);
      await page
        .getByRole('button', { name: 'Page suivante', exact: true })
        .click();
      await screen.findByText('Publication 2');
      expect(screen.queryByText('Publication 1')).toBeNull();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/commit-delivery-${width}.png`,
      });
      await page
        .getByRole('button', { name: 'Page précédente', exact: true })
        .click();
      await screen.findByText('Publication 1');
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
test('rejects cached evidence from a different commit and offers a retry', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  read.mockResolvedValue({ data: { ...fixture(1), revision: 'b'.repeat(40) } });
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <GitCommitDelivery projectId="p" resourceId="c" revision={revision} />
    </QueryClientProvider>,
  );
  try {
    await page.getByText('Livraison de ce commit', { exact: true }).click();
    await screen.findByRole('alert');
    expect(screen.queryByText('Publication 1')).toBeNull();
    read.mockResolvedValue({ data: fixture(1) });
    await page.getByRole('button', { name: 'Actualiser les preuves' }).click();
    await screen.findByText('Publication 1');
  } finally {
    view.unmount();
    client.clear();
  }
});

test.each([390, 1180])(
  'shows registry and healthy Manager proof separately at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 900);
    const data = fixture(1);
    data.repository = 'maxhugit/mergeron';
    data.commitUrl = `https://github.com/maxhugit/mergeron/commit/${revision}`;
    const reference = 'ghcr.io/maxhugit/mergeron@sha256:' + 'c'.repeat(64);
    data.image = {
      state: 'verified',
      reason: 'verified_registry',
      reference,
      revision,
      checkedAt: 1700000000000,
    };
    data.deployment = {
      state: 'verified',
      reason: 'verified_manager',
      reference,
      revision,
      environment: 'development',
      checkedAt: 1700000000000,
    };
    read.mockResolvedValue({ data });
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <div style={{ width: '100%', padding: 12 }}>
          <GitCommitDelivery projectId="p" resourceId="c" revision={revision} />
        </div>
      </QueryClientProvider>,
    );
    try {
      await page.getByText('Livraison de ce commit', { exact: true }).click();
      await screen.findByText(/Image publiée vérifiée dans le registre/);
      await screen.findByText(
        /Déploiement sain vérifié par le Manager \(DEV\)/,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/manager-delivery-${width}.png`,
      });
      data.deployment = {
        state: 'unverified',
        reason: 'different_commit',
        observedRevision: 'd'.repeat(40),
        environment: 'development',
        checkedAt: 1700000000000,
      };
      read.mockResolvedValue({ data: { ...data } });
      await page
        .getByRole('button', { name: 'Actualiser les preuves' })
        .click();
      await screen.findByText(/Le Manager observe une autre révision/);
      await screen.findByText(/Révision observée par le Manager/);
      expect(screen.queryByText(/Déploiement sain vérifié/)).toBeNull();
      await screen.findByText(/Image publiée vérifiée/);
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
