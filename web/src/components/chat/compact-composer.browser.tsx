import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { Send, Square } from 'lucide-react';
import { ModelSelector } from './model-selector';
import { SecurityPolicyBadge } from './security-policy-badge';
import { CapabilitiesMenu } from './capabilities-menu';
import { PlanModeBadge } from './plan-mode-badge';
import { Button } from '@/components/ui/button';
import { ComposerActionGroup } from './composer-action-group';
import { ComposerToolbar } from './composer-toolbar';
import { TokenUsageRing } from './token-usage-ring';
import { VoiceDictationButton } from './voice-dictation-button';
import { useTimelineStore } from '@/stores/timeline-store';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
vi.mock('@/hooks/use-thread-execution-preferences', () => ({
  useThreadExecutionPreferences: () => ({
    preferences: undefined,
    busy: false,
    error: false,
    save: vi.fn(),
    retry: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-active-model', () => ({
  useActiveModel: () => ({
    models: [],
    hiddenModels: [],
    activeModelId: 'gpt-6-sol',
    activeModel: {
      model: 'gpt-6-sol',
      displayName: 'GPT-6-Sol',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [],
    },
    configModel: 'gpt-6-sol',
  }),
}));
vi.mock('@/hooks/use-current-project', () => ({
  useCurrentProject: () => null,
}));
vi.mock('@/hooks/use-thread-security-policy', () => ({
  useThreadSecurityPolicy: () => ({
    observed: {
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'on-request',
    },
    isSettling: false,
  }),
}));
vi.mock('@/lib/projects-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects-api')>()),
  projectsApi: () => Promise.resolve({ projects: [] }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useTimelineStore.setState({ latestTokenUsage: null });
  document.documentElement.classList.remove('ios-standalone', 'dark');
});

test.each([
  [320, 390, 844, false, false],
  [320, 390, 844, false, true],
  [366, 390, 844, true, false],
  [366, 390, 844, true, true],
  [500, 1214, 988, false, false],
  [614, 1274, 913, false, false],
  [614, 1274, 913, false, true],
  [700, 1214, 988, false, false],
  [700, 1214, 988, false, true],
  [800, 1214, 988, false, false],
  [1200, 1400, 988, false, false],
] as const)(
  'centres the composer actions in a %ipx column, viewport %ix%i (iOS: %s, active turn: %s)',
  async (width, viewportWidth, viewportHeight, installedIos, activeTurn) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await page.viewport(viewportWidth, viewportHeight);
    document.documentElement.classList.toggle('ios-standalone', installedIos);
    document.documentElement.classList.add('dark');
    const usage = {
      totalTokens: 34_000,
      inputTokens: 34_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };
    useTimelineStore.setState({
      latestTokenUsage: {
        last: usage,
        total: usage,
        modelContextWindow: 100_000,
      },
    });
    await i18nReady;
    await i18n.changeLanguage('fr');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div
          data-testid="composer"
          style={{ width }}
          className="@container/composer rounded-2xl border bg-card"
        >
          <textarea
            aria-label="Message"
            placeholder="Tapez un message…"
            rows={1}
            className="min-h-20 w-full resize-none border-none bg-transparent px-3 pt-2.5"
          />
          <ComposerToolbar
            controls={
              <>
                <ModelSelector />
                <PlanModeBadge
                  state={{
                    mode: 'plan',
                    observed: true,
                    source: 'notification',
                    model: 'gpt-6-sol',
                    reasoningEffort: 'medium',
                  }}
                  pending={false}
                  disabled={false}
                  onToggle={() => {}}
                />
                <SecurityPolicyBadge threadId="thread" />
                <CapabilitiesMenu cwd="/workspace" onSelectSkill={() => {}} />
              </>
            }
          >
            <ComposerActionGroup>
              <TokenUsageRing />
              <VoiceDictationButton onTranscript={() => {}} />
              {activeTurn ? (
                <>
                  <Button size="sm" className="h-7" aria-label="Diriger">
                    Diriger
                  </Button>
                  <Button
                    size="icon"
                    className="h-7 w-7"
                    variant="destructive"
                    aria-label="Arrêter"
                  >
                    <Square />
                  </Button>
                </>
              ) : (
                <Button size="icon" className="h-7 w-7" aria-label="Envoyer">
                  <Send />
                </Button>
              )}
            </ComposerActionGroup>
          </ComposerToolbar>
        </div>
      </QueryClientProvider>,
    );
    const composer = screen.getByTestId('composer');
    const bounds = composer.getBoundingClientRect();
    const toolbar = composer.lastElementChild!;
    const actions = toolbar.lastElementChild!;
    const toolbarBounds = toolbar.getBoundingClientRect();
    const actionBounds = actions.getBoundingClientRect();
    // The final 36px toolbar row has 4px of visual clearance above/below the
    // 28px actions. Extra horizontal clearance keeps focus rings off the edge.
    expect(toolbarBounds.bottom - actionBounds.bottom).toBe(4);
    expect(toolbarBounds.right - actionBounds.right).toBe(8);
    const centres = [...actions.children].map((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(0.1);
    expect(screen.getByText('34')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Démarrer la dictée' }),
    ).toBeVisible();
    for (const button of composer.querySelectorAll('button')) {
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
    expect(composer.scrollWidth).toBeLessThanOrEqual(composer.clientWidth);
    const modelLabel = screen.getByText('GPT-6-Sol');
    if (width >= 480) expect(modelLabel).toBeVisible();
    else expect(modelLabel).not.toBeVisible();
    if (width > 800) expect(screen.getByText('· medium')).toBeVisible();
    else expect(screen.getByText('· medium')).not.toBeVisible();
    const controls = toolbar.firstElementChild!.getBoundingClientRect();
    if (width >= 366) {
      expect(
        Math.abs(
          controls.top +
            controls.height / 2 -
            (actionBounds.top + actionBounds.height / 2),
        ),
      ).toBeLessThan(0.1);
    }
    expect(
      screen.getByRole('button', { name: /GPT-6-Sol/ }).getAttribute('title'),
    ).toContain('medium');
    expect(
      screen.getByRole('button', {
        name: activeTurn ? 'Arrêter' : 'Envoyer',
      }),
    ).toBeVisible();
    await page.screenshot({
      path: `../../../.vitest-screenshots/composer-alignment-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}-${width}-${activeTurn ? 'active' : 'idle'}.png`,
    });
  },
);
