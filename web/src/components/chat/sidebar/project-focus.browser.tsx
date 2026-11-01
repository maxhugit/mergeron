import { useState } from 'react';
import { DragDropProvider } from '@dnd-kit/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { page, commands } from 'vitest/browser';
import { WorkspaceOverview } from './workspace-overview';
import { ThreadRow } from './thread-row';
import { ProjectsMenu } from './projects-menu';
import { ProjectArchivedAgents } from '@/components/projects/project-archived-agents';
import { useAgentViewCacheStore } from '@/stores/agent-view-cache-store';
import { focusProject, focusThreads } from '@/test-fixtures/project-focus';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

export function Fixture() {
  const [focused, setFocused] = useState(false);
  const [archives, setArchives] = useState(false);
  const [order, setOrder] = useState([
    'resource:tasks',
    ...focusThreads.map((thread) => `agent:${thread.id}`),
  ]);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const group = {
    projectId: focusProject.id,
    cwd: focusProject.workspacePath,
    name: focusProject.name,
    threads: focusThreads,
    simpleChats: [],
    resources: focusProject.resources,
    archivedAgents: focusProject.agentThreads,
    sidebarOrder: order,
  };
  return (
    <div className="flex h-[680px] min-h-0 bg-background text-foreground">
      <aside
        className={`w-64 shrink-0 overflow-auto border-r bg-card p-2${archives ? ' max-md:hidden' : ''}`}
        aria-label="Sidebar fixture"
      >
        <DragDropProvider
          onDragEnd={(event) => {
            if (event.canceled) return;
            const source = event.operation.source?.data?.sidebarItemId as
              | string
              | undefined;
            const target = event.operation.target?.data?.sidebarItemId as
              | string
              | undefined;
            if (!source || !target) return;
            setOrder((current) => {
              const next = current.filter((id) => id !== source);
              next.splice(next.indexOf(target), 0, source);
              return next;
            });
          }}
        >
          <WorkspaceOverview
            focusedProjectId={focused ? group.projectId : null}
            projectsHeader={
              focused ? (
                <button type="button" onClick={() => setFocused(false)}>
                  All projects
                </button>
              ) : (
                <div className="flex justify-between px-1 py-2">
                  Projects
                  <ProjectsMenu
                    canImport
                    onCreate={vi.fn()}
                    onImport={vi.fn()}
                    onCollapse={() =>
                      setCollapsed(new Set(['/project', '/other']))
                    }
                    onExpand={() => setCollapsed(new Set())}
                  />
                </div>
              )
            }
            workspaceGroups={
              focused
                ? [group]
                : [
                    group,
                    {
                      projectId: 'other',
                      cwd: '/other',
                      name: 'Other project',
                      threads: [],
                      simpleChats: [],
                    },
                  ]
            }
            collapsedGroups={collapsed}
            isLoading={false}
            onToggleCollapse={(key) =>
              setCollapsed((current) =>
                current.has(key)
                  ? new Set([...current].filter((value) => value !== key))
                  : new Set([...current, key]),
              )
            }
            onOpenProject={vi.fn()}
            onOpenArchivedDetail={() => setArchives(true)}
            onOpenWorkspaceDetail={() => {
              setFocused(true);
              useAgentViewCacheStore
                .getState()
                .restorePreference('fixture', group.projectId);
            }}
            onCreateAgentInWorkspace={vi.fn()}
            onCreateSimpleChatInWorkspace={vi.fn()}
            onCreateTaskBoard={vi.fn()}
            onOpenResource={vi.fn()}
            resourceActionPending={false}
            onRenameResource={vi.fn()}
            onDeleteResource={vi.fn()}
            movingThread={false}
            renderSimpleChatRow={() => null}
            renderThreadRow={(thread) => (
              <div key={thread.id} data-testid={thread.id}>
                <ThreadRow
                  thread={thread}
                  archived={false}
                  isActive={false}
                  destructiveDisabled={false}
                  actionPending={false}
                  onOpen={vi.fn()}
                  onRename={vi.fn()}
                  onArchive={vi.fn()}
                  onUnarchive={vi.fn()}
                  onCompact={vi.fn()}
                  onFork={vi.fn()}
                  onDelete={vi.fn()}
                  draggable
                  projectId={group.projectId}
                />
              </div>
            )}
          />
        </DragDropProvider>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {archives ? (
          <ProjectArchivedAgents
            project={focusProject}
            pending={false}
            onOpen={vi.fn()}
            onRestore={vi.fn()}
            onFork={vi.fn()}
            onDelete={vi.fn()}
            onOpenTask={vi.fn()}
          />
        ) : (
          <h1 className="p-4">Conversation</h1>
        )}
      </main>
    </div>
  );
}
afterEach(() => {
  cleanup();
  useAgentViewCacheStore.getState().clear();
});
test('keeps draggable compact rows in focus and opens the archives as a central page with a sticky header', async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  await page.viewport(1180, 800);
  render(<Fixture />);
  const sidebar = screen.getByRole('complementary', {
    name: 'Sidebar fixture',
  });
  expect(sidebar.querySelectorAll('[data-testid^="agent-"]')).toHaveLength(5);
  const eye = page
    .getByRole('button', { name: 'Focus on this project', exact: true })
    .first();
  const plus = page
    .getByRole('button', { name: 'Project actions', exact: true })
    .first();
  const eyeBox = await eye.element().getBoundingClientRect();
  const plusBox = await plus.element().getBoundingClientRect();
  expect(eyeBox.left).toBeLessThan(plusBox.left);
  const menuBox = page
    .getByRole('button', { name: 'Project list actions' })
    .element()
    .getBoundingClientRect();
  expect(
    Math.abs(
      plusBox.left + plusBox.width / 2 - (menuBox.left + menuBox.width / 2),
    ),
  ).toBeLessThan(2);
  await commands.sidebarProjectDrag('agent-0', 'agent-2');
  await settleSidebarDrag(sidebar, 'Agent 0');
  await waitFor(() =>
    expect(sidebar.querySelector('[data-testid^="agent-"]')).toHaveAttribute(
      'data-testid',
      'agent-1',
    ),
  );
  await eye.click();
  expect(screen.queryByText('Other project')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Project list actions' }),
  ).not.toBeInTheDocument();
  expect(sidebar.querySelectorAll('[data-testid^="agent-"]')).toHaveLength(8);
  expect(useAgentViewCacheStore.getState().projectId).toBe(focusProject.id);
  await commands.sidebarProjectDrag('agent-1', 'agent-3');
  await settleSidebarDrag(sidebar, 'Agent 1');
  await waitFor(() =>
    expect(sidebar.querySelector('[data-testid^="agent-"]')).toHaveAttribute(
      'data-testid',
      'agent-0',
    ),
  );
  const before = sidebar.textContent;
  const archivesButton = page
    .getByRole('button', { name: /Archived conversations/ })
    .first()
    .element();
  expect(archivesButton.parentElement?.lastElementChild).toBe(archivesButton);
  expect(archivesButton).not.toHaveAttribute('aria-roledescription');
  await page
    .getByRole('button', { name: /Archived conversations/ })
    .first()
    .click();
  expect(sidebar.textContent).toBe(before);
  expect(
    screen.queryByRole('tab', { name: 'Archives' }),
  ).not.toBeInTheDocument();
  const scroll = document.querySelector<HTMLElement>(
    '[data-archive-table-scroll]',
  )!;
  const header = scroll.querySelector('thead')!;
  const top = header.getBoundingClientRect().top;
  scroll.scrollTop = 250;
  await waitFor(() =>
    expect(Math.abs(header.getBoundingClientRect().top - top)).toBeLessThan(1),
  );
  const engine = navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit';
  await Promise.allSettled(
    document
      .getAnimations()
      .filter(
        (animation) => animation.effect?.getTiming().iterations !== Infinity,
      )
      .map((animation) => animation.finished),
  );
  await page.screenshot({
    path: `../../../../.vitest-screenshots/project-archives-${engine}-desktop.png`,
  });
  await page.viewport(390, 800);
  await page.screenshot({
    path: `../../../../.vitest-screenshots/project-archives-${engine}-mobile.png`,
  });
  await page.viewport(1180, 800);
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  expect(screen.getByText('Other project')).toBeVisible();
});

async function settleSidebarDrag(sidebar: HTMLElement, label: string) {
  // The order commits before the drop animation removes its temporary clone.
  // Compare the stable sidebar, not a snapshot containing the disappearing row.
  await waitFor(() => {
    expect(
      document.querySelector('[data-dnd-dropping], [data-dnd-dragging]'),
    ).toBeNull();
    expect(sidebar.querySelector('.opacity-40')).toBeNull();
    expect(within(sidebar).getAllByText(label, { exact: true })).toHaveLength(
      1,
    );
  });
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    sidebarProjectDrag: (sourceId: string, targetId: string) => Promise<void>;
  }
}
