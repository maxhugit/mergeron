import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentTeamActions } from './agent-team-actions';
import { teamFixture } from '@/test/agent-team.fixture';
import i18n, { i18nReady } from '@/i18n';
const api = vi.hoisted(() => ({ control: vi.fn(), history: vi.fn() }));
vi.mock('@/lib/agent-teams-api', async (original) => ({
  ...(await original<typeof import('@/lib/agent-teams-api')>()),
  controlAgentTeam: api.control,
  readTeamHistory: api.history,
}));
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.control.mockReset().mockResolvedValue(teamFixture());
  api.history
    .mockReset()
    .mockResolvedValue({
      messages: [{ id: 'message', role: 'agent', text: 'Résultat conservé' }],
      nextCursor: null,
    });
});
afterEach(cleanup);
function mount(canRespond = true) {
  const team = { ...teamFixture(), canRespond };
  const changed = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AgentTeamActions
        projectId="p"
        team={team}
        assignmentId={team.assignments[0].id}
        onChanged={changed}
      />
    </QueryClientProvider>,
  );
  return changed;
}
it('requires explicit confirmation and never retries an uncertain stop', async () => {
  api.control.mockRejectedValue(new Error('Connection interrupted'));
  mount();
  expect(api.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Arrêter l’équipe…' }));
  expect(api.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Arrêter le travail' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Connection interrupted',
  );
  expect(api.control).toHaveBeenCalledTimes(1);
  expect(api.control).toHaveBeenCalledWith('p', teamFixture().id, 'stop');
});
it('keeps controls unavailable to readers', () => {
  mount(false);
  expect(
    screen.queryByRole('button', { name: 'Arrêter l’équipe…' }),
  ).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Vérifier l’état réel' }),
  ).toBeNull();
});
it('only loads child history after an explicit request', async () => {
  mount();
  expect(api.history).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Voir les messages de l’agent' }),
  );
  expect(await screen.findByText('Résultat conservé')).toBeInTheDocument();
  expect(api.history).toHaveBeenCalledWith(
    'p',
    teamFixture().id,
    teamFixture().assignments[0].id,
    null,
    expect.any(AbortSignal),
  );
});
