import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ExplorerDeliverables } from './explorer-deliverables';
import { useFilesStore } from '@/stores/files-store';
import type { ProjectSummary } from '@/lib/projects-api';
import { localExecutionSelection } from '@/lib/project-execution-location';
const syncProbe = vi.hoisted(() => ({ calls: vi.fn(), updatedAt: 1 }));
vi.mock('@/hooks/use-deliverable-git-status', () => ({
  useDeliverableGitStatus: (...args: unknown[]) => {
    syncProbe.calls(...args);
    return {
      copies: [],
      checking: false,
      state: () => 'off',
      refresh: () => {},
      select: () => {},
    };
  },
}));
vi.mock('@/hooks/use-file-watch', () => ({ useFileWatch: () => {} }));
vi.mock('@/lib/platform-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => ({
    isAdministrator: true,
    data: { personId: 'person' },
  }),
}));
vi.mock('@/hooks/use-deliverable-directory-aliases', () => ({
  useDeliverableBoards: () => [
    {
      dataUpdatedAt: syncProbe.updatedAt,
      isLoading: false,
      isError: false,
      data: {
        resource: { id: 'board' },
        tasks: [],
        deliverables: [
          {
            id: 'd',
            title: 'Report',
            directory: '/project/.mergeron-system/livrables/d',
            documents: [
              {
                id: 'doc',
                name: 'Choix.docx',
                sourcePath: '/project/.mergeron-system/livrables/d/Choix.docx',
                deletedAt: null,
                currentVersionNumber: 7,
                versions: [],
              },
              {
                id: 'deleted',
                name: 'Deleted.docx',
                sourcePath:
                  '/project/.mergeron-system/livrables/d/Deleted.docx',
                deletedAt: 1,
                currentVersionNumber: 13,
                versions: [],
              },
            ],
            lifecycleStatus: 'draft',
            validationRequired: false,
            validationStatus: 'not_required',
          },
        ],
      },
    },
  ],
}));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => {
    throw new Error('Deliverables must not mount a filesystem browser');
  },
}));
vi.mock('@/components/files/file-viewer', () => ({ FileViewer: () => null }));
const project = {
  id: 'p',
  resources: [],
  workspaces: [{ id: 'primary', path: '/project' }],
} as unknown as ProjectSummary;
function fixture(onReference = vi.fn(), revealPath?: string, onFile = vi.fn()) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ExplorerDeliverables
        project={project}
        onFile={onFile}
        pending={false}
        onReference={onReference}
        revealPath={revealPath}
      />
    </QueryClientProvider>,
  );
}
describe('deliverable explorer', () => {
  it('lists registered documents and their actual version without directory navigation', () => {
    useFilesStore.getState().setRootDir('/project/dossiers');
    const reference = vi.fn();
    fixture(reference);
    fireEvent.click(screen.getByRole('button', { name: /^Report/ }));
    expect(screen.getByText('Choix.docx')).toBeVisible();
    expect(screen.getByLabelText('Version 7')).toHaveTextContent('V7');
    expect(screen.queryByText('Deleted.docx')).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: /new folder|new file|upload folder|parent directory/i,
      }),
    ).toBeNull();
    expect(useFilesStore.getState().rootDir).toBe('/project/dossiers');
    expect(reference).not.toHaveBeenCalled();
  });
  it('offers explicit reference selection within the standard deliverable actions', async () => {
    const reference = vi.fn();
    fixture(reference);
    fireEvent.click(screen.getByRole('button', { name: 'Actions : Report' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Use as agent reference' }),
    );
    expect(reference).toHaveBeenCalledExactlyOnceWith(
      '/project/.mergeron-system/livrables/d',
    );
  });
  it('resolves the selected deliverable into an explicit nested project location', async () => {
    const association = vi.fn();
    fixture(
      vi.fn((directory: string) =>
        association(localExecutionSelection(project, directory)),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions : Report' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Use as agent reference' }),
    );
    expect(association).toHaveBeenCalledExactlyOnceWith({
      locationId: 'local:primary',
      relativePath: '.mergeron-system/livrables/d',
    });
  });
  it('reveals the document list directly from a deliverable or document link', async () => {
    fixture(undefined, '/project/.mergeron-system/livrables/d/Choix.docx');
    expect(await screen.findByText('Choix.docx')).toBeVisible();
    expect(screen.getByLabelText('Version 7')).toBeVisible();
  });
  it('opens a document directly and preserves document actions', async () => {
    const onFile = vi.fn();
    fixture(
      undefined,
      '/project/.mergeron-system/livrables/d/Choix.docx',
      onFile,
    );
    fireEvent.click(await screen.findByTitle('Choix.docx'));
    expect(onFile).toHaveBeenCalledExactlyOnceWith(
      '/project/.mergeron-system/livrables/d/Choix.docx',
    );
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Actions · Choix.docx' }),
      { button: 0, ctrlKey: false, pointerType: 'mouse' },
    );
    expect(
      await screen.findByRole('menuitem', { name: /history/i }),
    ).toBeVisible();
    expect(
      screen.queryByRole('menuitem', { name: /new folder|move|copy to/i }),
    ).toBeNull();
  });
});

it('does not schedule another comparison when only the board read timestamp changes', () => {
  syncProbe.calls.mockClear();
  syncProbe.updatedAt = 1;
  const view = fixture();
  const first = syncProbe.calls.mock.lastCall?.[3];
  expect(first).toContain('Choix.docx');
  syncProbe.updatedAt = 999;
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <ExplorerDeliverables
        project={project}
        onFile={vi.fn()}
        pending={false}
      />
    </QueryClientProvider>,
  );
  expect(syncProbe.calls.mock.lastCall?.[3]).toBe(first);
});
