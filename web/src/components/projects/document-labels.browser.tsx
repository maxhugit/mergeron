import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  render,
  cleanup,
  screen,
  fireEvent,
  within,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { DeliverableDocuments } from './deliverable-documents';
import type { Deliverable } from '@/lib/deliverables-api';
import type { DocumentOrganization } from '@/lib/document-organization';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/projects-api', () => ({ projectsApi: mocks.api }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
vi.mock('@/components/files/file-viewer', () => ({ FileViewer: () => null }));
let organization: DocumentOrganization;
const item = {
  id: 'deliverable',
  title: 'Transcription',
  directory: '/workspaces/p/livrables/deliverable',
  version: 2,
  lifecycleStatus: 'in_constitution',
  documents: [
    {
      id: 'doc',
      deliverableId: 'deliverable',
      name: 'Transcription.txt',
      format: 'txt',
      sourcePath: '/workspaces/p/livrables/deliverable/Transcription.txt',
      deletedAt: null,
      currentVersionNumber: 2,
      versions: [
        {
          id: 'v2',
          number: 2,
          authorName: 'Agent — Transcription',
          createdAt: Date.UTC(2026, 10, 3),
          size: 100,
          sha256: 'sha',
        },
      ],
    },
  ],
} as Deliverable;
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  organization = {
    labels: [
      { id: 'source', name: 'Sources' },
      { id: 'text', name: 'Transcriptions' },
    ],
    assignments: { doc: ['source', 'text'] },
    revision: 1,
    fingerprint: 'current',
    automaticEnabled: true,
    jobs: [],
  };
  mocks.api
    .mockReset()
    .mockImplementation(
      (_url: string, input?: { method: string; body: string }) => {
        if (!input) return Promise.resolve(structuredClone(organization));
        if (input.method === 'DELETE') {
          organization.labels = organization.labels.filter(
            (l) => l.id !== 'source',
          );
          organization.assignments.doc = ['text'];
          organization.revision++;
        }
        return Promise.resolve({});
      },
    );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup() {
  return render(
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
      <div style={{ padding: 16 }}>
        <DeliverableDocuments
          item={item}
          base="/p/resources/r/deliverables"
          disabled={false}
          refresh={() => Promise.resolve()}
          onError={() => {
            throw Error('Unexpected mutation error');
          }}
        />
      </div>
    </QueryClientProvider>,
  );
}
test.each([390, 1180])(
  'keeps folders and confirmation usable at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    setup();
    await screen.findByRole('button', { name: /Sources/ });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Gérer les étiquettes' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Gérer les étiquettes',
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Supprimer « Sources »' }),
    );
    const confirmation = await screen.findByRole('dialog', {
      name: 'Supprimer « Sources »',
    });
    expect(within(confirmation).getByRole('alert')).toHaveTextContent(
      'automatiquement désaffectée',
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/document-labels-confirm-${width}.png`,
    });
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: 'Supprimer',
      }),
    );
    await waitFor(() => expect(organization.assignments.doc).toEqual(['text']));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /^Supprimer/ })).toBeNull(),
    );
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Gérer les étiquettes' }),
      ).getByRole('button', { name: /Close|Fermer/ }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await page.screenshot({
      path: `../../../.vitest-screenshots/document-labels-${width}.png`,
    });
  },
);
test('dropping on a document requires confirmation and uploads a canonical named new version', async () => {
  await page.viewport(1180, 900);
  setup();
  await screen.findByRole('button', { name: /Sources/ });
  const originalFetch = window.fetch.bind(window),
    upload = vi.fn();
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).includes('/documents/upload')) {
      upload(input, init);
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  });
  const link = screen.getByRole('link', { name: /Transcription.txt/ }),
    row = link.closest('article')!;
  const transfer = new DataTransfer();
  transfer.items.add(
    new File(['Version test'], 'Révision différente.txt', {
      type: 'text/plain',
    }),
  );
  row.dispatchEvent(
    new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Ajouter une nouvelle version',
  });
  expect(upload).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Créer la nouvelle version' }),
  );
  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  const [url, init] = upload.mock.calls[0];
  expect(String(url)).toContain('documentId=doc&expectedVersion=2');
  expect((init.body as FormData).get('files')).toMatchObject({
    name: 'Transcription.txt',
  });
});
