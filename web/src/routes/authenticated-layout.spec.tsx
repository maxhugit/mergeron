import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { saveManagerUpdateReceipt } from '@/components/settings/manager-update-recovery';
import { AuthenticatedLayout } from './authenticated-layout';
import {
  AuthRedirectError,
  AuthResourceError,
  usePlatformSession,
} from '@/lib/platform-session';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => '/',
  Outlet: () => <DraftProbe />,
  Link: () => null,
}));
vi.mock('@/lib/platform-session', async (original) => ({
  ...(await original<typeof import('@/lib/platform-session')>()),
  usePlatformSession: vi.fn(),
  readAuthResource: vi.fn(async () => ({ maxIdleSubscriptions: 30 })),
}));
vi.mock('@/hooks/use-codex-socket', () => ({ useCodexSocket: vi.fn() }));
vi.mock('@/hooks/use-breakpoint', () => ({ useBreakpoint: () => 'desktop' }));
vi.mock('@/lib/file-reconciler', () => ({
  installFileReconciler: () => () => {},
}));
vi.mock('@/lib/browser-workspace-sessions', () => ({
  installBrowserWorkspaceSessions: () => () => {},
}));
vi.mock('@/generated/api', () => ({
  filesAddRoot: async () => ({ data: {} }),
  filesGetRoots: async () => ({
    data: { roots: ['/workspaces'], homeDir: '/home' },
  }),
}));
vi.mock('@/components/chat/thread-sidebar', () => ({
  ThreadSidebar: () => null,
}));
vi.mock('@/components/chat/chat-header', () => ({ ChatHeader: () => null }));
vi.mock('@/components/settings/settings-sidebar', () => ({
  SettingsSidebar: () => null,
}));
vi.mock('@/components/codex-status-banner', () => ({
  CodexStatusBanner: () => null,
}));
vi.mock('@/components/files/detached-document-recovery', () => ({
  DetachedDocumentRecovery: () => null,
}));
vi.mock('@/components/files/global-files-host', () => ({
  GlobalFilesHost: () => null,
}));
vi.mock('@/components/terminal/terminal-host', () => ({
  TerminalHost: () => null,
}));
vi.mock('@/components/impersonation-controls', () => ({
  ImpersonationBanner: () => null,
}));

const effects = { active: 0 };
function DraftProbe() {
  const [draft, setDraft] = useState('');
  useEffect(() => {
    effects.active++;
    return () => {
      effects.active--;
    };
  }, []);
  return (
    <div>
      Protected workspace
      <textarea
        aria-label="Unsent message"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {createPortal(<button>Private portal action</button>, document.body)}
    </div>
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function sessionFailure(error: Error) {
  vi.mocked(usePlatformSession).mockReturnValue({
    isPending: false,
    isError: true,
    error,
    data: {
      active: true,
      email: 'cached@example.test',
      subject: 'cached-subject',
      role: 'administrator',
    },
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePlatformSession>);
}

it('hides cached identity and protected content on transport failure', () => {
  sessionFailure(new TypeError('Load failed'));
  render(<AuthenticatedLayout />);
  expect(
    screen.getByRole('heading', { name: 'Reconnecting to the server…' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Restore connection' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/This page retries automatically/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Use another sign-in method' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('cached@example.test')).not.toBeInTheDocument();
  expect(screen.queryByText(/cached-subject/)).not.toBeInTheDocument();
  expect(screen.queryByText('Protected workspace')).not.toBeInTheDocument();
});

it('offers browser renewal for a proxy redirect rather than claiming the account is inactive', () => {
  sessionFailure(new AuthRedirectError());
  render(<AuthenticatedLayout />);
  expect(
    screen.getByRole('heading', { name: 'Session renewal required' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Restore connection' }),
  ).toBeInTheDocument();
  expect(screen.queryByText('Protected workspace')).not.toBeInTheDocument();
});

it('does not offer a transport recovery shortcut for a real access denial', () => {
  sessionFailure(new AuthResourceError('Forbidden', 403));
  render(<AuthenticatedLayout />);
  expect(
    screen.getByRole('heading', { name: 'Access unavailable' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Restore connection' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('Protected workspace')).not.toBeInTheDocument();
});

function updateReceipt() {
  saveManagerUpdateReceipt({
    startedAt: Date.now(),
    operationId: 'operation',
    excludedOperationId: null,
    snapshot: {
      id: 'operation',
      status: 'running',
      phase: 'backingUp',
      backupRetained: false,
      images: {},
      previousImages: {},
      events: [
        { at: new Date().toISOString(), phase: 'backingUp', status: 'running' },
      ],
    },
  });
}
it('renders the retained update monitor synchronously during restart, without authorizing cached identity or making protected requests', () => {
  updateReceipt();
  sessionFailure(new AuthResourceError('Restarting', 503));
  const fetch = vi.spyOn(globalThis, 'fetch');
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>,
  );
  expect(
    screen.getByRole('dialog', { name: 'Update progress' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('log')).toHaveTextContent('Saving application data');
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  expect(screen.queryByText('Protected workspace')).not.toBeInTheDocument();
  expect(screen.queryByText('cached@example.test')).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  view.unmount();
  client.clear();
});
it('does not restore the update monitor in place of a real access denial', () => {
  updateReceipt();
  sessionFailure(new AuthResourceError('Forbidden', 403));
  render(<AuthenticatedLayout />);
  expect(
    screen.getByRole('heading', { name: 'Access unavailable' }),
  ).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).toBeNull();
});

function verifiedSession(personId = 'original') {
  vi.mocked(usePlatformSession).mockReturnValue({
    isPending: false,
    isError: false,
    paused: false,
    error: null,
    data: {
      kind: 'person',
      personId,
      name: 'Person',
      role: 'administrator',
      active: true,
    },
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePlatformSession>);
}

it('does not install document-wide touch handlers for pull-to-refresh', () => {
  verifiedSession();
  const listen = vi.spyOn(document, 'addEventListener');
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>,
  );
  const touchEvents = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
  expect(
    listen.mock.calls.filter(([type]) => touchEvents.includes(type)),
  ).toHaveLength(0);
  expect(screen.getByRole('textbox', { name: 'Unsent message' })).toBeVisible();
  view.unmount();
  client.clear();
});

it('retains the same draft DOM through expiry, hides private portals and suspends effects until verified', async () => {
  verifiedSession();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>
  );
  const view = render(tree);
  const input = screen.getByRole('textbox', { name: 'Unsent message' });
  fireEvent.change(input, { target: { value: 'A draft that must survive' } });
  expect(effects.active).toBe(1);
  sessionFailure(new AuthRedirectError());
  view.rerender(tree);
  // Rerender a new root element so the hook test double is re-read.
  view.rerender(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(
    screen.queryByRole('button', { name: 'Private portal action' }),
  ).toBeNull();
  expect(effects.active).toBe(0);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  verifiedSession();
  view.rerender(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole('textbox')).toBe(input));
  expect(input).toHaveValue('A draft that must survive');
  expect(effects.active).toBe(1);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.unmount();
  client.clear();
});

it('never reveals the retained workspace after a different account is verified', async () => {
  verifiedSession();
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>,
  );
  verifiedSession('other-account');
  view.rerender(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(
    screen.getByRole('heading', { name: 'Identity or permissions changed' }),
  ).toBeInTheDocument();
  view.unmount();
  client.clear();
});
