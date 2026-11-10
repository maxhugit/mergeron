import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ExplorerDeliverables } from './explorer-deliverables';
import type { ProjectSummary } from '@/lib/projects-api';
import type { Deliverable } from '@/lib/deliverables-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
vi.mock('@/hooks/use-deliverable-git-status', () => ({
  useDeliverableGitStatus: () => ({
    copies: [],
    selectedId: 'copy',
    copy: {
      id: 'copy',
      name: 'Test copy',
      directory: 'livrables',
      context: { branch: 'refs/heads/main', head: 'sha' },
    },
    data: {
      boards: [
        {
          id: 'board',
          settings: {
            enabled: true,
            directory: 'livrables',
            restrictedIds: [],
          },
        },
      ],
    },
    checking: false,
    state: () => 'off',
    documentState: (_item: string, id: string) =>
      id === 'conflict' ? 'error' : id === 'pending' ? 'pending' : 'ready',
    refresh: () => {},
    select: () => {},
  }),
}));
vi.mock('@/hooks/use-file-watch', () => ({ useFileWatch: () => {} }));
vi.mock('@/lib/platform-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => ({
    isAdministrator: true,
    data: { personId: 'person' },
  }),
}));
vi.mock('@/components/files/file-viewer', () => ({ FileViewer: () => null }));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => {
    throw Error('No filesystem browser in deliverables');
  },
}));
vi.mock('@/hooks/use-deliverable-directory-aliases', () => ({
  useDeliverableBoards: () => [
    {
      isLoading: false,
      isError: false,
      data: { resource: { id: 'board' }, tasks: [], deliverables: [item] },
    },
  ],
}));
vi.mock('@/hooks/use-agent-document-view', () => ({
  useAgentDocumentView: function usePreference() {
    const client = useQueryClient();
    const { data: mode } = useQuery({
      queryKey: ['mock-mode'],
      queryFn: async () => 'plain',
      initialData: 'plain',
      staleTime: Infinity,
    });
    return {
      mode,
      setMode: (value: string) => client.setQueryData(['mock-mode'], value),
      available: true,
      loading: false,
      error: false,
    };
  },
}));
vi.mock('@/hooks/use-sidebar-preferences', () => ({
  useSidebarPreferences: function usePreference() {
    const [values, setValues] = useState<Record<string, boolean | string>>({});
    return {
      values,
      ready: true,
      pending: false,
      error: false,
      set: (key: string, value: boolean | string) =>
        setValues((old) => ({ ...old, [key]: value })),
    };
  },
}));
vi.mock('@/lib/document-organization', () => ({
  useDocumentOrganization: () => ({
    isLoading: false,
    isError: false,
    data: {
      labels: [
        { id: 'source', name: 'Sources' },
        { id: 'report', name: 'Synthèse' },
      ],
      assignments: { doc: ['source', 'report'] },
    },
  }),
}));
const name = 'Choix_style_voiture_references_visuelles.docx';
const path = '/workspaces/p/.mergeron-system/livrables/d/' + name;
const item = {
  id: 'd',
  title: 'Dossier de conception',
  directory: '/workspaces/p/.mergeron-system/livrables/d',
  version: 7,
  lifecycleStatus: 'draft',
  validationRequired: false,
  validationStatus: 'not_required',
  documents: [
    {
      id: 'doc',
      name,
      sourcePath: path,
      deletedAt: null,
      currentVersionNumber: 7,
      versions: [{ id: 'v7', number: 7, createdAt: 0, authorName: 'Merlin' }],
    },
    {
      id: 'deleted',
      name: 'Supprimé.docx',
      sourcePath: '/deleted',
      deletedAt: 1,
      currentVersionNumber: 99,
      versions: [],
    },
  ],
} as Deliverable;
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  document.documentElement.classList.add('dark');
});
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test('colors only the affected document versions, with explanatory tooltips on mobile and desktop', async () => {
  const original = item.documents;
  item.documents = [
    original[0],
    ...['conflict', 'pending'].map((id) => ({
      ...original[0],
      id,
      name:
        id === 'conflict' ? 'Document en conflit.md' : 'Document à exporter.md',
      currentVersionNumber: 2,
    })),
  ];
  try {
    const corrections: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/document-preview'))
          return new Response(
            JSON.stringify({
              fingerprint: 'reviewed',
              version: 2,
              context: { branch: 'refs/heads/main', head: 'sha' },
              mergeron: {
                path: '/retained/conflict.md',
                sha256: 'a'.repeat(64),
                size: 10,
              },
              git: {
                path: '/copy/conflict.md',
                exists: true,
                sha256: 'b'.repeat(64),
                size: 12,
              },
              actions: ['mergeron', 'git'],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        if (url.endsWith('/apply'))
          corrections.push(JSON.parse(String(init?.body)));
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    for (const width of [390, 1180]) {
      await page.viewport(width, 820);
      const view = render(
        <QueryClientProvider client={new QueryClient()}>
          <div
            className="bg-background text-foreground"
            style={{ width: 'min(100%, 400px)', padding: 8 }}
          >
            <ExplorerDeliverables
              project={
                {
                  id: 'p',
                  resources: [],
                  workspaces: [],
                } as unknown as ProjectSummary
              }
              agentThreadId="agent"
              onFile={() => {}}
              pending={false}
            />
          </div>
        </QueryClientProvider>,
      );
      fireEvent.click(
        screen.getByRole('button', { name: /^Dossier de conception/ }),
      );
      expect(
        screen.getByLabelText(
          /Version 2 · Synchronisation de ce document bloquée/,
        ),
      ).toHaveClass('bg-red-100');
      expect(
        screen.getByLabelText(/Version 2 · Export de ce document en attente/),
      ).toHaveClass('bg-orange-100');
      expect(screen.getByLabelText('Version 7')).toHaveClass('bg-muted');
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
      await page.screenshot({
        path: `../../../.vitest-screenshots/document-sync-colors-${width}.png`,
      });
      fireEvent.click(
        screen.getByRole('button', {
          name: /Version 2 · Synchronisation de ce document bloquée/,
        }),
      );
      expect(
        await screen.findByRole('dialog', {
          name: 'Synchronisation du document',
        }),
      ).toBeVisible();
      expect(
        screen.getByText('Document en conflit.md', { selector: 'p' }),
      ).toBeVisible();
      await page.screenshot({
        path: `../../../.vitest-screenshots/document-sync-dialog-${width}.png`,
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Conserver la version Mergeron' }),
      );
      expect(corrections).toHaveLength(width === 390 ? 0 : 1);
      fireEvent.click(
        screen.getByRole('button', { name: 'Confirmer la correction' }),
      );
      await vi.waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: 'Synchronisation du document' }),
        ).toBeNull(),
      );
      view.unmount();
    }
  } finally {
    item.documents = original;
  }
});
test.each([390, 1180])(
  'lists versioned documents without filesystem navigation at %ipx',
  async (width) => {
    await page.viewport(width, 820);
    const onFile = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div
          className="bg-background text-foreground"
          style={{ width: 'min(100%, 400px)', padding: 8 }}
        >
          <ExplorerDeliverables
            project={
              {
                id: 'p',
                resources: [],
                workspaces: [],
              } as unknown as ProjectSummary
            }
            agentThreadId="agent"
            onFile={onFile}
            pending={false}
          />
        </div>
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /^Dossier de conception/ }),
    );
    expect(screen.getByLabelText('Version 7').textContent).toBe('V7');
    expect(screen.queryByText('Supprimé.docx')).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: /nouveau dossier|nouveau fichier|dossier parent|actualiser/i,
      }),
    ).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    const row = screen.getByTitle(name);
    fireEvent.click(row);
    expect(onFile).toHaveBeenCalledExactlyOnceWith(path);
    const badge = screen.getByLabelText('Version 7').getBoundingClientRect();
    expect(badge.right).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/deliverable-document-list-${width}.png`,
    });
    await page.getByRole('button', { name: 'Actions · ' + name }).click();
    expect(
      await screen.findByRole('menuitem', { name: 'Historique' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('menuitem', {
        name: /nouveau dossier|déplacer|copier vers/i,
      }),
    ).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Dossiers d’étiquettes' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Sources/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Synthèse/ }));
    expect(screen.getAllByLabelText('Version 7')).toHaveLength(2);
    await page.screenshot({
      path: `../../../.vitest-screenshots/deliverable-document-labels-${width}.png`,
    });
  },
);
