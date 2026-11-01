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
import { page, commands } from 'vitest/browser';
import { AuthenticatedLayout } from './authenticated-layout';
import {
  installSessionRecovery,
  isSessionPaused,
} from '@/lib/session-recovery';
import { platformSessionKey } from '@/lib/platform-session';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import {
  clearSessionDiagnostics,
  exportSessionDiagnostics,
  getSessionDiagnostics,
} from '@/lib/session-diagnostics';

declare module 'vitest/browser' {
  interface BrowserCommands {
    sessionStackControl: (
      action:
        | 'create'
        | 'restore'
        | 'dispose'
        | 'status'
        | 'backend'
        | 'auth'
        | 'proxy'
        | 'expired'
        | 'forbidden',
      id?: string,
    ) => Promise<{
      id: string;
      prefix: string;
      mutations: number;
      listenersClosed?: boolean;
    }>;
  }
}

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
  clearSessionDiagnostics();
});

// Unlike fetch doubles above, these cases use actual loopback HTTP upstreams.
// The test command closes/reopens their listeners; no real service is touched.
test.each([
  ['backend', 390],
  ['auth', 390],
  ['proxy', 390],
  ['backend', 1180],
] as const)(
  'recovers from a real %s listener outage at %ipx without replay or lost draft',
  async (fault, width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const fixture = await commands.sessionStackControl('create');
    const actualFetch = window.fetch.bind(window);
    vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.href,
      ).pathname;
      return actualFetch(
        path.startsWith('/api/') ? fixture.prefix + path : input,
        init,
      );
    });
    dispose = installSessionRecovery();
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <AuthenticatedLayout />
      </QueryClientProvider>,
    );
    try {
      const input = await screen.findByRole('textbox', {
        name: 'Unsent message',
      });
      fireEvent.change(input, { target: { value: 'PRIVATE_UNSENT_DRAFT' } });
      const scroll = screen.getByTestId('retained-scroll');
      scroll.scrollTop = 320;
      const href = window.location.href;
      clearSessionDiagnostics();
      await commands.sessionStackControl(fault, fixture.id);
      act(() => {
        void client.refetchQueries({ queryKey: platformSessionKey });
      });
      await waitFor(() =>
        expect(
          getSessionDiagnostics().some(
            (entry) => entry.reason === 'server_unavailable',
          ),
        ).toBe(true),
      );
      expect(isSessionPaused()).toBe(true);
      expect(screen.queryByRole('textbox')).toBeNull();
      await expect(
        fetch('/api/projects', {
          method: 'POST',
          body: 'PRIVATE_UNSENT_DRAFT',
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      // Expand evidence while still locked; download needs no protected API call.
      fireEvent.click(screen.getByText('Diagnostic de connexion'));
      expect(
        screen.getByRole('button', { name: 'Télécharger le diagnostic' }),
      ).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const engine = navigator.userAgent.includes('Chrome')
        ? 'chromium'
        : 'webkit';
      await page.screenshot({
        path: `../../.vitest-screenshots/session-outage-${fault}-${engine}-${width}.png`,
      });
      await commands.sessionStackControl('restore', fixture.id);
      // No manual refetch, focus or pageshow: the existing bounded recovery owns it.
      await waitFor(() => expect(screen.getByRole('textbox')).toBe(input), {
        timeout: 10000,
      });
      expect(input).toHaveValue('PRIVATE_UNSENT_DRAFT');
      expect(scroll.scrollTop).toBe(320);
      expect(window.location.href).toBe(href);
      // Recovery may already be checking while the screenshot is captured.
      // Its response can succeed after restore without starting another check.
      // Assert a real retry after the failure, not a new request after restore.
      const diagnostics = getSessionDiagnostics();
      const failure = diagnostics.findIndex(
        (entry) =>
          entry.event === 'check_failed' &&
          entry.reason === 'server_unavailable',
      );
      expect(failure).toBeGreaterThanOrEqual(0);
      expect(
        diagnostics
          .slice(failure + 1)
          .some((entry) => entry.event === 'check_started'),
      ).toBe(true);
      expect(
        getSessionDiagnostics().some((entry) => entry.event === 'resumed'),
      ).toBe(true);
      const report = exportSessionDiagnostics();
      expect(report).not.toContain('PRIVATE_UNSENT_DRAFT');
      expect(report).not.toContain('SESSION_FIXTURE_PERSON');
      expect(
        (await commands.sessionStackControl('status', fixture.id)).mutations,
      ).toBe(0);
    } finally {
      view.unmount();
      client.clear();
      expect(
        (await commands.sessionStackControl('dispose', fixture.id))
          .listenersClosed,
      ).toBe(true);
    }
  },
  20000,
);

test.each(['expired', 'forbidden'] as const)(
  'never treats a persistent real %s denial as a server restart',
  async (fault) => {
    await page.viewport(390, 900);
    await i18nReady;
    await i18n.changeLanguage('en');
    const fixture = await commands.sessionStackControl('create');
    const actualFetch = window.fetch.bind(window);
    vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.href,
      ).pathname;
      return actualFetch(
        path.startsWith('/api/') ? fixture.prefix + path : input,
        init,
      );
    });
    dispose = installSessionRecovery();
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <AuthenticatedLayout />
      </QueryClientProvider>,
    );
    try {
      await screen.findByRole('textbox', { name: 'Unsent message' });
      clearSessionDiagnostics();
      await commands.sessionStackControl(fault, fixture.id);
      await act(() => client.refetchQueries({ queryKey: platformSessionKey }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
      expect(isSessionPaused()).toBe(true);
      expect(screen.queryByRole('textbox')).toBeNull();
      const reason = fault === 'expired' ? 'proxy_redirect' : 'forbidden';
      expect(
        getSessionDiagnostics().some((entry) => entry.reason === reason),
      ).toBe(true);
      expect(
        getSessionDiagnostics().some((entry) => entry.event === 'resumed'),
      ).toBe(false);
      if (fault === 'forbidden')
        expect(
          getSessionDiagnostics().some(
            (entry) => entry.event === 'retry_scheduled',
          ),
        ).toBe(false);
      else {
        const retries = getSessionDiagnostics().filter(
          (entry) => entry.event === 'retry_scheduled',
        );
        expect(retries.slice(0, 3).map((entry) => entry.attempt)).toEqual([
          1, 2, 3,
        ]);
        expect(
          retries.every((entry) => entry.attempt! >= 1 && entry.attempt! <= 3),
        ).toBe(true);
        // WebKit may focus the window when the locked dialog opens. That is a
        // new verification, not an unbounded retry chain; its cause stays visible.
        if (retries.length > 3)
          expect(
            getSessionDiagnostics().some(
              (entry) => entry.event === 'wake' && entry.trigger === 'focus',
            ),
          ).toBe(true);
      }
      expect(
        (await commands.sessionStackControl('status', fixture.id)).mutations,
      ).toBe(0);
    } finally {
      view.unmount();
      client.clear();
      expect(
        (await commands.sessionStackControl('dispose', fixture.id))
          .listenersClosed,
      ).toBe(true);
    }
  },
  20000,
);

