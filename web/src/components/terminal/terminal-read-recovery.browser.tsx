/** Real discovery/store/toasts, synthetic socket only: no shell, server or user data. */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useTerminalDiscovery } from '@/hooks/use-terminal-discovery';
import { useTerminalSocketEvents } from '@/hooks/use-terminal-socket';
import { SnackbarContainer } from '@/components/snackbar/snackbar-container';
import { useSnackbarStore } from '@/stores/snackbar-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useTerminalViewStore } from '@/stores/terminal-view-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type { TerminalAck } from '@/types/terminal';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

type Request = {
  event: string;
  reply: (error: Error | null, response?: TerminalAck) => void;
};
const wire = vi.hoisted(() => ({
  id: 'initial',
  connected: true,
  emit: vi.fn(),
  listeners: new Map<string, Set<() => void>>(),
  requests: [] as Request[],
}));
vi.mock('@/socket', () => {
  const socket = {
    get id() {
      return wire.id;
    },
    get connected() {
      return wire.connected;
    },
    emit: wire.emit,
    sendBuffer: [],
    on: (name: string, listener: () => void) => {
      const listeners = wire.listeners.get(name) ?? new Set();
      listeners.add(listener);
      wire.listeners.set(name, listeners);
    },
    off: (name: string, listener: () => void) =>
      wire.listeners.get(name)?.delete(listener),
    timeout: () => ({
      emit: (event: string, payload: unknown, reply: Request['reply']) => {
        wire.emit(event, payload);
        wire.requests.push({ event, reply });
      },
    }),
  };
  return { getSocket: () => socket };
});

export function ReadStatus() {
  useTerminalSocketEvents();
  useTerminalDiscovery('thread:synthetic');
  const hydrated = useTerminalStore(
    (state) => state.contexts['thread:synthetic']?.hydrated,
  );
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <h1 className="mb-4 text-xl font-semibold">
        Terminal — vérification de reconnexion
      </h1>
      <p>Sessions existantes uniquement. Aucune commande exécutée.</p>
      <output
        className="mt-6 block rounded-lg border p-4"
        aria-label="État des sessions"
      >
        {hydrated
          ? 'Sessions du terminal synchronisées'
          : 'Lecture des sessions…'}
      </output>
      <SnackbarContainer />
    </main>
  );
}
const initial = useTerminalStore.getState();
const take = (event: string) => {
  const index = wire.requests.findIndex((request) => request.event === event);
  expect(index).toBeGreaterThanOrEqual(0);
  return wire.requests.splice(index, 1)[0];
};
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  useTerminalStore.setState(initial, true);
  // A previous config read was interrupted; the mounted host resumes only
  // requested reads, never introducing terminal access in unrelated views.
  useTerminalStore.setState({ configRequested: true });
  useTerminalViewStore.setState({
    retained: {},
    target: null,
    contextEpochs: {},
  });
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  useSnackbarStore.getState().clear();
  wire.id = 'initial';
  wire.connected = true;
  wire.requests = [];
  wire.listeners.clear();
  wire.emit.mockClear();
});
afterEach(() => {
  cleanup();
  useSnackbarStore.getState().clear();
});

test.each([1100, 390])(
  'keeps reconnect quiet but real refusals visible at %ipx',
  async (width) => {
    await page.viewport(width, 800);
    render(<ReadStatus />);
    const oldConfig = take('terminal.config');
    const oldList = take('terminal.list');
    const config = {
      maxSessions: 10,
      graceMs: 45000,
      scrollback: 5000,
      defaultCwd: null,
    };
    await act(async () => {
      wire.id = 'reconnected';
      for (const listener of wire.listeners.get('connect') ?? []) listener();
      take('terminal.config').reply(null, { ok: true, config });
      take('terminal.list').reply(null, { ok: true, terminals: [], config });
      oldConfig.reply(new Error('old connection closed'));
      oldList.reply(new Error('old connection closed'));
    });
    expect(screen.getByLabelText('État des sessions')).toHaveTextContent(
      'Sessions du terminal synchronisées',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(useSnackbarStore.getState().visible).toEqual([]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(
      wire.emit.mock.calls.every(([event]) =>
        ['terminal.config', 'terminal.list'].includes(event as string),
      ),
    ).toBe(true);
    const engine = navigator.userAgent.includes('Chrome')
      ? 'chromium'
      : 'webkit';
    await page.screenshot({
      path: `../../../.vitest-screenshots/terminal-read-recovery-${engine}-${width}.png`,
    });
    await act(async () => {
      const read = useTerminalStore.getState().listContext('thread:synthetic');
      take('terminal.list').reply(null, {
        ok: false,
        errorCode: 'auth.forbidden',
        error: 'Accès au terminal refusé',
      });
      await read;
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Accès au terminal refusé',
    );
    expect(useSnackbarStore.getState().visible[0]?.severity).toBe('error');
    // Wait for the real toast's entry animation, so evidence includes the
    // complete alert rather than its transient off-screen starting position.
    await vi.waitFor(() => {
      const bounds = screen.getByRole('alert').getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeCloseTo(width - 16, 0);
    });
    await page.screenshot({
      path: `../../../.vitest-screenshots/terminal-read-refusal-${engine}-${width}.png`,
    });
  },
);
