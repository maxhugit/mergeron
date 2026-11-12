import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectsApi } from '@/lib/projects-api';
import { key, type Status } from '@/lib/git-deliverables-api';
import { useDeliverableGitStatus } from './use-deliverable-git-status';

const session = vi.hoisted(() => ({ paused: false }));
vi.mock('@/hooks/use-git-copy-live-updates', () => ({
  useGitCopyLiveUpdates: () => {},
}));
vi.mock('@/lib/session-recovery', () => ({
  useSessionPaused: () => session.paused,
}));
vi.mock('@/lib/projects-api', () => ({ projectsApi: vi.fn() }));

let client: QueryClient;
let status: Status;
let failResume: boolean;
const posts = () =>
  vi
    .mocked(projectsApi)
    .mock.calls.filter(([, init]) => init?.method === 'POST');
beforeEach(() => {
  session.paused = false;
  failResume = false;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  status = {
    boards: [
      {
        id: 'board',
        name: 'Livrables',
        restricted: [],
        settings: {
          enabled: true,
          directory: 'livrables',
          restrictedIds: [],
          lastError: null,
          lastSyncAt: null,
        },
      },
    ],
    copies: [
      {
        id: 'own',
        name: 'Selected',
        sourceResourceId: 'source',
        ownerThreadIds: ['agent'],
        writable: true,
        owned: true,
        eligible: true,
        pending: true,
        lastError: 'GIT_DELIVERABLES_REVIEW_REQUIRED',
        context: { branch: 'refs/heads/main', head: 'one' },
      },
      {
        id: 'foreign',
        name: 'Another agent',
        ownerThreadIds: ['other'],
        writable: true,
        owned: true,
        eligible: true,
      },
    ],
    discovered: [],
    discoveryError: null,
    proposal: {
      fingerprint: 'first',
      context: { branch: 'refs/heads/main', head: 'one' },
      canApply: true,
      changes: [
        {
          deliverable: 'Cadrage',
          document: 'conflict.md',
          action: 'conflict',
          reason: 'document_changed_both',
        },
        {
          deliverable: 'Maquette',
          document: 'mockup.html',
          action: 'export',
          reason: 'new_document',
        },
      ],
    },
  };
  vi.mocked(projectsApi)
    .mockReset()
    .mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') {
        if (failResume) throw new Error('HTTP 503');
        return { scheduled: true } as never;
      }
      return structuredClone(status) as never;
    });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function show(canResume = true) {
  return renderHook(
    ({ allowed }) =>
      useDeliverableGitStatus('p', 'agent', 'source', 'revision', allowed),
    {
      initialProps: { allowed: canResume },
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </StrictMode>
      ),
    },
  );
}
async function settle() {
  await waitFor(() => expect(client.isFetching()).toBe(0));
}
it('resumes clean document exports only on the selected copy, despite a sibling conflict, once per plan', async () => {
  show();
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toEqual([
    '/p/git-deliverables/reconcile',
    { method: 'POST', body: JSON.stringify({ copyId: 'own' }) },
  ]);
  await act(async () => {
    await client.invalidateQueries({ queryKey: key('p') });
  });
  await settle();
  expect(posts()).toHaveLength(1);
  status.proposal!.fingerprint = 'after-safe-export';
  status.proposal!.changes = status.proposal!.changes.filter(
    (change) => change.action !== 'export',
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: key('p') });
  });
  expect(posts()).toHaveLength(1);
});
it('resumes a newly verified plan and resumes retained pending work after remount', async () => {
  const view = show();
  await waitFor(() => expect(posts()).toHaveLength(1));
  status.proposal!.fingerprint = 'new-document';
  await act(async () => {
    await client.invalidateQueries({ queryKey: key('p') });
  });
  await waitFor(() => expect(posts()).toHaveLength(2));
  view.unmount();
  show();
  await waitFor(() => expect(posts()).toHaveLength(3));
});
it.each([
  'read-only person',
  'paused session',
  'ineligible copy',
  'read-only copy',
  'unowned copy',
  'unresolved structure',
  'discovery error',
  'stale branch',
  'only conflicts',
  'only imports',
  'active job',
  'mode disabled',
])('does not resume for %s', async (condition) => {
  if (condition === 'paused session') session.paused = true;
  if (condition === 'ineligible copy') status.copies[0].eligible = false;
  if (condition === 'read-only copy') status.copies[0].writable = false;
  if (condition === 'unowned copy') status.copies[0].owned = false;
  if (condition === 'unresolved structure') status.proposal!.canApply = false;
  if (condition === 'discovery error')
    status.discoveryError = 'GIT_DELIVERABLES_CHANGED';
  if (condition === 'stale branch') status.proposal!.context!.head = 'old';
  if (condition === 'only conflicts')
    status.proposal!.changes = status.proposal!.changes.filter(
      (change) => change.action === 'conflict',
    );
  if (condition === 'only imports')
    status.proposal!.changes = [
      { deliverable: 'Git only', action: 'import', reason: 'new_document' },
    ];
  if (condition === 'active job') status.active = true;
  if (condition === 'mode disabled') status.boards[0].settings!.enabled = false;
  show(condition !== 'read-only person');
  await settle();
  expect(posts()).toHaveLength(0);
});
it('reports a failed resume without retry storms, and allows an explicit refresh to retry', async () => {
  failResume = true;
  const view = show();
  await waitFor(() => expect(view.result.current.state()).toBe('error'));
  expect(posts()).toHaveLength(1);
  await act(async () => {
    await client.invalidateQueries({ queryKey: key('p') });
  });
  expect(posts()).toHaveLength(1);
  failResume = false;
  act(() => view.result.current.refresh());
  await waitFor(() => expect(posts()).toHaveLength(2));
  await waitFor(() => expect(view.result.current.checking).toBe(false));
  expect(view.result.current.state()).toBe('review');
});
it('resumes after identity verification and never posts during a paused session', async () => {
  session.paused = true;
  const view = show();
  await settle();
  expect(posts()).toHaveLength(0);
  session.paused = false;
  view.rerender({ allowed: true });
  await waitFor(() => expect(posts()).toHaveLength(1));
});
