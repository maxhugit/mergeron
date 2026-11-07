/** Real composer mutation and message rows; no account, agent or external request. */
import { cleanup, render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ChatInput } from './chat-input';
import { TimelineEntryRow } from './timeline-entry-row';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTimelineStore } from '@/stores/timeline-store';
import { useComposerDraftStore } from '@/stores/composer-draft-store';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const calls = vi.hoisted(() => ({
  steer: vi.fn(),
  start: vi.fn(),
  interrupt: vi.fn(),
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    connected: false,
  }),
}));
vi.mock('@/generated/api/@tanstack/react-query.gen', async (original) => ({
  ...(await original<
    typeof import('@/generated/api/@tanstack/react-query.gen')
  >()),
  threadsSteerTurnMutation: () => ({ mutationFn: calls.steer }),
  threadsStartTurnMutation: () => ({ mutationFn: calls.start }),
  threadsInterruptTurnMutation: () => ({ mutationFn: calls.interrupt }),
}));
vi.mock('@/hooks/use-thread-security-policy', () => ({
  useThreadSecurityPolicy: () => ({ isSettling: false }),
}));
vi.mock('@/hooks/use-slash-dispatch', () => ({
  useSlashDispatch: () => ({
    runCommand: vi.fn(),
    setDialog: vi.fn(),
    togglePlanMode: vi.fn(),
    dialog: null,
  }),
}));
vi.mock('./model-selector', () => ({
  ModelSelector: () => <span>Modèle</span>,
}));
vi.mock('./security-policy-badge', () => ({ SecurityPolicyBadge: () => null }));
vi.mock('./capabilities-menu', () => ({ CapabilitiesMenu: () => null }));
vi.mock('./token-usage-ring', () => ({ TokenUsageRing: () => null }));
vi.mock('./voice-dictation-button', () => ({
  VoiceDictationButton: () => null,
}));
vi.mock('./goal-progress-row', () => ({ GoalProgressRow: () => null }));
vi.mock('./plan-mode-badge', () => ({ PlanModeBadge: () => null }));
vi.mock('./slash-dialogs', () => ({ SlashDialogs: () => null }));

const initial = useTimelineStore.getState();
export function Conversation() {
  const timeline = useTimelineStore(
    (state) => state.threadsById.a?.timeline ?? [],
  );
  return (
    <main className="flex h-dvh min-w-0 flex-col bg-background text-foreground">
      <div
        className="min-h-0 flex-1 overflow-auto p-3"
        aria-label="Fil de discussion"
      >
        {timeline.map((entry, index) => (
          <TimelineEntryRow
            key={index}
            entry={entry}
            threadId="a"
            threadCwd={null}
            canBranch={false}
            versionsByTurnId={new Map()}
            deletingThreadIds={new Set()}
            deleteBlockedReason={null}
            onDeleteVersion={() => {}}
            onEdit={() => {}}
            t={(key) => key}
          />
        ))}
      </div>
      <ChatInput conversationId="a" />
    </main>
  );
}
afterEach(() => {
  cleanup();
  useTimelineStore.setState(initial, true);
  useComposerDraftStore.setState({ drafts: {}, forgotten: new Set() });
  vi.unstubAllGlobals();
});

test.each([390, 1180])(
  'shows steering during reflection before HTTP confirmation, with no duplicate echo at %ipx',
  async (width) => {
    await page.viewport(width, 800);
    await i18nReady;
    await i18n.changeLanguage('fr');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{}', {
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );
    useTimelineStore.setState(initial, true);
    const store = useTimelineStore.getState();
    store.selectThread('a');
    store.hydrateOpenedThread({
      threadId: 'a',
      turnsNewestFirst: [],
      historyCursor: null,
      readOnlyReason: null,
    });
    store.setOpenStateForThread('a', { openState: 'ready' });
    store.addUserMessage('Prépare le document');
    store.setActiveTurnIdForThread('a', 'turn');
    store.updateCurrentTurnForThread('a', 'turn', () => ({
      items: [
        {
          type: 'agentMessage',
          itemId: 'thinking',
          content: 'Je travaille sur le document…',
          questions: [],
          completed: false,
        },
      ],
      completed: false,
    }));
    store.upsertUserMessageForThread('a', 'turn', {
      itemId: 'original',
      text: 'Prépare le document',
      images: [],
    });
    let finish!: (value: { turnId: string }) => void;
    calls.start.mockReset();
    calls.interrupt.mockReset();
    calls.steer.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <Conversation />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await page.getByRole('textbox').fill('Ajoute une synthèse en français');
    await page
      .getByRole('button', { name: i18n.t('steer'), exact: true })
      .click();
    expect(
      await screen.findByText('Ajoute une synthèse en français'),
    ).toBeVisible();
    expect(screen.getByText('Je travaille sur le document…')).toBeVisible();
    expect(calls.steer).toHaveBeenCalledTimes(1);
    expect(calls.start).not.toHaveBeenCalled();
    expect(calls.interrupt).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().activeTurnId).toBe('turn');
    await act(async () => {
      store.upsertUserMessageForThread('a', 'turn', {
        itemId: 'instruction',
        text: 'Ajoute une synthèse en français',
        images: [],
      });
      finish({ turnId: 'turn' });
    });
    expect(screen.getAllByText('Ajoute une synthèse en français')).toHaveLength(
      1,
    );
    expect(
      screen.getAllByRole('button', { name: 'editThisMessage' }),
    ).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/steering-message-${width}-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}.png`,
    });
    client.clear();
  },
);
