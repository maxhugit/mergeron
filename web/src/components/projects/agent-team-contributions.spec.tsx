import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentTeamContributions } from './agent-team-contributions';
import i18n, { i18nReady } from '@/i18n';
const read = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent-teams-api', async (original) => ({
  ...(await original<typeof import('@/lib/agent-teams-api')>()),
  readTeamContributions: read,
}));
vi.mock('@/components/chat/agent-team-sidebar', () => ({
  AgentTeamSidebar: ({ initialTeamId }: { initialTeamId: string }) => (
    <p>Équipe ouverte : {initialTeamId}</p>
  ),
}));
afterEach(cleanup);
it('loads contributions on demand and opens the exact linked mission', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  read
    .mockReset()
    .mockResolvedValue({
      teams: [
        {
          id: 'old-team',
          coordinatorThreadId: 'parent',
          objective: 'Dossier',
          state: 'completed',
          assignments: [
            {
              id: 'a',
              role: 'Sources',
              status: 'completed',
              result: '<script>texte sûr</script>',
            },
          ],
        },
      ],
    });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentTeamContributions projectId="p" taskId="task" />
    </QueryClientProvider>,
  );
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Afficher les contributions' }),
  );
  expect(
    await screen.findByText('<script>texte sûr</script>'),
  ).toBeInTheDocument();
  expect(read).toHaveBeenCalledWith(
    'p',
    { taskId: 'task' },
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Voir cette équipe' }));
  expect(
    await screen.findByText('Équipe ouverte : old-team'),
  ).toBeInTheDocument();
});
