import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServerCapabilities } from './server-capabilities';
import i18n, { i18nReady } from '@/i18n';
const empty = {
  capabilities: [
    { id: 'browser', installed: false, state: 'notInstalled', activeLeases: 0 },
    { id: 'transcription', installed: true, state: 'stopped', activeLeases: 0 },
  ],
  operation: null,
  error: null,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function mount(value = empty) {
  await i18nReady;
  await i18n.changeLanguage('fr');
  const fetcher = vi
    .fn()
    .mockImplementation(
      async (_url: string, options?: RequestInit) =>
        new Response(
          JSON.stringify(
            options?.method === 'POST'
              ? { ...value, operation: { id: 'browser', action: 'install' } }
              : value,
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
  vi.stubGlobal('fetch', fetcher);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServerCapabilities />
    </QueryClientProvider>,
  );
  await screen.findByText('Navigation web');
  return fetcher;
}
test('no mutation before confirmation; exact catalogue action and current state displayed', async () => {
  const fetcher = await mount();
  expect(screen.getByText('Non installée')).toBeTruthy();
  expect(screen.getByText('Installée — démarrage à la demande')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Installer' }));
  expect(fetcher.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        (c) =>
          c[1]?.body ===
          JSON.stringify({
            id: 'browser',
            action: 'install',
            confirmation: 'install:browser',
          }),
      ),
    ).toBe(true),
  );
});
test('active leases disable uninstall and explain the refusal', async () => {
  await mount({
    ...empty,
    capabilities: [
      { id: 'browser', installed: true, state: 'ready', activeLeases: 1 },
    ],
  });
  expect(
    (screen.getByRole('button', { name: 'Désinstaller' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/Terminez les sessions/)).toBeTruthy();
});
