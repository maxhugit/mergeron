/** Actual links and popover with a controlled project HTTP boundary. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { AgentContextLinks } from './agent-context-links';
import type { ProjectSummary } from '@/lib/projects-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', async (original) => ({
  ...(await original<typeof import('@/lib/projects-api')>()),
  projectsApi: api,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
vi.mock('@/components/projects/project-task-manager', () => ({
  ProjectTaskManager: ({ initialTaskId }: { initialTaskId: string }) => (
    <div role="dialog" aria-label={initialTaskId}>
      Sous-tâche sélectionnée
    </div>
  ),
}));
vi.mock('@/components/projects/project-deliverables-manager', () => ({
  ProjectDeliverablesManager: ({
    initialDeliverableId,
  }: {
    initialDeliverableId: string;
  }) => (
    <div role="dialog" aria-label={initialDeliverableId}>
      Livrable sélectionné
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  api.mockReset();
  document.documentElement.classList.remove('dark');
});
test.each([390, 1280])(
  'keeps links on one line, shows global counts and opens assigned subtasks at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const project = {
      id: 'p',
      resources: [{ id: 'd', type: 'deliverable_board' }],
      agentThreads: [
        { threadId: 'agent', taskId: 'sub-0', taskResourceId: 'tasks' },
      ],
    } as ProjectSummary;
    const tasks = [
      {
        id: 'main',
        resourceId: 'tasks',
        title: 'Cadrer les objectifs et les usages du site du club',
        parentTaskId: null,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `sub-${index}`,
        updatedAt: 7,
        resourceId: 'tasks',
        title:
          [
            'Identifier et caractériser les publics du site',
            'Formaliser les problèmes à résoudre',
            'Décrire et prioriser les usages du site',
          ][index] ?? `Autre sous-tâche ${index}`,
        parentTaskId: 'main',
        linkedThreadId: index < 3 ? 'agent' : null,
        progress: index === 0 || index === 7 ? 100 : index === 1 ? 40 : 0,
        subtaskStatus:
          index === 0 || index === 7
            ? 'done'
            : index === 1
              ? 'started'
              : 'todo',
      })),
    ];
    const data = {
      tasks,
      deliverables: [
        {
          id: 'report',
          title: 'Cadrage du site BBCC — questions, réponses et décisions',
          primaryTaskId: 'main',
          directory: '/work/livrables/report',
          linkedAgentIds: ['agent'],
          conversations: [],
        },
      ],
    };
    api.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const task = tasks.find((task) => task.id === path.split('/').at(-1))!;
        Object.assign(task, JSON.parse(String(init.body)));
      }
      return Promise.resolve(structuredClone(data));
    });
    const folder = vi.fn();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <div style={{ minHeight: 720 }}>
          <AgentContextLinks
            threadId="agent"
            project={project}
            loading={false}
            failed={false}
            onOpenDirectory={folder}
          />
          <div className="p-6 text-sm">Conversation de l’agent</div>
        </div>
      </QueryClientProvider>,
    );
    const title = await screen.findByRole('button', {
      name: 'Cadrage du site BBCC — questions, réponses et décisions',
    });
    const triggerName =
      '2 sous-tâches terminées sur 8 dans la tâche principale ; 3 affectées à cet agent';
    const trigger = screen.getByRole('button', { name: triggerName });
    const folderButton = screen.getByRole('button', {
      name: /Ouvrir le dossier du livrable/,
    });
    expect(title.parentElement).toContainElement(folderButton);
    expect(
      Math.abs(
        title.getBoundingClientRect().top - trigger.getBoundingClientRect().top,
      ),
    ).toBeLessThan(3);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page
      .getByRole('button', { name: /Ouvrir le dossier du livrable/ })
      .click();
    expect(folder).toHaveBeenCalledWith('/work/livrables/report');
    expect(screen.queryByRole('dialog')).toBeNull();
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-context-line-${width}.png`,
    });
    await page.getByRole('button', { name: triggerName }).click();
    expect(
      await screen.findByText(
        '2 terminées sur 8 sous-tâches dans la tâche principale',
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Identifier et caractériser/ }),
    ).toHaveTextContent('100 %');
    expect(
      screen.getByRole('button', { name: /Formaliser les problèmes/ }),
    ).toHaveTextContent('40 %');
    expect(
      screen.queryByRole('button', { name: /Autre sous-tâche/ }),
    ).toBeNull();
    const percentage = screen.getByRole('spinbutton', {
      name: 'Pourcentage de Formaliser les problèmes à résoudre',
    });
    fireEvent.change(percentage, { target: { value: '65' } });
    const group = percentage.closest('[role=group]')!;
    fireEvent.click(group.querySelector('button')!);
    await expect
      .poll(
        () =>
          screen.getByRole('button', { name: /Formaliser les problèmes/ })
            .textContent,
      )
      .toContain('65 %');
    expect(api).toHaveBeenCalledWith('/p/resources/tasks/tasks/sub-1', {
      method: 'PATCH',
      body: JSON.stringify({ progress: 65, expectedUpdatedAt: 7 }),
    });
    await expect
      .poll(
        () =>
          getComputedStyle(
            screen
              .getByText('Tâche principale')
              .closest('[data-slot=popover-content]')!,
          ).opacity,
      )
      .toBe('1');
    document.documentElement.classList.add('dark');
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-context-menu-${width}.png`,
    });
    await page
      .getByRole('button', { name: /Formaliser les problèmes/ })
      .click();
    expect(await screen.findByRole('dialog', { name: 'sub-1' })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);
