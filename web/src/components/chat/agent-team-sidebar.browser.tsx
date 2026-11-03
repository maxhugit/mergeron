import { AgentTeamContributions } from '@/components/projects/agent-team-contributions';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { AgentTeamSidebar } from './agent-team-sidebar';
import { teamFixture } from '@/test/agent-team.fixture';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', async (original) => ({
  ...(await original<typeof import('@/lib/projects-api')>()),
  projectsApi: api,
}));
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});
test.each([390, 1280])(
  'team navigation fits %ipx and exposes each mission without starting work',
  async (width) => {
    await page.viewport(width, 988);
    await i18nReady;
    await i18n.changeLanguage('fr');
    document.documentElement.classList.toggle('dark', width === 1280);
    api
      .mockReset()
      .mockImplementation((path: string) =>
        Promise.resolve(
          path.includes('/context?')
            ? { boards: [], deliverables: [], tasks: [], truncated: false }
            : path.includes('?')
              ? { teams: [teamFixture()], launchAvailable: false }
              : teamFixture(),
        ),
      );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <div className="flex h-[850px] min-w-0">
          <AgentTeamSidebar
            projectId="p"
            coordinator="coordinator"
            open
            active
            desktop={width === 1280}
            onClose={() => {}}
          />
        </div>
      </QueryClientProvider>,
    );
    await expect
      .element(
        page.getByText('Recenser les documents existants.', { exact: true }),
      )
      .toBeVisible();
    await page.getByRole('button', { name: /^Exigences/ }).click();
    await expect
      .element(page.getByText('Douze exigences identifiées.', { exact: true }))
      .toBeVisible();
    await page.getByRole('button', { name: /^Vérification/ }).click();
    await expect
      .element(
        page.getByText('Dépend de : Sources, Exigences', { exact: true }),
      )
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(screen.queryByRole('button', { name: /Lancer/ })).toBeNull();
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-team-${width}.png`,
    });
  },
);
test('mobile preparation and confirmation dispatch exactly one reviewed team', async () => {
  await page.viewport(390, 988);
  await i18nReady;
  await i18n.changeLanguage('fr');
  let prepared = false,
    launched = false;
  const draft = {
    ...teamFixture(),
    id: 'prepared',
    state: 'draft',
    canRespond: true,
  };
  api.mockReset().mockImplementation((path: string, options?: RequestInit) => {
    if (path.includes('/context?'))
      return Promise.resolve({
        boards: [],
        deliverables: [],
        tasks: [],
        truncated: false,
      });
    if (path.includes('/profiles'))
      return Promise.resolve([
        {
          key: 'sources',
          role: 'Sources',
          instructions: 'Lire les sources',
          dependencies: [],
        },
      ]);
    if (path.includes('/prepare?')) {
      prepared = true;
      return Promise.resolve(draft);
    }
    if (path.endsWith('/launch')) {
      launched = true;
      return Promise.resolve({ ...draft, state: 'running' });
    }
    if (options?.method === 'POST') throw new Error('Unexpected write');
    if (path.includes('?'))
      return Promise.resolve({
        teams: prepared ? [draft] : [],
        launchAvailable: true,
      });
    return Promise.resolve(draft);
  });
  render(
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
        desktop={false}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
  await page.getByRole('button', { name: 'Préparer une équipe' }).click();
  await page.getByLabelText('Objectif').fill('Préparer le dossier');
  await expect.element(page.getByLabelText('Travail confié')).toBeVisible();
  await page.getByRole('button', { name: 'Préparer le plan' }).click();
  await page.getByRole('button', { name: 'Lancer cette équipe…' }).click();
  await expect
    .element(page.getByRole('dialog', { name: 'Lancer le plan relu ?' }))
    .toBeVisible();
  await Promise.all(
    Array.from(
      document.querySelectorAll(
        '[data-slot="dialog-content"], [data-slot="dialog-overlay"]',
      ),
    ).flatMap((element) =>
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await page.screenshot({
    path: '../../../.vitest-screenshots/agent-team-launch-390.png',
  });
  expect(launched).toBe(false);
  await page.getByRole('button', { name: 'Confirmer le lancement' }).click();
  await expect.poll(() => launched).toBe(true);
  expect(
    api.mock.calls.filter(([path]) => String(path).endsWith('/launch')),
  ).toHaveLength(1);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});
test.each([390, 1280])(
  'business contributions open an older mission and require confirmed task creation at %ipx',
  async (width) => {
    await page.viewport(width, 988);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const team = { ...teamFixture(), state: 'completed', canRespond: true };
    team.assignments = team.assignments.map((assignment) => ({
      ...assignment,
      status: 'completed',
      nativeThreadId: 'child-' + assignment.id,
      result: assignment.result ?? 'Analyse conservée',
    }));
    let created = false;
    api
      .mockReset()
      .mockImplementation((path: string, options?: RequestInit) => {
        if (path.includes('/contributions?'))
          return Promise.resolve({
            teams: [
              {
                id: team.id,
                coordinatorThreadId: team.coordinatorThreadId,
                objective: team.objective,
                state: team.state,
                assignments: team.assignments,
              },
            ],
          });
        if (path.includes('/context?'))
          return Promise.resolve({
            boards: [{ id: 'board', name: 'Travail du projet' }],
            tasks: [],
            deliverables: [],
            truncated: false,
          });
        if (
          path.endsWith('/assignments/requirements/task') &&
          options?.method === 'POST'
        ) {
          created = true;
          team.assignments[1].taskId = 'created';
          return Promise.resolve({ id: 'created' });
        }
        if (path.includes('?'))
          return Promise.resolve({ teams: [], launchAvailable: false });
        return Promise.resolve(team);
      });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AgentTeamContributions projectId="p" taskId="existing-task" />
      </QueryClientProvider>,
    );
    await page
      .getByRole('button', { name: 'Afficher les contributions' })
      .click();
    await page.getByRole('button', { name: 'Voir cette équipe' }).click();
    await page.getByRole('button', { name: /^Exigences/ }).click();
    await page
      .getByRole('button', { name: 'Proposer une nouvelle tâche…' })
      .click();
    await expect
      .element(
        page.getByRole('dialog', { name: 'Proposer une nouvelle tâche…' }),
      )
      .toBeVisible();
    await page.getByLabelText('Titre de la tâche').fill('Relire les exigences');
    expect(created).toBe(false);
    await Promise.all(
      Array.from(
        document.querySelectorAll(
          '[data-slot="dialog-content"], [data-slot="dialog-overlay"]',
        ),
      ).flatMap((element) =>
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-team-task-${width}.png`,
    });
    await page
      .getByRole('button', { name: 'Créer la tâche confirmée' })
      .click();
    await expect.poll(() => created).toBe(true);
    expect(
      api.mock.calls.filter(([path]) =>
        String(path).endsWith('/assignments/requirements/task'),
      ),
    ).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);
