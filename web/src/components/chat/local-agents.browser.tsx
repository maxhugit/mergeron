import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { LocalAgentsSettings } from '../settings/local-agents-settings';
import { LocalAgentDialog } from './local-agent-dialog';
import type { WorkspaceGroup } from './sidebar/sidebar-types';
import { localAgentModelsKey } from '@/lib/local-agents';
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
});

test('configures local inference and creates only an available local agent on desktop and mobile', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  document.documentElement.classList.add('dark');
  let saved = {
    enabled: true,
    url: 'http://192.168.1.10:11434',
    models: 'gpt-oss:local',
    context: 16384,
  };
  let available = true;
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/configuration')) {
        if (init?.method === 'PUT') {
          saved = JSON.parse(init.body as string);
          writes.push(saved);
        }
        return Response.json(saved);
      }
      if (url.endsWith('/models'))
        return Response.json({
          available,
          error: available ? null : 'LOCAL_OLLAMA_UNAVAILABLE',
          data: available
            ? [
                {
                  id: 'ollama:local',
                  model: 'ollama:local',
                  displayName: 'Ollama · gpt-oss:local',
                },
              ]
            : [],
        });
      throw new Error('Unexpected fixture request');
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <main className="min-h-dvh bg-background p-4 text-foreground">
        <div className="mx-auto max-w-3xl">{children}</div>
      </main>
    </QueryClientProvider>
  );
  const mounted = render(<LocalAgentsSettings />, { wrapper });
  await screen.findByRole('heading', { name: 'Agents locaux · Ollama' });
  fireEvent.change(screen.getByLabelText('URL privée d’Ollama'), {
    target: { value: 'http://192.168.1.20:11434' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await screen.findByText('Configuration des agents locaux enregistrée.');
  expect(writes).toEqual([{ ...saved, url: 'http://192.168.1.20:11434' }]);
  for (const width of [1280, 390]) {
    await page.viewport(width, 900);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    for (const element of document.querySelectorAll('input, button'))
      expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/local-settings-${width}.png`,
    });
  }
  mounted.unmount();
  const create = vi.fn();
  const group = {
    cwd: '/work/project',
    projectId: 'project',
    workspaces: [
      { id: 'w', path: '/work/project', name: 'Sources', primary: true },
    ],
  } as WorkspaceGroup;
  render(
    <LocalAgentDialog
      group={group}
      pending={false}
      onClose={vi.fn()}
      onCreate={create}
    />,
    { wrapper },
  );
  const button = await screen.findByRole('button', {
    name: 'Créer un agent local',
  });
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.getByRole('combobox', { name: 'Modèle' })).toHaveValue(
    'ollama:local',
  );
  for (const width of [1280, 390]) {
    await page.viewport(width, 900);
    const bounds = screen.getByRole('dialog').getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/local-create-${width}.png`,
    });
  }
  fireEvent.click(button);
  expect(create).toHaveBeenCalledExactlyOnceWith({
    workspacePath: '/work/project',
    model: 'ollama:local',
  });
  available = false;
  await client.invalidateQueries({ queryKey: localAgentModelsKey });
  await waitFor(() => expect(button).toBeDisabled());
  expect(screen.getByRole('alert')).toHaveTextContent('Aucun modèle cloud');
});
