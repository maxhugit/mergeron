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
