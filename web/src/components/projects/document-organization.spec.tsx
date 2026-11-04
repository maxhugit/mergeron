import { beforeEach, expect, it, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DocumentOrganizationPanel } from './document-organization';
import type { Deliverable } from '@/lib/deliverables-api';
import type { DocumentOrganization } from '@/lib/document-organization';
const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/projects-api', () => ({ projectsApi: mock.api }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
let data: DocumentOrganization;
const item = {
  id: 'd',
  version: 1,
  documents: [
    { id: 'a', name: 'report.txt', currentVersionNumber: 2, deletedAt: null },
    { id: 'b', name: 'video.mp4', currentVersionNumber: 1, deletedAt: null },
  ],
} as Deliverable;
beforeEach(() => {
  data = {
    labels: [
      { id: 'source', name: 'Sources' },
      { id: 'text', name: 'Transcriptions' },
    ],
    assignments: { a: ['source', 'text'], b: ['source'] },
    revision: 1,
    fingerprint: 'current',
    automaticEnabled: true,
    jobs: [],
  };
  mock.api
    .mockReset()
    .mockImplementation(
      (url: string, input?: { method: string; body: string }) => {
        if (!input) return Promise.resolve(structuredClone(data));
        const body = JSON.parse(input.body ?? '{}');
        if (url.endsWith('/labels') && input.method === 'POST') {
          data.labels.push({ id: 'new', name: body.name });
          data.revision++;
        }
        if (url.includes('/labels/') && input.method === 'DELETE') {
          const id = url.split('/').pop()!;
          data.labels = data.labels.filter((l) => l.id !== id);
          Object.keys(data.assignments).forEach((doc) => {
            data.assignments[doc] = data.assignments[doc].filter(
              (l) => l !== id,
            );
          });
          data.revision++;
        }
        if (url.endsWith('/organization/proposals'))
          data.jobs = [
            {
              id: 'proposal',
              mode: 'proposal',
              documentId: null,
              status: 'proposed',
              result: {
                labels: [
                  { id: 'text', name: 'Transcriptions' },
                  { id: 'new-files', name: 'Fichiers' },
                ],
                assignments: { a: ['text'], b: ['new-files'] },
                reason: 'Séparer les types',
              },
              error: null,
              createdAt: 1,
            },
          ];
        return Promise.resolve({});
      },
    );
});
function setup() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <DocumentOrganizationPanel
        item={item}
        base="/p/resources/r/deliverables"
        disabled={false}
      >
        {(docs, _labels, _assignments, classify) => (
          <div>
            {docs.map((d) => (
              <button key={d.id} onClick={() => classify(d)}>
                {d.name}
              </button>
            ))}
          </div>
        )}
      </DocumentOrganizationPanel>
    </QueryClientProvider>,
  );
}
it('filters a multi-label document into either virtual folder', async () => {
  setup();
  await screen.findByRole('button', { name: /Sources/ });
  fireEvent.click(screen.getByRole('button', { name: /Transcriptions/ }));
  expect(
    screen.getByRole('button', { name: 'report.txt' }),
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'video.mp4' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Sources/ }));
  expect(screen.getByRole('button', { name: 'video.mp4' })).toBeInTheDocument();
});
it('creates a label and warns before unassigning a used label', async () => {
  setup();
  const manageButton = await screen.findByRole('button', {
    name: 'Manage labels',
  });
  await waitFor(() => expect(manageButton).not.toBeDisabled());
  fireEvent.click(manageButton);
  const manage = await screen.findByRole('dialog', { name: 'Manage labels' });
  await waitFor(() =>
    expect(
      within(manage).getByRole('textbox', { name: 'Label name' }),
    ).not.toBeDisabled(),
  );
  fireEvent.change(
    within(manage).getByRole('textbox', { name: 'Label name' }),
    { target: { value: 'Références' } },
  );
  fireEvent.click(within(manage).getByRole('button', { name: 'Create label' }));
  await waitFor(() =>
    expect(within(manage).getByText('Références')).toBeInTheDocument(),
  );
  fireEvent.click(
    within(manage).getByRole('button', { name: 'Delete “Sources”' }),
  );
  const confirmation = await screen.findByRole('dialog', {
    name: 'Delete “Sources”',
  });
  expect(within(confirmation).getByRole('alert')).toHaveTextContent(
    '2 document(s)',
  );
  expect(data.labels.some((l) => l.id === 'source')).toBe(true);
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(data.assignments.a).toEqual(['text']));
  expect(item.documents).toHaveLength(2);
});
it('previews taxonomy and assignments before applying an AI proposal', async () => {
  setup();
  const button = await screen.findByRole('button', {
    name: 'Suggest an organization with AI',
  });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  const dialog = await screen.findByRole('dialog', {
    name: 'Suggest an organization with AI',
  });
  await within(dialog).findByText('Séparer les types');
  expect(data.labels.some((l) => l.id === 'source')).toBe(true);
  expect(mock.api.mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(
    false,
  );
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Apply proposal' }),
  );
  await waitFor(() =>
    expect(mock.api).toHaveBeenCalledWith(
      '/p/resources/r/deliverables/d/organization/proposals/proposal/apply',
      expect.anything(),
    ),
  );
});
