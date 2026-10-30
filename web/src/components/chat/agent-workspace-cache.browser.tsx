/** Real Activity, project menu, composer and navigation; synthetic API data only. */
import { useContext, useEffect, useMemo, useState } from 'react';
import { RetainedSurface } from '@/components/retained-surface';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DragDropProvider } from '@dnd-kit/react';
import { AgentWorkspaceHost } from './agent-workspace-host';
import { ChatInput } from './chat-input';
import { WorkspaceOverview } from './sidebar/workspace-overview';
import { useWorkspaceNavigation } from '@/hooks/use-workspace-navigation';
import { useTimelineStore as timeline } from '@/stores/timeline-store';
import { useAgentViewCacheStore as cache } from '@/stores/agent-view-cache-store';
import { useComposerDraftStore as drafts } from '@/stores/composer-draft-store';
import { projectsQueryKey, type ProjectSummary } from '@/lib/projects-api';
import { SurfaceActivityContext } from '@/lib/surface-activity';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { VirtualTranscript } from './virtual-transcript';
import { forgetTranscriptBookmarks } from '@/lib/transcript-anchor';
import { WorkspaceEntryMenu } from './workspace-entry-menu';
import { FileActionsMenu } from '@/components/files/file-actions-menu';
import { FileText } from 'lucide-react';

const calls = vi.hoisted(() => ({
  open: vi.fn(),
  check: vi.fn(),
  start: vi.fn(),
  command: vi.fn(),
  effects: new Set<string>(),
  socket: { connected: true, emit: vi.fn() },
}));
vi.mock('@/socket', () => ({ getSocket: () => calls.socket }));
vi.mock('@/routes/thread-view', () => ({
  ConversationWorkspace: FixtureWorkspace,
}));
vi.mock('@/lib/navigation-workspace-check', () => ({
  checkNavigationWorkspaces: calls.check,
}));
vi.mock('@/hooks/use-thread-open', () => ({
  useOpenThread: () => ({ mutate: calls.open }),
  HISTORY_PAGE_SIZE: 20,
  applyReadOnlySnapshot: vi.fn(),
}));
vi.mock('@/hooks/use-thread-security-policy', () => ({
  useThreadSecurityPolicy: () => ({ isSettling: false }),
}));
vi.mock('@/hooks/use-slash-dispatch', () => ({
  useSlashDispatch: () => ({
    runCommand: calls.command,
    setDialog: vi.fn(),
    togglePlanMode: vi.fn(),
    dialog: null,
  }),
}));
vi.mock('@/generated/api/@tanstack/react-query.gen', async (original) => ({
  ...(await original<
    typeof import('@/generated/api/@tanstack/react-query.gen')
  >()),
  threadsStartTurnMutation: () => ({ mutationFn: calls.start }),
}));
vi.mock('./model-selector', () => ({
  ModelSelector: () => (
    <button className="px-1 text-xs">GPT-6.1 · medium</button>
  ),
}));
vi.mock('./security-policy-badge', () => ({
  SecurityPolicyBadge: () => (
    <button className="px-1 text-xs" title="Permissions">
      ◈
    </button>
  ),
}));
vi.mock('./capabilities-menu', () => ({
  CapabilitiesMenu: () => (
    <button className="px-1 text-xs" title="Capabilities">
      ☷
    </button>
  ),
}));
vi.mock('./token-usage-ring', () => ({
  TokenUsageRing: () => <span className="text-xs">35</span>,
}));
vi.mock('./voice-dictation-button', () => ({
  VoiceDictationButton: () => <button title="Dictation">♩</button>,
}));
vi.mock('./goal-progress-row', () => ({ GoalProgressRow: () => null }));
vi.mock('./slash-dialogs', () => ({ SlashDialogs: () => null }));

