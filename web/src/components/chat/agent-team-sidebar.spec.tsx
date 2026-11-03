import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentTeamSidebar } from './agent-team-sidebar';
import { teamFixture } from '@/test/agent-team.fixture';
import i18n, { i18nReady } from '@/i18n';
const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/agent-teams-api', async (original) => ({
  ...(await original<typeof import('@/lib/agent-teams-api')>()),
  listAgentTeams: api.list,
  readAgentTeam: api.read,
}));
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.list
    .mockReset()
    .mockResolvedValue({ teams: [teamFixture()], launchAvailable: false });
  api.read.mockReset().mockResolvedValue(teamFixture());
});
afterEach(cleanup);
function mount(
  props: Partial<React.ComponentProps<typeof AgentTeamSidebar>> = {},
) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AgentTeamSidebar
        projectId="p"
        coordinator="coordinator"
        open
        active
        desktop
        onClose={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}
it('shows explicit dependencies and reads each selected agent result', async () => {
  mount();
  expect(
    await screen.findByText('Recenser les documents existants.'),
  ).toBeInTheDocument();
  expect(screen.getByText('Attend les dépendances')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Exigences/ }));
  expect(
    await screen.findByText('Douze exigences identifiées.'),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Vérification/ }));
  expect(
    screen.getByText('Dépend de : Sources, Exigences'),
  ).toBeInTheDocument();
  expect(api.list).toHaveBeenCalledWith(
    'p',
    'coordinator',
    expect.any(AbortSignal),
  );
});
it('does not load hidden or inactive team panels', () => {
  mount({ active: false });
  expect(api.list).not.toHaveBeenCalled();
  expect(api.read).not.toHaveBeenCalled();
});
it('shows a read failure instead of presenting absent data as a completed mission', async () => {
  api.list.mockRejectedValue(new Error('Project access denied'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Project access denied',
  );
  expect(
    screen.queryByText('Recenser les documents existants.'),
  ).not.toBeInTheDocument();
});
it('renders agent-supplied output as text without executable markup', async () => {
  const team = teamFixture();
  team.assignments[0].result = '<img src=x onerror=alert(1)>';
  api.read.mockResolvedValue(team);
  mount();
  expect(
    await screen.findByText('<img src=x onerror=alert(1)>'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
