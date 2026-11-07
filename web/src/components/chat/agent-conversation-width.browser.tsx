/** Use real timeline rows: clipping an oversized bubble is not responsive wrapping. */
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { TimelineEntryRow } from './timeline-entry-row';
import { TooltipProvider } from '@/components/ui/tooltip';
import { VirtualTranscript } from './virtual-transcript';
import { useAgentDisplayStore } from '@/stores/agent-display-store';
import { forgetTranscriptBookmarks } from '@/lib/transcript-anchor';
import { i18nReady } from '@/i18n';
import type { TimelineEntry } from '@/types/timeline';
import '@/index.css';

const threadId = 'width-regression';
const token = 'long_sans_espace_'.repeat(70);
const content = [
  'Question et réponse longues. '.repeat(90),
  `https://example.invalid/${token}`,
  `\`${token}\``,
  `> ${token}`,
  `\`\`\`text\n${token}\n\`\`\``,
  '| A | B | C | D | E | F |\n|---|---|---|---|---|---|\n| Un | Deux | Trois | Quatre | Cinq | Six |',
].join('\n\n');

afterEach(() => {
  cleanup();
  forgetTranscriptBookmarks([threadId]);
  useAgentDisplayStore.setState({ byThread: {} });
});

for (const width of [320, 390, 768, 1280])
  test.each(['collapsed', 'expanded'] as const)(
    `contains long questions and responses at ${width}px in %s mode`,
    async (mode) => {
      await page.viewport(width, 750);
      await i18nReady;
      useAgentDisplayStore.getState().record(threadId, mode);
      const entries: TimelineEntry[] = [
        {
          kind: 'user',
          content:
            content + `\n\n[Fichier_${token}](mention:/project/${token}.txt)`,
          images: [`/project/${token}.png`],
        },
        {
          kind: 'turn',
          turnId: 'answer',
          completed: true,
          items: [
            {
              type: 'agentMessage',
              itemId: 'answer-message',
              content,
              completed: true,
              questions: [],
            },
          ],
        },
        {
          kind: 'turn',
          turnId: 'stream',
          completed: false,
          items: [
            {
              type: 'agentMessage',
              itemId: 'stream-message',
              content,
              completed: false,
              questions: [],
            },
          ],
        },
      ];
      const view = render(
        <TooltipProvider>
          <main className="flex h-dvh min-h-0 min-w-0 flex-col bg-background text-foreground">
            <VirtualTranscript
              threadId={threadId}
              keys={['question', 'answer', 'stream']}
              active
              ready
              bottomInset={0}
              scrollSignal={0}
              renderRow={(index) => (
                <TimelineEntryRow
                  entry={entries[index]}
                  threadCwd={null}
                  threadId={threadId}
                  canBranch={false}
                  versionsByTurnId={new Map()}
                  deleteBlockedReason={null}
                  deletingThreadIds={new Set()}
                  onDeleteVersion={() => {}}
                  onEdit={() => {}}
                  t={(key) => key}
                />
              )}
            />
            <footer className="shrink-0 p-3">Saisie</footer>
          </main>
        </TooltipProvider>,
      );
      const scroller = view.container.querySelector<HTMLElement>(
        '[data-transcript-scroller]',
      )!;
      await expect
        .poll(
          () =>
            view.container.querySelectorAll('[data-transcript-column]').length,
        )
        .toBe(3);
      const columns = [
        ...view.container.querySelectorAll<HTMLElement>(
          '[data-transcript-column]',
        ),
      ];
      for (const column of columns) {
        const bounds = column.getBoundingClientRect();
        const bubble = column.querySelector<HTMLElement>(
          '.group\\/user > div, .glass-1.min-w-0',
        )!;
        expect(bubble).not.toBeNull();
        const bubbleBounds = bubble.getBoundingClientRect();
        expect(bubbleBounds.left).toBeGreaterThanOrEqual(bounds.left);
        expect(bubbleBounds.right).toBeLessThanOrEqual(bounds.right);
        for (const block of bubble.querySelectorAll('p, blockquote, pre')) {
          const rect = block.getBoundingClientRect();
          expect(rect.left).toBeGreaterThanOrEqual(bubbleBounds.left);
          expect(rect.right).toBeLessThanOrEqual(bubbleBounds.right);
        }
        for (const block of bubble.querySelectorAll<HTMLElement>(
          'p, [role="button"]',
        )) {
          expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth + 1);
        }
      }
      expect(getComputedStyle(scroller).overflowX).toBe('hidden');
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      scroller.scrollTop = 0;
      await page.screenshot({
        path: `../../../.vitest-screenshots/agent-width-${width}-${mode}-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}.png`,
      });
      scroller.scrollTop = scroller.scrollHeight;
      await page.screenshot({
        path: `../../../.vitest-screenshots/agent-answer-width-${width}-${mode}-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}.png`,
      });
    },
  );