export function FixtureWorkspace({ threadId }: { threadId: string }) {
  const active = useContext(SurfaceActivityContext);
  useWorkspaceNavigation(threadId);
  const entries = timeline((s) => s.threadsById[threadId]?.timeline);
  const keys = useMemo(
    () => [
      ...Array.from({ length: 30 }, (_, n) => `step:${n}`),
      ...(entries ?? []).map((_, n) => `event:${n}`),
    ],
    [entries],
  );
  useEffect(() => {
    calls.effects.add(threadId);
    return () => {
      calls.effects.delete(threadId);
    };
  }, [threadId]);
  return (
    <section
      aria-label={`Agent ${threadId}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <h1 className="border-b p-4 font-semibold">
        Agent {threadId} · Interface du projet
      </h1>
      <div className="relative min-h-0 flex-1">
        <VirtualTranscript
          threadId={threadId}
          keys={keys}
          active={active}
          ready
          bottomInset={20}
          scrollSignal={0}
          renderRow={(index) => (
            <div
              style={{ minHeight: 120 }}
              className="mx-4 mb-3 rounded-xl bg-card p-4 text-sm"
              data-reading-row={index}
            >
              <p>
                {index < 30
                  ? `Étape ${index + 1} — vérification de l’interface et des panneaux conservés.`
                  : 'Activité reçue de l’agent en arrière-plan'}
              </p>
            </div>
          )}
        />
      </div>
      <ChatInput conversationId={threadId} active={active} />
      <div className="flex gap-2 px-4">
        <WorkspaceEntryMenu
          label={`Repository actions ${threadId}`}
          items={[{ label: `Repository info ${threadId}` }]}
        />
        <FileActionsMenu
          actions={[
            { id: 'info', label: `File info ${threadId}`, icon: FileText },
          ]}
          buttonLabel={`report-${threadId}`}
        >
          <span>report-{threadId}</span>
        </FileActionsMenu>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button className="sr-only">Open tools for {threadId}</button>
        </PopoverTrigger>
        <PopoverContent>
          <button>Tools for {threadId}</button>
        </PopoverContent>
      </Popover>
    </section>
  );
}
const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const project: ProjectSummary = {
  id: 'p',
  name: 'Projet interface',
  workspacePath: '/p',
  workspaces: [],
  resources: [],
  createdAt: 1,
  updatedAt: 1,
  agentThreads: ids.map((threadId) => ({
    threadId,
    title: `Agent ${threadId}`,
    workspacePath: `/p/${threadId}`,
    activeFolder: null,
    archived: false,
    taskId: null,
    taskResourceId: null,
    taskTitle: null,
    isSubtask: false,
  })),
};
const other = {
  ...project,
  id: 'q',
  name: 'Autre projet',
  workspacePath: '/q',
  agentThreads: [{ ...project.agentThreads![0], threadId: 'x' }],
};
export function Fixture() {
  const [id, setId] = useState('a');
  const [locked, setLocked] = useState(false);
  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground md:flex-row">
      <button className="sr-only" onClick={() => setLocked((value) => !value)}>
        Session lock
      </button>
      <RetainedSurface active={!locked}>
        <aside className="shrink-0 border-b p-3 md:w-64 md:border-r">
          <DragDropProvider>
            <WorkspaceOverview
              projectsHeader={<h2>Projets</h2>}
              workspaceGroups={[project, other].map((p) => ({
                name: p.name,
                projectId: p.id,
                cwd: p.workspacePath,
                threads: [],
                simpleChats: [],
              }))}
              collapsedGroups={new Set()}
              isLoading={false}
              onToggleCollapse={vi.fn()}
              onOpenProject={vi.fn()}
              onOpenArchivedDetail={vi.fn()}
              onOpenWorkspaceDetail={vi.fn()}
              onCreateAgentInWorkspace={vi.fn()}
              onCreateSimpleChatInWorkspace={vi.fn()}
              onCreateTaskBoard={vi.fn()}
              onOpenResource={vi.fn()}
              resourceActionPending={false}
              onRenameResource={vi.fn()}
              onDeleteResource={vi.fn()}
              renderThreadRow={() => null}
              renderSimpleChatRow={() => null}
              movingThread={false}
            />
          </DragDropProvider>
          <nav
            aria-label="Agents"
            className="flex flex-wrap gap-1 pt-3 md:flex-col"
          >
            {[...ids, 'x'].map((agent) => (
              <button
                key={agent}
                aria-pressed={agent === id}
                className="rounded px-3 py-1 text-left text-sm hover:bg-accent aria-pressed:bg-accent"
                onClick={() => setId(agent)}
              >
                Agent {agent}
              </button>
            ))}
          </nav>
        </aside>
        <AgentWorkspaceHost activeThreadId={id} />
      </RetainedSurface>
      {locked && <p>Session suspendue — identité à vérifier</p>}
    </main>
  );
}
const initial = timeline.getState();
let client: QueryClient;
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  timeline.setState(initial, true);
  cache.getState().clear();
  forgetTranscriptBookmarks([...ids, 'x']);
  drafts.setState({ drafts: {}, forgotten: new Set() });
  calls.effects.clear();
  calls.check.mockReset().mockResolvedValue(undefined);
  calls.start.mockReset().mockResolvedValue({
    turn: { id: 'new-turn', status: 'completed', items: [] },
  });
  calls.command.mockClear();
  calls.open
    .mockReset()
    .mockImplementation(({ path }: { path: { threadId: string } }) => {
      const threadId = path.threadId;
      timeline
        .getState()
        .ensureThreadState({ threadId, cwd: `/p/${threadId}` });
      timeline.getState().hydrateOpenedThread({
        threadId,
        turnsNewestFirst: [],
        historyCursor: null,
        readOnlyReason: null,
      });
      timeline
        .getState()
        .setOpenStateForThread(threadId, { openState: 'ready' });
      timeline.getState().selectThread(threadId);
      timeline.setState((state) => ({
        subscribedThreadIds: new Set(state.subscribedThreadIds).add(threadId),
        confirmedThreadIds: new Set(state.confirmedThreadIds).add(threadId),
      }));
    });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(projectsQueryKey, { projects: [project, other] });
  document.documentElement.classList.add('dark');
});
afterEach(() => {
  cleanup();
  client.clear();
  document.documentElement.classList.remove('dark');
});
async function start() {
  render(
    <QueryClientProvider client={client}>
      <Fixture />
    </QueryClientProvider>,
  );
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect(timeline.getState().threadId).toBe('a'));
  fireEvent.contextMenu(screen.getByText('Projet interface'));
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Enable fast navigation for this project',
    }),
  );
  expect(
    screen.getByRole('img', { name: 'Fast navigation enabled' }),
  ).toBeVisible();
  return input;
}
async function select(id: string) {
  // Route navigation can also occur while a modal menu has aria-hidden the sidebar.
  fireEvent.click(
    screen.getByRole('button', { name: `Agent ${id}`, hidden: true }),
  );
  await waitFor(() => expect(timeline.getState().threadId).toBe(id));
  return screen.findByRole('textbox');
}
test.each([[390, 1], ...Array.from({ length: 20 }, (_, n) => [1180, n + 1])])(
  'retains desktop/mobile drafts, scroll and background updates at %ipx (run %i)',
  async (width) => {
    await page.viewport(width, 900);
    const a = await start();
    fireEvent.change(a, {
      target: { value: 'Brouillon conservé pour cet agent' },
    });
    const scroll = screen
      .getByRole('region', { name: 'Agent a' })
      .querySelector<HTMLDivElement>('[data-transcript-scroller]')!;
    await expect
      .poll(() => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight)
      .toBeLessThan(2);
    fireEvent.click(screen.getByRole('button', { name: 'Open tools for a' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Tools for a' })).toBeVisible(),
    );
    // Linux WebKit animates native wheel input. A fixed delay can snapshot a
    // moving viewport, so the subsequent hide correctly saves a later reading
    // point and the test falsely reports drift. Arm before sending input and
    // wait for the browser's scrollend, then allow measurements to commit.
    let scrollTimeout: number | undefined;
    let wheelStarted = false;
    let finishScroll!: () => void;
    const scrollFinished = new Promise<void>((resolve) => {
      finishScroll = resolve;
    });
    const onWheel = () => {
      wheelStarted = true;
    };
    const onScrollEnd = () => {
      if (wheelStarted) finishScroll();
    };
    scroll.addEventListener('wheel', onWheel);
    scroll.addEventListener('scrollend', onScrollEnd);
    try {
      await commands.scrollTranscript(-650);
      await Promise.race([
        scrollFinished,
        new Promise<never>((_, reject) => {
          scrollTimeout = window.setTimeout(
            () =>
              reject(new Error('Native transcript scrolling did not finish')),
            5000,
          );
        }),
      ]);
    } finally {
      window.clearTimeout(scrollTimeout);
      scroll.removeEventListener('wheel', onWheel);
      scroll.removeEventListener('scrollend', onScrollEnd);
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    // A positive absolute offset also holds at the tail: prove the native
    // upward gesture actually left follow mode before recording a reading point.
    await expect
      .poll(() => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight)
      .toBeGreaterThan(300);
    const before = scroll.scrollTop;
    expect(before).toBeGreaterThan(0);
    const readingRow = [
      ...scroll.querySelectorAll<HTMLElement>('[data-reading-row]'),
    ].find(
      (node) =>
        node.getBoundingClientRect().top >
        scroll.getBoundingClientRect().top + 20,
    )!;
    const rowId = readingRow.dataset.readingRow;
    const readingY =
      readingRow.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top;
    const b = await select('b');
    fireEvent.change(b, { target: { value: 'Autre brouillon pour b' } });
    expect(calls.effects).toEqual(new Set(['b']));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Tools for a' })).toBeNull(),
    );
    act(() =>
      timeline
        .getState()
        .addSystemMessageForThread('a', 'Travail reçu en arrière-plan', 'info'),
    );
    expect(timeline.getState().threadId).toBe('b');
    const opens = calls.open.mock.calls.length;
    const checks = calls.check.mock.calls.length;
    const aAgain = await select('a');
    expect(aAgain).toBe(a);
    expect((aAgain as HTMLTextAreaElement).value).toBe(
      'Brouillon conservé pour cet agent',
    );
    // The same sentence must stay put even when remeasurement changes total offsets.
    await expect
      .poll(() => {
        const row = scroll.querySelector<HTMLElement>(
          `[data-reading-row="${rowId}"]`,
        );
        return row
          ? Math.abs(
              row.getBoundingClientRect().top -
                scroll.getBoundingClientRect().top -
                readingY,
            )
          : Infinity;
      })
      .toBeLessThan(2);
    expect(
      timeline.getState().getThreadRuntime('a')?.timeline.at(-1),
    ).toMatchObject({ content: 'Travail reçu en arrière-plan' });
    expect(calls.open).toHaveBeenCalledTimes(opens);
    expect(calls.check).toHaveBeenCalledTimes(checks);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.getByRole('main').screenshot({
      path: `../../../.vitest-screenshots/agent-cache-${width}.png`,
    });
    // The session safety boundary must still remove cached controls and portals.
    fireEvent.click(screen.getByRole('button', { name: 'Open tools for a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Session lock' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Tools for a' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Session lock' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toBe(a));
  },
);

test('bounds retained views, keeps evicted drafts, switches the opted project and scopes sends', async () => {
  await page.viewport(1180, 900);
  const a = await start();
  fireEvent.change(a, { target: { value: 'Draft a survives eviction' } });
  for (const id of ['b', 'c', 'd', 'e', 'f']) await select(id);
  expect(cache.getState().threadIds).toEqual(['b', 'c', 'd', 'e', 'f']);
  expect(
    document.querySelectorAll('section[aria-label^="Agent "]'),
  ).toHaveLength(5);
  const restoredA = await select('a');
  expect(restoredA).not.toBe(a);
  expect((restoredA as HTMLTextAreaElement).value).toBe(
    'Draft a survives eviction',
  );
  // A late DOM event from a retained hidden composer cannot send to another agent.
  await select('b');
  fireEvent.keyDown(restoredA, { key: 'Enter' });
  expect(calls.start).not.toHaveBeenCalled();
  const b = await select('b');
  fireEvent.change(b, { target: { value: 'Only send b' } });
  fireEvent.keyDown(b, { key: 'Enter' });
  await waitFor(() => expect(calls.start).toHaveBeenCalledTimes(1));
  expect(calls.start.mock.calls[0][0]).toMatchObject({
    path: { threadId: 'b' },
    body: { input: [{ type: 'text', text: 'Only send b' }] },
  });
  expect(drafts.getState().drafts.a.text).toBe('Draft a survives eviction');
  fireEvent.contextMenu(screen.getByText('Autre projet'));
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Enable fast navigation for this project',
    }),
  );
  expect(cache.getState().projectId).toBe('q');
  expect(
    screen.getAllByRole('img', { name: 'Fast navigation enabled' }),
  ).toHaveLength(1);
  expect(
    within(screen.getByRole('main')).getByRole('region', { name: 'Agent b' }),
  ).toBeVisible();
  await select('x');
  expect(cache.getState().threadIds).toEqual(['x']);
  expect(timeline.getState().retainedThreadIds).toEqual(new Set(['x']));
});

test('withdraws repository, file overflow and right-click menus without resurrecting deleted agents', async () => {
  await page.viewport(1180, 900);
  await start();
  fireEvent.pointerDown(
    screen.getByRole('button', { name: 'Repository actions a' }),
    { button: 0, ctrlKey: false },
  );
  await screen.findByRole('menuitem', { name: 'Repository info a' });
  await select('b');
  await waitFor(() =>
    expect(
      screen.queryByRole('menuitem', { name: 'Repository info a' }),
    ).toBeNull(),
  );
  await select('a');
  fireEvent.pointerDown(
    screen.getByRole('button', { name: 'Actions · report-a' }),
    { button: 0, ctrlKey: false },
  );
  await screen.findByRole('menuitem', { name: 'File info a' });
  await select('b');
  await waitFor(() =>
    expect(screen.queryByRole('menuitem', { name: 'File info a' })).toBeNull(),
  );
  await select('a');
  fireEvent.contextMenu(screen.getByText('report-a'));
  await screen.findByRole('menuitem', { name: 'File info a' });
  await select('b');
  await waitFor(() =>
    expect(screen.queryByRole('menuitem', { name: 'File info a' })).toBeNull(),
  );
  const opens = calls.open.mock.calls.length;
  act(() => timeline.getState().forgetThreads(['a']));
  expect(timeline.getState().getThreadRuntime('a')).toBeNull();
  expect(cache.getState().threadIds).toEqual(['b']);
  expect(calls.open).toHaveBeenCalledTimes(opens);
  act(() => client.setQueryData(projectsQueryKey, { projects: [other] }));
  await waitFor(() => expect(cache.getState().projectId).toBeNull());
});
