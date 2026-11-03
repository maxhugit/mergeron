import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentTeamBusinessContext } from './agent-team-business-context';
import { teamFixture } from '@/test/agent-team.fixture';
import i18n, { i18nReady } from '@/i18n';
const api = vi.hoisted(() => ({
  context: vi.fn(),
  save: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@/lib/agent-teams-api', async (original) => ({
  ...(await original<typeof import('@/lib/agent-teams-api')>()),
  readTeamContext: api.context,
  saveTeamLinks: api.save,
  createTaskFromContribution: api.create,
}));
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  vi.clearAllMocks();
  api.context.mockResolvedValue({
    boards: [{ id: 'board', name: 'Travail' }],
    tasks: [{ id: 'task', title: 'Tâche existante', resourceId: 'board' }],
    deliverables: [{ id: 'deliverable', title: 'Dossier' }],
    truncated: false,
  });
  api.save.mockResolvedValue(teamFixture());
  api.create.mockResolvedValue({ id: 'created' });
});
afterEach(cleanup);
function mount(draft = false) {
  const team = {
    ...teamFixture(),
    state: draft ? ('draft' as const) : ('completed' as const),
    canRespond: true,
  };
  const changed = vi.fn(),
    dirty = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AgentTeamBusinessContext
        projectId="p"
        team={team}
        assignmentId={team.assignments[1].id}
        active
        onChanged={changed}
        onDirtyChange={dirty}
      />
    </QueryClientProvider>,
  );
  return { changed, dirty, team };
}
it('saves reviewed draft links explicitly and marks unsaved selections', async () => {
  const { dirty } = mount(true);
  fireEvent.change(await screen.findByLabelText('Livrable associé'), {
    target: { value: 'deliverable' },
  });
  expect(api.save).not.toHaveBeenCalled();
  expect(dirty).toHaveBeenCalledWith(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Enregistrer les rattachements' }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Rattachements enregistrés',
  );
  expect(api.save).toHaveBeenCalledWith(
    'p',
    'team',
    expect.objectContaining({ deliverableId: 'deliverable' }),
  );
});
it('creates no task until the editable proposal is explicitly confirmed', async () => {
  const { changed } = mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Proposer une nouvelle tâche…' }),
  );
  expect(api.create).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Description à enregistrer')).toHaveValue(
    'Douze exigences identifiées.',
  );
  fireEvent.change(screen.getByLabelText('Titre de la tâche'), {
    target: { value: 'Relire les exigences' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Créer la tâche confirmée' }),
  );
  await screen.findByRole('button', { name: 'Proposer une nouvelle tâche…' });
  expect(api.create).toHaveBeenCalledWith('p', 'team', 'requirements', {
    confirmed: true,
    resourceId: 'board',
    title: 'Relire les exigences',
    description: 'Douze exigences identifiées.',
  });
  expect(changed).toHaveBeenCalledTimes(1);
});