test.each([390, 1180])(
  'keeps ordinary input focus distinct from window return at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const identity = {
      active: true,
      kind: 'person',
      personId: 'original',
      role: 'administrator',
    };
    const network = vi
      .spyOn(window, 'fetch')
      .mockImplementation(
        async (input) =>
          new Response(
            JSON.stringify(String(input).endsWith('/me') ? identity : {}),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      );
    dispose = installSessionRecovery();
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <AuthenticatedLayout />
      </QueryClientProvider>,
    );
    try {
      const input = await screen.findByRole('textbox', {
        name: 'Unsent message',
      });
      // Enter this test iframe while the verification is still fresh. Gaining
      // actual window focus is intentionally different from changing fields.
      act(() => {
        input.focus();
        input.blur();
      });
      clock += 31_000;
      const calls = network.mock.calls.length;
      act(() => input.focus());
      expect(document.activeElement).toBe(input);
      expect(isSessionPaused()).toBe(false);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(network).toHaveBeenCalledTimes(calls);
      fireEvent.change(input, {
        target: { value: 'La saisie ne ferme pas la session.' },
      });
      expect(input).toHaveValue('La saisie ne ferme pas la session.');
    } finally {
      view.unmount();
      client.clear();
    }
  },
);

test.each([390, 1180])(
  'silently verifies a real retained layout on window return, without renewal dialog, replay or lost draft at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const identity = {
      active: true,
      kind: 'person',
      personId: 'original',
      role: 'administrator',
    };
    const response = () =>
      new Response(JSON.stringify(identity), {
        headers: { 'Content-Type': 'application/json' },
      });
    let pending = false;
    let finish!: (value: Response) => void;
    const network = vi
      .spyOn(window, 'fetch')
      .mockImplementation(async (input) => {
        if (String(input).endsWith('/me'))
          return pending
            ? new Promise<Response>((resolve) => {
                finish = resolve;
              })
            : response();
        return new Response('{}');
      });
    dispose = installSessionRecovery();
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <AuthenticatedLayout />
      </QueryClientProvider>,
    );
    try {
      const input = await screen.findByRole('textbox', {
        name: 'Unsent message',
      });
      fireEvent.change(input, {
        target: { value: 'Brouillon conservé pendant la vérification.' },
      });
      const scroll = screen.getByTestId('retained-scroll');
      scroll.scrollTop = 320;
      const href = window.location.href;
      pending = true;
      clock += 31_000;
      const before = network.mock.calls.length;
      act(() => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
        window.dispatchEvent(new Event('online'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(network).toHaveBeenCalledTimes(before + 1);
      expect(isSessionPaused()).toBe(true);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
      expect(
        screen.getByRole('heading', { name: 'Vérification de l’identité…' }),
      ).toBeVisible();
      expect(screen.queryByText('Session à renouveler')).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      await expect(
        fetch('/api/projects', { method: 'POST', body: '{}' }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(network).toHaveBeenCalledTimes(before + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const engine = navigator.userAgent.includes('Chrome')
        ? 'chromium'
        : 'webkit';
      await page.screenshot({
        path: `../../.vitest-screenshots/session-checking-${engine}-${width}.png`,
      });
      pending = false;
      await act(async () => {
        finish(response());
      });
      await waitFor(() => expect(screen.getByRole('textbox')).toBe(input));
      expect(input).toHaveValue('Brouillon conservé pendant la vérification.');
      expect(scroll.scrollTop).toBe(320);
      expect(window.location.href).toBe(href);
      expect(screen.queryByRole('status')).toBeNull();
      expect(
        network.mock.calls.filter(([, init]) => init?.method === 'POST'),
      ).toHaveLength(0);
      await page.screenshot({
        path: `../../.vitest-screenshots/session-ready-${engine}-${width}.png`,
      });
    } finally {
      view.unmount();
      client.clear();
    }
  },
);

test.each([403, 'changed'] as const)(
  'keeps a real %s denial locked and distinct from session expiry',
  async (outcome) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    let reject = false;
    const identity = {
      active: true,
      kind: 'person',
      personId: 'original',
      role: 'administrator',
    };
    const network = vi.spyOn(window, 'fetch').mockImplementation(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input).endsWith('/me')
              ? {
                  ...identity,
                  personId:
                    reject && outcome === 'changed' ? 'other' : 'original',
                }
              : {},
          ),
          {
            status: reject && outcome === 403 ? 403 : 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    dispose = installSessionRecovery();
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <AuthenticatedLayout />
      </QueryClientProvider>,
    );
    try {
      await screen.findByRole('textbox', { name: 'Unsent message' });
      reject = true;
      await act(() => client.refetchQueries({ queryKey: platformSessionKey }));
      await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
      expect(isSessionPaused()).toBe(true);
      expect(screen.getByRole('dialog')).toHaveAccessibleName(
        outcome === 'changed'
          ? 'Identité ou droits modifiés'
          : 'Accès indisponible',
      );
      expect(screen.queryByText('Session à renouveler')).toBeNull();
      const calls = network.mock.calls.length;
      await expect(
        fetch('/api/projects', { method: 'DELETE' }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(network).toHaveBeenCalledTimes(calls);
    } finally {
      view.unmount();
      client.clear();
    }
  },
);

test.each([390, 1180])(
  'does not intercept touch scrolling or reload the workspace at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('en');
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
      query === '(pointer: coarse)'
        ? ({ matches: true } as MediaQueryList)
        : matchMedia(query),
    );
    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      const path = input instanceof Request ? input.url : String(input);
      return new Response(
        JSON.stringify(
          path.endsWith('/me')
            ? {
                active: true,
                kind: 'person',
                personId: 'original',
                name: 'Person',
                role: 'administrator',
              }
            : { maxIdleSubscriptions: 30 },
        ),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <AuthenticatedLayout />
      </QueryClientProvider>,
    );
    try {
      const input = await screen.findByRole('textbox', {
        name: 'Unsent message',
      });
      const target = screen.getByText('Retained conversation');
      const href = window.location.href;
      // Desktop WebKit has no constructible Touch; dispatch the same bubbling
      // touch payload to real DOM listeners without depending on that constructor.
      const touch = (type: string, clientY?: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', {
          value: clientY === undefined ? [] : [{ clientX: 20, clientY }],
        });
        return fireEvent(target, event);
      };
      for (const draft of ['', 'Keep this draft']) {
        fireEvent.change(input, { target: { value: draft } });
        touch('touchstart', 20);
        expect(touch('touchmove', 250)).toBe(true);
        expect(screen.queryByRole('status')).toBeNull();
        touch('touchend');
        expect(screen.getByRole('textbox')).toBe(input);
        expect(input).toHaveValue(draft);
        expect(window.location.href).toBe(href);
      }
      expect(
        getComputedStyle(document.documentElement).overscrollBehaviorY,
      ).toBe('none');
      expect(getComputedStyle(document.body).overscrollBehaviorY).toBe('none');
      await page.screenshot({
        path: `../../.vitest-screenshots/no-pull-to-refresh-${width}.png`,
      });
    } finally {
      view.unmount();
      client.clear();
    }
  },
);

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
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
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
