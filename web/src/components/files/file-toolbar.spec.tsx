import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FileToolbar } from './file-toolbar';
import { useFilesStore } from '@/stores/files-store';

function toolbar(root: string, boundary?: string) {
  useFilesStore.setState({ rootDir: root });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileToolbar
        workspaceRoot={
          boundary ? { path: boundary, name: 'Dossiers' } : undefined
        }
        onUpload={vi.fn()}
        onNewFile={vi.fn()}
        onNewFolder={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return screen.getByTitle('Go up');
}

it.each(['/project/dossiers', '/project/dossiers/'])(
  'cannot leave the Dossiers root: %s',
  (root) => {
    const up = toolbar(root, '/project/dossiers/');
    expect(up).toBeDisabled();
    fireEvent.click(up);
    expect(useFilesStore.getState().rootDir).toBe(root);
  },
);

it('allows ascending from a subfolder and stops at the project folder boundary', () => {
  const up = toolbar('/project/dossiers/sub/deep', '/project/dossiers');
  fireEvent.click(up);
  expect(useFilesStore.getState().rootDir).toBe('/project/dossiers/sub');
  fireEvent.click(up);
  expect(useFilesStore.getState().rootDir).toBe('/project/dossiers');
  expect(up).toBeDisabled();
  fireEvent.click(up);
  expect(useFilesStore.getState().rootDir).toBe('/project/dossiers');
});

it('does not enable ascending for a similarly named folder outside the boundary', () => {
  const up = toolbar('/project/dossiers-other', '/project/dossiers');
  expect(up).toBeDisabled();
  fireEvent.click(up);
  expect(useFilesStore.getState().rootDir).toBe('/project/dossiers-other');
});

it('preserves unbounded administration navigation and stops at filesystem root', () => {
  const up = toolbar('/work');
  expect(up).toBeEnabled();
  fireEvent.click(up);
  expect(useFilesStore.getState().rootDir).toBe('/');
  expect(up).toBeDisabled();
});
