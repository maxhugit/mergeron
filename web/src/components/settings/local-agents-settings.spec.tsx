import { SettingsPanel } from './settings-panel';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { LocalAgentsSettings } from './local-agents-settings';
import {
  localAgentsApi,
  type LocalAgentConfiguration,
} from '@/lib/local-agents';
const restart = vi.hoisted(() => vi.fn());
vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  catalogRestartMutation: () => ({ mutationFn: restart }),
}));
vi.mock('@/lib/local-agents', async (original) => ({
  ...(await original<typeof import('@/lib/local-agents')>()),
  localAgentsApi: vi.fn(),
}));
let config: LocalAgentConfiguration;
let client: QueryClient;
beforeEach(async () => {
  await i18n.changeLanguage('fr');
  config = {
    enabled: true,
    url: 'http://127.0.0.1:11434',
    models: 'gpt-oss:mergeron-dev-20b',
    context: 16384,
    metadataRestartRequired: true,
  };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  restart.mockReset().mockImplementation(async () => {
    config = { ...config, metadataRestartRequired: false };
    return {};
  });
  vi.mocked(localAgentsApi)
    .mockReset()
    .mockImplementation(async (path, body) => {
      if (path === 'models') return { data: [], available: false, error: null };
      if (body)
        config = {
          ...(body as LocalAgentConfiguration),
          metadataRestartRequired: true,
        };
      return config;
    });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function show() {
  return render(
    <QueryClientProvider client={client}>
      <LocalAgentsSettings />
    </QueryClientProvider>,
  );
}
it('requires an explicit restart click after changing local metadata', async () => {
  show();
  const button = await screen.findByRole('button', {
    name: 'Redémarrer Codex',
  });
  expect(restart).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Redémarrer Codex' }),
    ).toBeNull(),
  );
  expect(restart).toHaveBeenCalledTimes(1);
});
it('keeps the pending configuration visible when the guarded restart is blocked', async () => {
  restart.mockRejectedValue(new Error('Active turn'));
  show();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Redémarrer Codex' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'approbations en attente',
  );
  expect(config.metadataRestartRequired).toBe(true);
  expect(restart).toHaveBeenCalledTimes(1);
});
it('never submits the derived restart flag as a setting', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Enregistrer' }));
  await waitFor(() =>
    expect(localAgentsApi).toHaveBeenCalledWith('configuration', {
      enabled: true,
      url: config.url,
      models: config.models,
      context: 16384,
    }),
  );
});

it('submits the same configuration from the panel footer outside the form', async () => {
  render(
    <QueryClientProvider client={client}>
      <SettingsPanel heading={<h2>Local settings</h2>}>
        <LocalAgentsSettings />
      </SettingsPanel>
    </QueryClientProvider>,
  );
  const button = await screen.findByRole('button', { name: 'Enregistrer' });
  const form = document.querySelector('form')!;
  expect(button.closest('[data-settings-actions]')).not.toBeNull();
  expect(form.contains(button)).toBe(false);
  expect(button).toHaveAttribute('form', form.id);
  fireEvent.click(button);
  await waitFor(() =>
    expect(localAgentsApi).toHaveBeenCalledWith('configuration', {
      enabled: true,
      url: config.url,
      models: config.models,
      context: 16384,
    }),
  );
});
