import { useState } from 'react';
import { localExecutionSelection } from '@/lib/project-execution-location';
/** Real divider geometry with synthetic directory data; no user files are read. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { commands, page } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceTree } from './workspace-tree';
import { useLayoutStore } from '@/stores/layout-store';
import '@/index.css';
import i18n, { i18nReady } from '@/i18n';

vi.mock('@/generated/api', async (original) => ({
  ...(await original<typeof import('@/generated/api')>()),
  filesAddRoot: async () => ({}),
}));
vi.mock('@/lib/platform-session', async (original) => ({
  ...(await original<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => ({ isAdministrator: false }),
}));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => <div>fixture.ts</div>,
}));

declare module 'vitest/browser' {
  interface BrowserCommands {
    explorerDivider: (
      action: 'start' | 'move' | 'end' | 'cancel',
      delta?: number,
    ) => Promise<void>;
  }
}

export function Fixture({ width = 800 }: { width?: number }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <div style={{ display: 'flex', width, height: 500 }}>
        <div data-content style={{ flex: 1, minWidth: 0 }} />
        <WorkspaceTree
          cwd="/fixture"
          desktop
          mobileOpen={false}
          onMobileClose={() => undefined}
          onFile={() => undefined}
        />
      </div>
    </QueryClientProvider>
  );
}

const rail = () => document.querySelector('aside')!;
const contentWidth = () =>
  document.querySelector('[data-content]')!.getBoundingClientRect().width;
const preview = () => rail().querySelector<HTMLElement>('.pointer-events-none');

beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  await page.viewport(1280, 900);
  useLayoutStore.setState({
    workspaceTreeCollapsed: false,
    workspaceTreeWidth: 260,
  });
});
afterEach(cleanup);

test('uses the same 44px header height as the conversation', async () => {
  render(<Fixture />);
  await expect
    .poll(() => rail().querySelector('.h-11')?.getBoundingClientRect().height)
    .toBe(44);
});

test('previews without reflow and commits the same constrained width on release', async () => {
  render(<Fixture />);
  const before = contentWidth();
  const limit = 800 * 0.45;
  await commands.explorerDivider('start');
  try {
    await commands.explorerDivider('move', -450);
    await expect.poll(() => preview()?.style.right).toBe(`${limit}px`);
    expect(contentWidth()).toBe(before);
    expect(useLayoutStore.getState().workspaceTreeWidth).toBe(260);
  } finally {
    await commands.explorerDivider('end');
  }
  await expect
    .poll(() => rail().getBoundingClientRect().width)
    .toBeCloseTo(limit, 0);
  expect(useLayoutStore.getState().workspaceTreeWidth).toBe(limit);
  expect(preview()).toBeNull();
});

test('Escape cancels a preview and an unmoved click preserves the preferred width', async () => {
  useLayoutStore.setState({ workspaceTreeWidth: 600 });
  render(<Fixture />);
  expect(rail().getBoundingClientRect().width).toBeCloseTo(360, 0);
  await commands.explorerDivider('start');
  await commands.explorerDivider('end');
  expect(useLayoutStore.getState().workspaceTreeWidth).toBe(600);
  await commands.explorerDivider('start');
  try {
    await commands.explorerDivider('move', 90);
    await expect.poll(() => preview()).not.toBeNull();
  } finally {
    await commands.explorerDivider('cancel');
  }
  expect(useLayoutStore.getState().workspaceTreeWidth).toBe(600);
  expect(preview()).toBeNull();
  expect(rail().getBoundingClientRect().width).toBeCloseTo(360, 0);
});

export function PrimaryReferenceFixture({ desktop }: { desktop: boolean }) {
  const root = '/fixture/project';
  const [cwd, setCwd] = useState(root + '/.mergeron-system/livrables/report');
  const [selection, setSelection] =
    useState<ReturnType<typeof localExecutionSelection>>(null);
  const project = {
    id: 'fixture-project',
    name: 'Mergeron',
    workspacePath: root,
    resources: [],
    createdAt: 1,
    updatedAt: 1,
    workspaces: [
      {
        id: 'primary',
        projectId: 'fixture-project',
        name: 'Principal',
        path: root,
        primary: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  return (
    <QueryClientProvider client={new QueryClient()}>
      <div
        className="flex bg-background text-foreground"
        style={{ width: desktop ? 800 : '100%', height: 600 }}
      >
        <div className="min-w-0 flex-1">
          <output data-testid="reference-selection">
            {JSON.stringify(selection)}
          </output>
        </div>
        <WorkspaceTree
          cwd={cwd}
          project={project}
          desktop={desktop}
          mobileOpen={!desktop}
          onMobileClose={() => {}}
          onFile={() => {}}
          onActiveWorkspaceChange={(path) => {
            setSelection(localExecutionSelection(project, path));
            setCwd(path);
          }}
        />
      </div>
    </QueryClientProvider>
  );
}
for (const desktop of [false, true])
  test(`returns from a deliverable to the actual primary reference on ${desktop ? 'desktop' : 'mobile'}`, async () => {
    await page.viewport(desktop ? 1200 : 390, 844);
    await i18n.changeLanguage('fr');
    render(<PrimaryReferenceFixture desktop={desktop} />);
    const button = await page.getByRole('button', {
      name: 'Revenir à la référence principale de l’agent',
    });
    await expect.element(button).toBeVisible();
    const node = screen.getByRole('button', {
      name: 'Revenir à la référence principale de l’agent',
    });
    // The mobile sheet slides in; wait for its real hit area, not a fixed delay.
    await expect
      .poll(() => node.getBoundingClientRect().right)
      .toBeLessThanOrEqual(window.innerWidth);
    const rect = node.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth);
    await page.screenshot({
      path: `../../../.vitest-screenshots/primary-reference-${desktop ? 'desktop' : 'mobile'}.png`,
    });
    await button.click();
    await expect
      .poll(() =>
        screen.queryByRole('button', {
          name: 'Revenir à la référence principale de l’agent',
        }),
      )
      .toBeNull();
    expect(screen.getByTitle('/fixture/project')).toHaveTextContent(
      'Principal',
    );
    expect(screen.getByTestId('reference-selection')).toHaveTextContent(
      JSON.stringify({ locationId: 'local:primary', relativePath: '' }),
    );
  });
