import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KnowledgeProposalsPanel } from './knowledge-proposals-panel';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: globalThis.__testTranslate,
    i18n: { language: 'en' },
  }),
}));
const onApplied = vi.fn();
let proposal: {
  id: string;
  title: string;
  file: string;
  status: string;
  version: number;
  sourceType: string;
  threadId: string;
  createdAt: number;
  reviewedAt: number | null;
  reviewer: string | null;
  baseRevision: string;
  baseFiles: Record<string, string>;
  proposedFiles: Record<string, string>;
};
beforeEach(() => {
  onApplied.mockReset();
  proposal = {
    id: 'p1',
    title: 'Remember the project ID',
    file: 'DECISIONS.md',
    status: 'pending',
    version: 1,
    sourceType: 'agent',
    threadId: 't1',
    createdAt: 1000,
    reviewedAt: null,
    reviewer: null,
    baseRevision: 'revision-1',
    baseFiles: { 'DECISIONS.md': 'Before' },
    proposedFiles: { 'DECISIONS.md': 'Before\nNew decision' },
  };
  api.mockReset();
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string) as {
        action: string;
        version: number;
        content?: string;
      };
      proposal = {
        ...proposal,
        version: proposal.version + 1,
        ...(body.action === 'edit'
          ? { proposedFiles: { 'DECISIONS.md': body.content! } }
          : {
              status: body.action === 'accept' ? 'accepted' : 'rejected',
              reviewer: 'Maxime',
              reviewedAt: 2000,
            }),
      };
      return proposal;
    }
    return path.includes('?offset=')
      ? { proposals: [proposal], nextOffset: null }
      : proposal;
  });
});
afterEach(cleanup);
function setup(revision = 'revision-1', unsaved = false) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <KnowledgeProposalsPanel
        projectId="project"
        revision={revision}
        unsaved={unsaved}
        onApplied={onApplied}
      />
    </QueryClientProvider>,
  );
}
async function open() {
  await screen.findByLabelText('Proposed content');
  expect(
    screen.queryByRole('button', { name: 'Review proposal' }),
  ).not.toBeInTheDocument();
}

it('shows before/after and source, without applying before an explicit acceptance', async () => {
  setup();
  await open();
  expect(screen.getByLabelText('Before proposal')).toHaveValue('Before');
  expect(
    screen.getByRole('link', { name: /Open source conversation/ }),
  ).toHaveAttribute('href', '/t/t1');
  expect(api.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Accept and apply' }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
  const request = api.mock.calls.find(
    (call) => call[1]?.method === 'PATCH',
  )?.[1] as RequestInit;
  expect(JSON.parse(request.body as string)).toEqual({
    action: 'accept',
    version: 1,
  });
});

it('requires saving edits to the proposal before accepting its new version', async () => {
  setup();
  await open();
  fireEvent.change(screen.getByLabelText('Proposed content'), {
    target: { value: 'Reviewed decision' },
  });
  expect(
    screen.getByRole('button', { name: 'Accept and apply' }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Save proposal changes' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Accept and apply' }),
    ).toBeEnabled(),
  );
  expect(onApplied).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Accept and apply' }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
  const requests = api.mock.calls
    .filter((call) => call[1]?.method === 'PATCH')
    .map(
      (call) => JSON.parse((call[1] as RequestInit).body as string) as unknown,
    );
  expect(requests).toEqual([
    { action: 'edit', version: 1, content: 'Reviewed decision' },
    { action: 'accept', version: 2 },
  ]);
});

it('blocks an outdated proposal and can reject it without applying files', async () => {
  setup('revision-2');
  await open();
  expect(
    screen.getByRole('button', { name: 'Accept and apply' }),
  ).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Shared knowledge has changed',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await screen.findByText('Rejected');
  expect(onApplied).not.toHaveBeenCalled();
});

it('keeps unsaved manual knowledge drafts from being overwritten by acceptance', async () => {
  setup('revision-1', true);
  await open();
  expect(
    screen.getByRole('button', { name: 'Accept and apply' }),
  ).toBeDisabled();
});

it('expands every proposal and keeps independent drafts when another proposal is edited', async () => {
  const first = structuredClone(proposal);
  const second = {
    ...structuredClone(proposal),
    id: 'p2',
    title: 'Second decision',
  };
  api.mockImplementation(async (path: string) =>
    path.includes('?offset=')
      ? { proposals: [first, second], nextOffset: null }
      : path.endsWith('/p2')
        ? second
        : first,
  );
  setup();
  await waitFor(() =>
    expect(screen.getAllByLabelText('Proposed content')).toHaveLength(2),
  );
  const firstCard = within(screen.getByRole('article', { name: first.title }));
  const secondCard = within(
    screen.getByRole('article', { name: second.title }),
  );
  fireEvent.change(firstCard.getByLabelText('Proposed content'), {
    target: { value: 'First draft' },
  });
  fireEvent.change(secondCard.getByLabelText('Proposed content'), {
    target: { value: 'Second draft' },
  });
  expect(firstCard.getByLabelText('Proposed content')).toHaveValue(
    'First draft',
  );
  expect(secondCard.getByLabelText('Proposed content')).toHaveValue(
    'Second draft',
  );
  expect(
    firstCard.getByRole('button', { name: 'Accept and apply' }),
  ).toBeDisabled();
  expect(
    secondCard.getByRole('button', { name: 'Accept and apply' }),
  ).toBeDisabled();
});
