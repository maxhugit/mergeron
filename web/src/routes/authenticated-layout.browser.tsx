/** Real DOM/Activity recovery in Chromium and WebKit; only HTTP and shell tools are substituted. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthenticatedLayout } from './authenticated-layout';
import { installSessionRecovery } from '@/lib/session-recovery';
import { platformSessionKey } from '@/lib/platform-session';
import i18n, { i18nReady } from '@/i18n';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => '/t/retained',
  Outlet: () => (
    <div>
      <textarea aria-label="Unsent message" defaultValue="" />
      <div
        data-testid="retained-scroll"
        style={{ height: 100, overflow: 'auto' }}
      >
        <div style={{ height: 1000 }}>Retained conversation</div>
      </div>
    </div>
  ),
  Link: () => null,
}));
vi.mock('@/hooks/use-codex-socket', () => ({ useCodexSocket: vi.fn() }));
// This fixture tests the shell's session gate; retained workspace behavior has its own browser suite.
vi.mock('@/components/chat/agent-workspace-host', () => ({
  AgentWorkspaceHost: () => null,
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({ connected: false, emit: vi.fn() }),
  resetSocket: vi.fn(),
}));
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

let dispose: (() => void) | undefined;
afterEach(() => {
  cleanup();
  dispose?.();
  vi.restoreAllMocks();
});

test('keeps the page, exact draft element and scroll position through a real session-hook failure and recovery', async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  const identity = {
    active: true,
    kind: 'person',
    personId: 'original',
    name: 'Person',
    role: 'administrator',
  };
  let status = 200;
  vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
    const path = input instanceof Request ? input.url : String(input);
    return new Response(
      JSON.stringify(
        path.endsWith('/me') ? identity : { maxIdleSubscriptions: 30 },
      ),
      {
        status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
  dispose = installSessionRecovery();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>,
  );
  const input = await screen.findByRole('textbox', { name: 'Unsent message' });
  fireEvent.change(input, { target: { value: 'Do not lose this draft' } });
  const scroll = screen.getByTestId('retained-scroll');
  scroll.scrollTop = 320;
  const href = window.location.href;
  expect(scroll.scrollTop).toBe(320);
  status = 401;
  await act(() => client.refetchQueries({ queryKey: platformSessionKey }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(screen.getByRole('dialog')).toBeVisible();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeVisible();
  status = 200;
  await act(() => client.refetchQueries({ queryKey: platformSessionKey }));
  await waitFor(() => expect(screen.getByRole('textbox')).toBe(input));
  expect((input as HTMLTextAreaElement).value).toBe('Do not lose this draft');
  expect(scroll.scrollTop).toBe(320);
  expect(window.location.href).toBe(href);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.unmount();
  client.clear();
});

test('automatically recovers a transient real proxy redirect without navigation, cached authorization or replay', async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  const identity = {
    active: true,
    kind: 'person',
    personId: 'original',
    name: 'Person',
    role: 'administrator',
  };
  const actualFetch = window.fetch.bind(window);
  let interrupt = false;
  let redirected = false;
  let release: (() => void) | undefined;
  const identityResponse = () =>
    new Response(JSON.stringify(identity), {
      headers: { 'Content-Type': 'application/json' },
    });
  const network = vi
    .spyOn(window, 'fetch')
    .mockImplementation(async (input, init) => {
      const path = input instanceof Request ? input.url : String(input);
      if (path.endsWith('/me') && interrupt) {
        if (!redirected) {
          redirected = true;
          // Exercise the browser's actual opaque redirect, never contact the IdP.
          return actualFetch('/api/auth/__test_proxy_redirect', init);
        }
        return new Promise<Response>((resolve) => {
          release = () => resolve(identityResponse());
        });
      }
      return path.endsWith('/me') ? identityResponse() : new Response('{}');
    });
  dispose = installSessionRecovery();
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <AuthenticatedLayout />
    </QueryClientProvider>,
  );
  const input = await screen.findByRole('textbox', { name: 'Unsent message' });
  fireEvent.change(input, {
    target: { value: 'Keep the draft and original identity' },
  });
  const scroll = screen.getByTestId('retained-scroll');
  scroll.scrollTop = 320;
  const href = window.location.href;
  interrupt = true;
  let checking: Promise<void> | undefined;
  act(() => {
    checking = client.refetchQueries({ queryKey: platformSessionKey });
  });
  await waitFor(() => expect(release).toBeTypeOf('function'));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByRole('heading', { name: /verifying/i })).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  const calls = network.mock.calls.length;
  await expect(
    fetch('/api/projects', { method: 'POST', body: '{}' }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(network).toHaveBeenCalledTimes(calls);
  interrupt = false;
  await act(async () => {
    release?.();
    await checking;
  });
  await waitFor(() => expect(screen.getByRole('textbox')).toBe(input));
  expect((input as HTMLTextAreaElement).value).toBe(
    'Keep the draft and original identity',
  );
  expect(scroll.scrollTop).toBe(320);
  expect(window.location.href).toBe(href);
  expect(screen.queryByRole('dialog')).toBeNull();
  // Only identity GETs during recovery, no queued mutation after it.
  expect(
    network.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(0);
  view.unmount();
  client.clear();
});
