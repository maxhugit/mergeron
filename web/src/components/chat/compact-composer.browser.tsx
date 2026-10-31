import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { Mic, Send } from 'lucide-react';
import { ModelSelector } from './model-selector';
import { SecurityPolicyBadge } from './security-policy-badge';
import { CapabilitiesMenu } from './capabilities-menu';
import { PlanModeBadge } from './plan-mode-badge';
import { Button } from '@/components/ui/button';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
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
afterEach(cleanup);

test.each([320, 500, 800])(
  'adapts the actual composer controls to a %ipx column in a wide window',
  async (width) => {
    await page.viewport(1214, 988);
    await i18nReady;
    await i18n.changeLanguage('fr');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div
          data-testid="composer"
          style={{ width }}
          className="@container/composer rounded-2xl border bg-card"
        >
          <textarea aria-label="Message" className="w-full" />
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
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
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span>29</span>
              <Button size="icon" aria-label="Micro">
                <Mic />
              </Button>
              <Button size="icon" aria-label="Envoyer">
                <Send />
              </Button>
            </div>
          </div>
        </div>
      </QueryClientProvider>,
    );
    const composer = screen.getByTestId('composer');
    const bounds = composer.getBoundingClientRect();
    for (const button of composer.querySelectorAll('button')) {
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
    expect(composer.scrollWidth).toBeLessThanOrEqual(composer.clientWidth);
    const modelLabel = screen.getByText('GPT-6-Sol');
    expect(modelLabel).toBeVisible();
    expect(screen.getByText('· medium')).toBeVisible();
    expect(
      screen.getByRole('button', { name: /GPT-6-Sol/ }).getAttribute('title'),
    ).toContain('medium');
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeVisible();
    if (width === 500)
      await page.screenshot({
        path: '../../../.vitest-screenshots/compact-composer.png',
      });
  },
);
