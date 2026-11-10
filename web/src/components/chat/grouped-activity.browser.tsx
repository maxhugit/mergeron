import { afterEach, expect, test } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TurnBlock } from './turn-block';
import { useTechnicalGrouping } from '@/hooks/use-group-technical';
import { useTimelineStore } from '@/stores/timeline-store';
import type { TurnItem } from '@/types/timeline';
afterEach(() => {
  cleanup();
  useTechnicalGrouping.setState({ grouped: false });
});
test.each([390, 1100])(
  'groups activity and shows frozen elapsed time at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 800);
    useTechnicalGrouping.setState({ grouped: true });
    useTimelineStore.setState({ threadId: 'fixture', activeTurnId: null });
    const command = (id: string): TurnItem => ({
      type: 'commandExecution',
      itemId: id,
      completed: true,
      command: 'git status --short',
      content: 'Working tree clean',
      exitCode: 0,
    });
    const message: TurnItem = {
      type: 'agentMessage',
      itemId: 'answer',
      completed: true,
      questions: [],
      content:
        'Les changements sont enregistrés. Je vérifie maintenant le résultat.',
    };
    render(
      <TooltipProvider>
        <main className="min-h-dvh bg-background p-4 text-foreground">
          <TurnBlock
            entry={{
              kind: 'turn',
              turnId: 'fixture-turn',
              completed: true,
              status: 'completed',
              durationMs: 154000,
              items: [
                command('one'),
                command('two'),
                message,
                command('three'),
              ],
            }}
          />
        </main>
      </TooltipProvider>,
    );
    const clock = screen.getByText('Terminé · 2 min 34 s');
    expect(clock).toBeVisible();
    const response = document.querySelector('[data-agent-response]')!;
    expect(clock.closest('[data-agent-response]')).toBeNull();
    expect(clock.getBoundingClientRect().bottom).toBeLessThan(
      response.getBoundingClientRect().top,
    );
    const first = screen.getByText('Activités techniques · 2 opérations');
    const panel = first.closest('details')!;
    expect(panel.open).toBe(false);
    act(() => {
      panel.open = true;
      fireEvent(panel, new Event('toggle'));
    });
    expect(panel.querySelectorAll('[data-transcript-item]')).toHaveLength(2);
    expect(screen.getByText(message.content)).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/grouped-activity-${width}.png`,
    });
  },
);