test('unsaved draft business links block launch until explicitly saved', async () => {
  await page.viewport(1280, 988);
  await i18nReady;
  await i18n.changeLanguage('fr');
  const team = {
    ...teamFixture(),
    state: 'draft',
    origin: 'planned',
    nativeTurnId: null,
    canRespond: true,
  };
  api.mockReset().mockImplementation((path: string, options?: RequestInit) => {
    if (path.includes('/context?'))
      return Promise.resolve({
        boards: [],
        tasks: [],
        deliverables: [{ id: 'deliverable', title: 'Dossier du projet' }],
        truncated: false,
      });
    if (path.endsWith('/links') && options?.method === 'PUT') {
      team.deliverableId = 'deliverable';
      return Promise.resolve(team);
    }
    if (path.includes('?'))
      return Promise.resolve({ teams: [team], launchAvailable: false });
    return Promise.resolve(team);
  });
  render(
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
      />
    </QueryClientProvider>,
  );
  await page
    .getByRole('combobox', { name: /^Livrable associé/ })
    .selectOptions('deliverable');
  await expect
    .element(page.getByRole('button', { name: 'Lancer cette équipe…' }))
    .toBeDisabled();
  await page
    .getByRole('button', { name: 'Enregistrer les rattachements' })
    .click();
  await expect
    .element(page.getByRole('button', { name: 'Lancer cette équipe…' }))
    .toBeEnabled();
  expect(
    api.mock.calls.some(([path]) => String(path).endsWith('/launch')),
  ).toBe(false);
});
