import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentTeamPrepare } from './agent-team-prepare';
import i18n, { i18nReady } from '@/i18n';
const api = vi.hoisted(() => ({
  profiles: vi.fn(),
  save: vi.fn(),
  prepare: vi.fn(),
  launch: vi.fn(),
}));
vi.mock('@/lib/agent-teams-api', async (original) => ({
  ...(await original<typeof import('@/lib/agent-teams-api')>()),
  readTeamProfiles: api.profiles,
  saveTeamProfiles: api.save,
  prepareAgentTeam: api.prepare,
  launchAgentTeam: api.launch,
}));
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  vi.clearAllMocks();
  api.profiles.mockResolvedValue([
    {
      key: 'read',
      role: 'Sources',
      instructions: 'Lire les sources',
      dependencies: [],
    },
  ]);
  api.prepare.mockResolvedValue({ id: 'prepared' });
  api.save.mockResolvedValue([]);
});
afterEach(cleanup);
it('prepares a stable reviewed plan without dispatching any native work', async () => {
  const prepared = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentTeamPrepare projectId="p" coordinator="c" onPrepared={prepared} />
    </QueryClientProvider>,
  );
  expect(api.profiles).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Préparer une équipe' }));
  await screen.findByDisplayValue('Lire les sources');
  fireEvent.change(screen.getByLabelText('Objectif'), {
    target: { value: 'Préparer le dossier' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Préparer le plan' }));
  await screen.findByRole('button', { name: 'Préparer une équipe' });
  expect(prepared).toHaveBeenCalledWith('prepared');
  expect(api.prepare).toHaveBeenCalledWith(
    'p',
    'c',
    expect.objectContaining({
      objective: 'Préparer le dossier',
      requestId: expect.any(String),
      profiles: [
        expect.objectContaining({
          key: 'read',
          instructions: 'Lire les sources',
        }),
      ],
    }),
  );
  expect(api.launch).not.toHaveBeenCalled();
});
