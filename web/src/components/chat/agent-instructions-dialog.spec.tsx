import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n, { i18nReady } from '@/i18n';
import { AgentInstructionsDialog } from './agent-instructions-dialog';
import { AgentInstructionsButton } from './agent-instructions-button';
vi.mock('@/lib/project-locations-api', () => ({
  getProjectLocations: async () => ({ copies: [] }),
}));
import { ProfileAgentInstructions } from '@/components/account/profile-agent-instructions';
import type { AgentContextStatus } from '@/lib/agent-context-api';
import type { ProjectWorkspaceCopySummary } from '@/lib/projects-api';
const api = vi.hoisted(() => ({
  set: vi.fn(),
  verify: vi.fn(),
  saveProfile: vi.fn(),
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: { kind: 'person', personId: 'person', role: 'administrator' },
  }),
}));
vi.mock('@/lib/agent-context-api', () => ({
  agentContextKey: (thread: string, person: string) => [
    'agent-context',
    person,
    thread,
  ],
  getAgentContext: async () => ({
    threadId: 'agent',
    copyId: null,
    version: 2,
    events: [],
  }),
  setAgentInstructionSource: api.set,
  verifyAgentContext: api.verify,
  getAgentPreferences: async () => ({
    personId: 'person',
    instructions: '',
    language: 'message',
  }),
  setAgentPreferences: api.saveProfile,
  previewGitInstructions: async () => ({
    files: [{ path: 'AGENTS.md', text: 'Repository policy' }],
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const copy = {
  id: 'copy',
  ownerThreadIds: ['agent'],
  sourceResourceId: 'source',
  name: 'Mergeron — copie locale',
  branch: 'main',
  sourceEnabled: true,
  sourceType: 'git',
  state: 'ready',
} as ProjectWorkspaceCopySummary;
function mount(element: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      {element}
    </QueryClientProvider>,
  );
}
it('associates an explicit copy with its expected version and keeps verification separate from supply', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  const checked: AgentContextStatus = {
    threadId: 'agent',
    copyId: 'copy',
    version: 3,
    events: [
      {
        id: 'e',
        trigger: 'manual',
        state: 'verified',
        revision: 'a',
        sources: [
          {
            kind: 'git',
            revision: 'a'.repeat(64),
            files: ['AGENTS.md'],
            commit: 'c'.repeat(40),
          },
        ],
        createdAt: 1000,
      },
    ],
  };
  api.set.mockResolvedValue(checked);
  api.verify.mockResolvedValue(checked);
  mount(
    <AgentInstructionsDialog
      threadId="agent"
      copies={[copy]}
      open
      onOpenChange={() => {}}
    />,
  );
  const selection = await screen.findByRole('combobox', {
    name: 'Copie Git de consignes',
  });
  fireEvent.change(selection, { target: { value: 'copy' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Appliquer à cet agent' }),
  );
  await waitFor(() => expect(api.set).toHaveBeenCalledWith('agent', 'copy', 2));
  expect(
    await screen.findByText(/^Vérifié, pas encore fourni ·/),
  ).toBeVisible();
  expect(screen.queryByText(/^Fourni à l’agent ·/)).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Voir les consignes Git actuelles' }),
  );
  expect(await screen.findByText('Repository policy')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Vérifier maintenant' }));
  await waitFor(() => expect(api.verify).toHaveBeenCalledWith('agent'));
});
it('lists only ready Git copies accessible to this agent, excluding foreign and unknown ownership', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  mount(
    <AgentInstructionsDialog
      threadId="agent"
      copies={[
        copy,
        { ...copy, id: 'foreign', ownerThreadIds: ['another-agent'] },
        { ...copy, id: 'unknown', ownerThreadIds: undefined },
        { ...copy, id: 'disabled', sourceEnabled: false },
      ]}
      open
      onOpenChange={() => {}}
    />,
  );
  await screen.findByRole('combobox', { name: 'Copie Git de consignes' });
  const options = screen.getAllByRole('option');
  expect(options.map((option) => (option as HTMLOptionElement).value)).toEqual([
    '',
    'copy',
  ]);
});

it('saves preferences for the authenticated profile with language and allows cancellation', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.saveProfile.mockResolvedValue({
    personId: 'person',
    instructions: 'Concis',
    language: 'fr',
  });
  mount(<ProfileAgentInstructions />);
  const field = await screen.findByRole('textbox', {
    name: 'Préférences personnelles',
  });
  fireEvent.change(field, { target: { value: 'À annuler' } });
  fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  expect(field).toHaveValue('');
  fireEvent.change(field, { target: { value: 'Concis' } });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fr' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() =>
    expect(api.saveProfile).toHaveBeenCalledWith(
      { personId: 'person', instructions: 'Concis', language: 'fr' },
      expect.anything(),
    ),
  );
});

it('opens and verifies instructions from the toolbar without any Git copy', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.verify.mockResolvedValue({
    threadId: 'agent',
    copyId: null,
    version: 2,
    events: [],
  });
  mount(<AgentInstructionsButton threadId="agent" projectId="project" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Consignes de cet agent' }),
  );
  expect(await screen.findByRole('dialog')).toBeVisible();
  expect(await screen.findAllByRole('option')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Vérifier maintenant' }));
  await waitFor(() => expect(api.verify).toHaveBeenCalledWith('agent'));
});
