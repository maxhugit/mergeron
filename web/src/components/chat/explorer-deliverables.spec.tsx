import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ExplorerDeliverables } from './explorer-deliverables';
import { useFileBrowserState } from '@/components/files/file-browser-context';
import { useFilesStore } from '@/stores/files-store';
import type { ProjectSummary } from '@/lib/projects-api';

vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    isAdministrator: true,
    data: { personId: 'person' },
  }),
}));
vi.mock('@/hooks/use-deliverable-directory-aliases', () => ({
  useDeliverableBoards: () => [
    {
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
            documents: [],
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
  FileTree: () => (
    <div data-testid="document-tree">
      {useFileBrowserState((state) => state.rootDir)}
    </div>
  ),
}));
const project = {
  id: 'p',
  resources: [],
  workspaces: [],
} as unknown as ProjectSummary;
function fixture(onReference = vi.fn(), revealPath?: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ExplorerDeliverables
        project={project}
        onFile={() => {}}
        pending={false}
        onReference={onReference}
        revealPath={revealPath}
      />
    </QueryClientProvider>,
  );
}

describe('deliverable explorer', () => {
  it('browses documents in an independent tree without implicitly changing the reference', () => {
    useFilesStore.getState().setRootDir('/project/dossiers');
    const onReference = vi.fn();
    fixture(onReference);
    fireEvent.click(screen.getByRole('button', { name: /^Report/ }));
    expect(screen.getByTestId('document-tree')).toHaveTextContent(
      '/project/.mergeron-system/livrables/d',
    );
    expect(useFilesStore.getState().rootDir).toBe('/project/dossiers');
    expect(onReference).not.toHaveBeenCalled();
  });
  it('offers reference selection within the standard deliverable actions', async () => {
    const onReference = vi.fn();
    fixture(onReference);
    fireEvent.click(screen.getByRole('button', { name: 'Actions : Report' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Use as agent reference' }),
    );
    expect(onReference).toHaveBeenCalledExactlyOnceWith(
      '/project/.mergeron-system/livrables/d',
    );
  });
  it('reveals a deliverable folder link directly', async () => {
    fixture(undefined, '/project/.mergeron-system/livrables/d');
    expect(await screen.findByTestId('document-tree')).toHaveTextContent(
      '/project/.mergeron-system/livrables/d',
    );
  });
});
