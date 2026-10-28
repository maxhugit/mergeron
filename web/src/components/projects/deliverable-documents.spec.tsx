import { beforeEach, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DeliverableDocuments } from './deliverable-documents';
import type { Deliverable } from '@/lib/deliverables-api';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  emit: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
}));
vi.mock('@/lib/projects-api', () => ({ projectsApi: mocks.api }));
vi.mock('@/components/files/file-viewer', () => ({ FileViewer: () => null }));
vi.mock('@/lib/file-change-events', () => ({
  emitFileChange: mocks.emit,
  beginFileMutation: mocks.begin,
  finishFileMutation: mocks.finish,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockReset().mockResolvedValue({
    oldPath: '/project/report.docx',
    newPath: '/project/Renamed.docx',
    previousFileRetained: false,
  });
});

function setup(disabled = false) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const item = {
    id: 'deliverable',
    directory: '/project',
    documents: [
      {
        id: 'document',
        deliverableId: 'deliverable',
        name: 'report.docx',
        format: 'docx',
        sourcePath: '/project/report.docx',
        currentVersionNumber: 2,
        deletedAt: null,
        createdAt: 0,
        updatedAt: 0,
        versions: [],
      },
    ],
  } as unknown as Deliverable;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <DeliverableDocuments
        item={item}
        base="/p/resources/r/deliverables"
        disabled={disabled}
        refresh={refresh}
        onError={onError}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByLabelText('Actions'));
  return { refresh, onError };
}

it('opens a prefilled rename dialog from the document menu and cancels without mutation', async () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rename document' });
  expect(
    within(dialog).getByRole('textbox', { name: 'Document name' }),
  ).toHaveValue('report.docx');
  expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(mocks.api).not.toHaveBeenCalled();
});

it('renames with document identity and version checks, reconciles open files and refreshes', async () => {
  const { refresh } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rename document' });
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'Renamed.docx' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(mocks.api).toHaveBeenCalledWith(
    '/p/resources/r/deliverables/deliverable/documents/document',
    {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'Renamed.docx',
        expectedName: 'report.docx',
        expectedVersion: 2,
      }),
    },
  );
  expect(mocks.begin).toHaveBeenCalledOnce();
  expect(mocks.finish).toHaveBeenCalledOnce();
  expect(mocks.emit).toHaveBeenCalledWith({
    source: 'local',
    kind: 'rename',
    oldPath: '/project/report.docx',
    newPath: '/project/Renamed.docx',
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('keeps the dialog and original selection on failure', async () => {
  mocks.api.mockRejectedValueOnce(new Error('conflict'));
  const { refresh, onError } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rename document' });
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'Renamed.docx' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(onError).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
  expect(mocks.emit).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('disables renaming for read-only or finalized deliverables', () => {
  setup(true);
  expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
});
