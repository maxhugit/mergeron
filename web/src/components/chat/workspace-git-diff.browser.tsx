/** Real diff renderer and workspace tabs; no live repository operations. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceGitDiff } from './workspace-git-diff';
import { WorkspaceControls } from './workspace-controls';
import { useWorkspaceStore, EMPTY_WORKSPACE } from '@/stores/workspace-store';
import { useThemeStore } from '@/stores/theme-store';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const patch =
  'diff --git a/coucou.js b/coucou.js\n--- a/coucou.js\n+++ b/coucou.js\n@@ -1,3 +1,3 @@\n function hello() {\n-  console.log("ancienne version");\n+  console.log("nouvelle version");\n }\n';
vi.mock('@/lib/projects-api', () => ({
  projectsApi: async () => ({ diff: patch, untracked: false }),
}));
const target = {
  projectId: 'p',
  copyId: 'copy',
  path: 'coucou.js',
  localPath: '/copy',
  status: ' M',
};
const context = 'thread:diff-test';
export function Fixture() {
  const workspace = useWorkspaceStore(
    (state) => state.contexts[context] ?? EMPTY_WORKSPACE,
  );
  return (
    <div className="flex h-[650px] min-w-0 flex-col">
      <WorkspaceControls
        workspace={workspace}
        running={false}
        pending={0}
        onSelect={(id) => useWorkspaceStore.getState().select(context, id)}
        onClose={(tab) => useWorkspaceStore.getState().remove(context, tab.id)}
        onExplorer={() => {}}
        onNewTerminal={() => {}}
      />
      <div hidden={workspace.activeId !== 'conversation'}>
        <p>Conversation préservée</p>
        <button
          onClick={() =>
            useWorkspaceStore.getState().openGitDiff(context, target)
          }
        >
          Comparer coucou.js
        </button>
      </div>
      {workspace.tabs.map(
        (tab) =>
          tab.kind === 'git-diff' && (
            <div
              key={tab.id}
              hidden={workspace.activeId !== tab.id}
              className={
                workspace.activeId === tab.id
                  ? 'flex min-h-0 flex-1 flex-col'
                  : 'hidden'
              }
            >
              <WorkspaceGitDiff
                target={tab}
                active={workspace.activeId === tab.id}
                onFile={() => {}}
              />
            </div>
          ),
      )}
    </div>
  );
}
afterEach(() => {
  cleanup();
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
});
test('opens a read-only side-by-side diff beside Conversation and preserves it when returning', async () => {
  await page.viewport(1100, 800);
  await i18nReady;
  await i18n.changeLanguage('fr');
  useThemeStore.setState({ dark: true });
  document.documentElement.classList.add('dark');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Fixture />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole('button', { name: 'Comparer coucou.js' }).click();
    await expect.poll(() => document.querySelector('table')).not.toBeNull();
    expect(
      screen.getByRole('tab', { name: 'Différences · coucou.js' }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).toContain('ancienne version');
    expect(document.body.textContent).toContain('nouvelle version');
    await page.screenshot({
      path: '../../../.vitest-screenshots/git-diff-tab-desktop.png',
    });
    await page.getByRole('tab', { name: 'Conversation' }).click();
    expect(screen.getByText('Conversation préservée')).toBeVisible();
    await page.getByRole('tab', { name: 'Différences · coucou.js' }).click();
    expect(screen.getByText('Avant · dernier commit (HEAD)')).toBeVisible();
    await page.viewport(390, 800);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: '../../../.vitest-screenshots/git-diff-tab-mobile.png',
    });
    await page.viewport(1100, 800);
    await page
      .getByRole('button', { name: 'Fermer la comparaison de coucou.js' })
      .click();
    expect(
      screen.queryByRole('tab', { name: 'Différences · coucou.js' }),
    ).toBeNull();
    expect(screen.getByRole('tab', { name: 'Conversation' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } finally {
    client.clear();
    document.documentElement.classList.remove('dark');
  }
});
