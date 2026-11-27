import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { DragDropProvider } from '@dnd-kit/react';
import { page } from 'vitest/browser';
import { ThreadRow } from './thread-row';
import { focusThreads } from '@/test-fixtures/project-focus';
import { useAgentCompletionStore as completion } from '@/stores/agent-completion-store';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

export function Fixture() {
  const unread = completion((state) => state.unread);
  return (
    <main className="min-h-dvh bg-background text-foreground p-3">
      <aside className="w-64 border rounded-lg p-2" aria-label="Agents">
        {[
          ['done', 'Ma fiche adhérent avec un nom très long'],
          ['other', 'Finance'],
        ].map(([id, name]) => (
          <ThreadRow
            key={id}
            thread={{ ...focusThreads[0], id, name }}
            archived={false}
            isActive={id === 'done'}
            destructiveDisabled={false}
            actionPending={false}
            workCompleted={unread.has(id)}
            draggable
            onOpen={() => completion.getState().acknowledge([id])}
            onRename={vi.fn()}
            onArchive={vi.fn()}
            onUnarchive={vi.fn()}
            onCompact={vi.fn()}
            onFork={vi.fn()}
            onDelete={vi.fn()}
          />
        ))}
      </aside>
    </main>
  );
}
afterEach(() => {
  cleanup();
  completion.getState().clear();
  document.documentElement.classList.remove('dark');
});

test.each([390, 1280])(
  'keeps completion indicators on one line and dismisses only the clicked agent at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 800);
    document.documentElement.classList.add('dark');
    render(
      <DragDropProvider>
        <Fixture />
      </DragDropProvider>,
    );
    const row = screen.getByRole('button', { name: /Ma fiche adhérent/ });
    const before = row.getBoundingClientRect().height;
    act(() => {
      completion.getState().complete('done', 'turn');
      completion.getState().complete('other', 'other-turn');
    });
    const indicators = screen.getAllByRole('img', { name: /Travail terminé/ });
    expect(indicators).toHaveLength(2);
    expect(row.getBoundingClientRect().height).toBe(before);
    const title = row.querySelector('span.truncate')!;
    expect(getComputedStyle(title).whiteSpace).toBe('nowrap');
    expect(indicators[0].getBoundingClientRect().right).toBeLessThanOrEqual(
      row.getBoundingClientRect().right,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../../.vitest-screenshots/agent-completion-${width}.png`,
    });
    await page.getByRole('button', { name: /Ma fiche adhérent/ }).click();
    expect(
      screen.getAllByRole('img', { name: /Travail terminé/ }),
    ).toHaveLength(1);
    expect(completion.getState().unread.has('other')).toBe(true);
    expect(row.getBoundingClientRect().height).toBe(before);
  },
);
