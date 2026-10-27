/** Complete human-driven workflow with an in-memory fake server only. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { WorkspaceGitPanel } from './workspace-git-panel';
import { locationInventoryFixture } from '@/test/project-locations-fixture';
import type { GitInventory } from '@/lib/workspace-git-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const server = vi.hoisted(() => ({
  prepared: false,
  committed: false,
  posts: [] as Array<{ url: string; body: Record<string, unknown> }>,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: {
      kind: 'person',
      personId: 'person',
      name: 'Utilisateur Test',
      email: 'test@example.invalid',
      active: true,
    },
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock('@/lib/projects-api', () => ({
  projectsQueryKey: ['projects'],
  projectsApi: async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST')
      server.posts.push({
        url,
        body: JSON.parse(options.body as string) as Record<string, unknown>,
      });
    if (url.endsWith('/locations'))
      return locationInventoryFixture({
        resources: [
          {
            id: 'git',
            projectId: 'p',
            name: 'Git Test',
            type: 'git',
            address: 'https://github.com/example/test.git',
            rootPath: '/',
            accessMode: 'read_write',
            enabled: true,
            connectionState: 'connected',
            capabilities: { read: true, write: true, execute: false },
          },
        ],
        copies: [
          {
            id: 'copy',
            projectId: 'p',
            sourceResourceId: 'git',
            localWorkspaceId: 'copy',
            name: 'Git Test — Analyse fonctionnelle',
            branch: 'main',
            revision: 'a'.repeat(40),
            state: 'ready',
            localPath: '/copy',
            accessMode: 'read_write',
            sourceEnabled: true,
            ownerAgentIds: ['agent'],
            ownerThreadIds: ['agent'],
          },
        ],
      } as GitInventory);
    if (url.endsWith('/copies/copy'))
      return {
        fingerprint: server.committed
          ? 'committed'
          : server.prepared
            ? 'prepared'
            : 'index',
        branch: 'main',
        head: (server.committed ? 'e' : 'a').repeat(40),
        changes: server.committed
          ? []
          : [{ path: 'coucou.js', status: server.prepared ? 'M ' : ' M' }],
        branches: [],
        branchesLimited: false,
        ahead: server.committed ? 1 : 0,
        behind: 0,
        upstream: 'origin/main',
        inspectedAt: 1,
      };
    if (url.endsWith('/stage-review'))
      return {
        reviewFingerprint: 'reviewed',
        files: [
          {
            path: 'coucou.js',
            text: "console.log('modification');\n",
            binary: false,
            deleted: false,
            truncated: false,
          },
        ],
      };
    if (url.endsWith('/stage')) {
      server.prepared = true;
      return {};
    }
    if (url.endsWith('/staged-diff'))
      return { fingerprint: 'prepared', diff: "+console.log('modification');" };
    if (url.endsWith('/commit')) {
      server.committed = true;
      return { sha: 'e'.repeat(40) };
    }
    if (url.endsWith('/push')) return { sha: 'e'.repeat(40) };
    throw new Error('Unexpected fixture route');
  },
}));
afterEach(() => {
  cleanup();
  server.prepared = false;
  server.committed = false;
  server.posts.splice(0);
});
test.each([390, 1100])(
  'prepare → commit → push is usable without a terminal at %ipx',
  async (width) => {
    await page.viewport(width, 950);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <div
          className="dark flex h-[930px] min-w-0 flex-col bg-background text-foreground"
          style={{ width: Math.min(width, 520) }}
        >
          <WorkspaceGitPanel
            agentThreadId="agent"
            projectId="p"
            resourceId="git"
            onSelect={() => {}}
            cwd="/copy"
            activeWorkspacePending={false}
            onActiveWorkspaceChange={() => {}}
            onFile={() => {}}
          >
            <span>Files</span>
          </WorkspaceGitPanel>
        </div>
      </QueryClientProvider>,
    );
    try {
      await screen.findByRole('tab', { name: /Modifications/ });
      await page.getByRole('tab', { name: /Modifications/ }).click();
      const commit = await screen.findByRole('button', { name: 'Commit…' });
      expect(commit).toBeDisabled();
      await page.getByRole('tab', { name: /Modifications/ }).click();
      await page.getByRole('button', { name: 'Préparer', exact: true }).click();
      await screen.findByRole('dialog');
      expect(server.posts).toHaveLength(1);
      await page
        .getByRole('button', { name: 'Confirmer la préparation', exact: true })
        .click();
      await expect.poll(() => commit.hasAttribute('disabled')).toBe(false);
      await page.getByRole('button', { name: 'Commit…' }).click();
      await page
        .getByRole('textbox', { name: 'Message du commit' })
        .fill('Mettre à jour coucou');
      expect(
        screen.getByRole('textbox', { name: 'Nom de l’auteur' }),
      ).toHaveValue('Utilisateur Test');
      expect(
        screen.getByRole('textbox', { name: 'Nom de l’auteur' }),
      ).toHaveAttribute('readonly');
      expect(
        screen.getByRole('textbox', { name: 'E-mail de l’auteur' }),
      ).toHaveValue('test@example.invalid');
      expect(
        screen.getByRole('textbox', { name: 'E-mail de l’auteur' }),
      ).toHaveAttribute('readonly');
      await page.screenshot({path: `../../../.vitest-screenshots/git-connected-author-${width}.png`});
      await page.getByRole('button', { name: 'Confirmer le commit' }).click();
      await expect.poll(() => server.committed).toBe(true);
      await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
      await page
        .getByRole('tab', { name: 'Synchronisation', exact: true })
        .click();
      await page
        .getByRole('button', { name: '↑ Publier les commits…' })
        .click();
      const confirmation = await screen.findByRole('dialog');
      expect(confirmation).toHaveTextContent('eeeeeee');
      await page.getByRole('button', { name: 'Confirmer le push' }).click();
      const syncRegion = await screen.findByRole('region', {
        name: 'Synchronisation',
      });
      expect(
        await within(syncRegion).findByText('Opération terminée · eeeeeee'),
      ).toBeVisible();
      expect(server.posts.map((p) => p.url.split('/').at(-1))).toEqual([
        'stage-review',
        'stage',
        'commit',
        'push',
      ]);
      expect(server.posts.every((p) => p.body.agentThreadId === 'agent')).toBe(
        true,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
