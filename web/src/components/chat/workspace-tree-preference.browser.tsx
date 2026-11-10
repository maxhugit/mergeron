/** Real explorer navigation with synthetic profiles/projects; no user files. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { WorkspaceTree } from './workspace-tree';
import { useLayoutStore } from '@/stores/layout-store';
import type { ProjectSummary } from '@/lib/projects-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const api = vi.hoisted(() => ({
  person: 'alice',
  saved: new Map<string, string>(),
  writes: [] as Array<{ personId: string; projectId: string; tab: string }>,
  fail: false,
}));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: { personId: api.person },
    isAdministrator: false,
  }),
  readAuthResource: (path: string) => {
    const projectId = decodeURIComponent(path.split('/').at(-1)!);
    return Promise.resolve({
      personId: api.person,
      projectId,
      tab: api.saved.get(api.person + ':' + projectId) ?? 'folders',
    });
  },
  updateAuthResource: (
    path: string,
    body: { personId: string; tab: string },
  ) => {
    if (api.fail) return Promise.reject(Error('offline'));
    const projectId = decodeURIComponent(path.split('/').at(-1)!);
    api.saved.set(body.personId + ':' + projectId, body.tab);
    api.writes.push({ ...body, projectId });
    return Promise.resolve({ ...body, projectId });
  },
}));
vi.mock('@/generated/api', () => ({ filesAddRoot: () => Promise.resolve({}) }));
vi.mock('@/hooks/use-deliverable-directory-aliases', () => ({
  useDeliverableDirectoryAliases: () => ({}),
}));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => <div>Fichiers du projet</div>,
}));
vi.mock('./explorer-deliverables', () => ({
  ExplorerDeliverables: () => <div>Documents du projet</div>,
}));
vi.mock('./explorer-tasks', () => ({
  ExplorerTasks: () => <div>Tâches du projet</div>,
}));
vi.mock('./workspace-git-panel', () => ({
  WorkspaceGitPanel: () => <div>Sources du projet</div>,
}));

let client: QueryClient;
function project(id = 'p', tasks = true): ProjectSummary {
  return {
    id,
    name: 'Projet ' + id,
    workspacePath: '/fixture/' + id,
    createdAt: 1,
    updatedAt: 1,
    resources: tasks
      ? [
          {
            id: 'tasks',
            projectId: id,
            type: 'task_board',
            name: 'Tâches',
            config: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ]
      : [],
    workspaces: [],
  };
}
function fixture(agent = 'a', id = 'p', width = 1280, tasks = true) {
  return (
    <QueryClientProvider client={client}>
      <div className="bg-background text-foreground" style={{ height: 760 }}>
        <WorkspaceTree
          key={agent}
          agentThreadId={agent}
          project={project(id, tasks)}
          cwd={'/fixture/' + id}
          desktop={width > 600}
          mobileOpen={width <= 600}
          onMobileClose={() => {}}
          onFile={() => {}}
        />
      </div>
    </QueryClientProvider>
  );
}
const tab = (name: string) => screen.getByRole('tab', { name });
async function selected(name: string) {
  await waitFor(() =>
    expect(tab(name)).toHaveAttribute('aria-selected', 'true'),
  );
  await waitFor(() => expect(tab(name)).toBeEnabled());
}
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.person = 'alice';
  api.saved.clear();
  api.writes = [];
  api.fail = false;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useLayoutStore.setState({
    workspaceTreeCollapsed: false,
    workspaceTreeWidth: 360,
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});

for (const width of [1280, 390])
  test(`remembers an explicit tab between agents and after reload at ${width}px`, async () => {
    await page.viewport(width, 844);
    const view = render(fixture('a', 'p', width));
    await selected('Dossiers');
    fireEvent.click(tab('Livrables'));
    await waitFor(() => expect(api.saved.get('alice:p')).toBe('deliverables'));
    await selected('Livrables');
    view.rerender(fixture('b', 'p', width));
    await selected('Livrables');
    view.unmount();
    client.clear();
    render(fixture('c', 'p', width));
    await selected('Livrables');
    expect(api.writes).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      window.innerWidth,
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-explorer-preference-${width}.png`,
    });
  });

test('keeps profiles and projects separate, including returning to the same agent', async () => {
  await page.viewport(1280, 844);
  api.saved.set('alice:p', 'deliverables');
  api.saved.set('alice:q', 'sources');
  const view = render(fixture());
  await selected('Livrables');
  view.rerender(fixture('b', 'q'));
  await selected('Sources');
  api.person = 'bob';
  view.rerender(fixture('b', 'q'));
  await selected('Dossiers');
  api.person = 'alice';
  view.rerender(fixture('a', 'p'));
  await selected('Livrables');
  expect(api.writes).toHaveLength(0);
});

test('a contextual reveal does not replace the shared preference', async () => {
  await page.viewport(1280, 844);
  api.saved.set('alice:p', 'deliverables');
  const view = render(fixture());
  await selected('Livrables');
  fireEvent(
    window,
    new CustomEvent('mergeron:explorer-work', {
      detail: { threadId: 'a', tab: 'tasks', taskId: 'one' },
    }),
  );
  await selected('Tâches');
  expect(api.writes).toHaveLength(0);
  view.rerender(fixture('b'));
  await selected('Livrables');
  expect(api.saved.get('alice:p')).toBe('deliverables');
});

test('an unavailable task tab falls back without erasing the saved choice', async () => {
  await page.viewport(1280, 844);
  api.saved.set('alice:p', 'tasks');
  const view = render(fixture('a', 'p', 1280, false));
  await selected('Dossiers');
  expect(screen.queryByRole('tab', { name: 'Tâches' })).toBeNull();
  expect(api.saved.get('alice:p')).toBe('tasks');
  expect(api.writes).toHaveLength(0);
  view.rerender(fixture());
  await selected('Tâches');
});

test('failed persistence leaves navigation usable with an explicit notice', async () => {
  await page.viewport(1280, 844);
  api.fail = true;
  render(fixture());
  await selected('Dossiers');
  fireEvent.click(tab('Livrables'));
  await screen.findByText(/Impossible de mémoriser l’onglet du projet/);
  await selected('Livrables');
  expect(api.saved.has('alice:p')).toBe(false);
  fireEvent.click(tab('Sources'));
  await selected('Sources');
});

test('keeps already mounted agents on the same saved project preference', async () => {
  await page.viewport(1280, 844);
  render(
    <>
      <section aria-label="Agent A">{fixture('a')}</section>
      <section aria-label="Agent B">{fixture('b')}</section>
    </>,
  );
  const a = within(screen.getByRole('region', { name: 'Agent A' }));
  const b = within(screen.getByRole('region', { name: 'Agent B' }));
  await waitFor(() =>
    expect(a.getByRole('tab', { name: 'Livrables' })).toBeEnabled(),
  );
  fireEvent.click(a.getByRole('tab', { name: 'Livrables' }));
  await waitFor(() =>
    expect(b.getByRole('tab', { name: 'Livrables' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );
  fireEvent.click(b.getByRole('tab', { name: 'Sources' }));
  await waitFor(() =>
    expect(a.getByRole('tab', { name: 'Sources' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );
  expect(api.saved.get('alice:p')).toBe('sources');
});
