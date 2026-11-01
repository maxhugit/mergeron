import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { page, userEvent } from 'vitest/browser';
import { SecurityPolicyBadge } from './security-policy-badge';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { useTimelineStore } from '@/stores/timeline-store';

const mocked = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock('@/hooks/use-thread-security-policy', () => ({
  useThreadSecurityPolicy: () => ({
    observed: {
      observed: true,
      source: 'notification',
      approvalPolicy: 'never',
      approvalMode: 'manual',
      activePermissionProfileId: 'mergeron_copy_fixture',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    },
    apply: mocked.apply,
    isSettling: false,
  }),
}));
vi.mock('@/hooks/use-thread-execution-preferences', () => ({
  useThreadExecutionPreferences: () => ({ preferences: undefined }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { projects: [], available: false } }),
}));
afterEach(() => {
  cleanup();
  mocked.apply.mockReset();
  document.documentElement.classList.remove('dark');
});

test.each([390, 980])(
  'confirms automatic approvals without widening copy permissions at %ipx',
  async (width) => {
    useTimelineStore.setState({
      threadId: 'fixture-agent',
      threadCwd: '/workspaces/project/copy',
    });
    await page.viewport(width, 913);
    document.documentElement.classList.add('dark');
    await i18nReady;
    await i18n.changeLanguage('fr');
    render(
      <div className="dark flex h-[850px] items-end bg-background p-4 text-foreground">
        <SecurityPolicyBadge threadId="fixture-agent" />
      </div>,
    );
    await page.getByRole('button', { name: /cette conversation/i }).click();
    await expect
      .element(
        page.getByRole('button', {
          name: 'Accès complet non restreint',
          exact: true,
        }),
      )
      .toBeDisabled();
    const popover = screen.getByRole('dialog');
    expect(popover.getBoundingClientRect().height).toBeLessThan(550);
    await page.screenshot({
      path: `../../../.vitest-screenshots/policy-compact-${navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit'}-${width}.png`,
    });
    await page
      .getByRole('button', { name: 'Sur demande', exact: true })
      .hover();
    await expect
      .element(page.getByRole('tooltip'))
      .toHaveTextContent('Vous décidez');
    expect(mocked.apply).not.toHaveBeenCalled();
    await page
      .getByRole('button', {
        name: 'Explication : Accès complet non restreint',
        exact: true,
      })
      .click();
    await expect
      .element(page.getByText(/L’agent peut passer en lecture seule/))
      .toBeVisible();
    expect(mocked.apply).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    await page
      .getByRole('button', { name: 'Toujours autoriser', exact: true })
      .click();
    await expect.element(page.getByRole('alertdialog')).toBeVisible();
    expect(mocked.apply).not.toHaveBeenCalled();
    const engine = navigator.userAgent.includes('Chrome')
      ? 'chromium'
      : 'webkit';
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-approval-${engine}-${width}.png`,
    });
    await page.getByRole('button', { name: 'Confirmer', exact: true }).click();
    expect(mocked.apply).toHaveBeenCalledExactlyOnceWith({
      approvalPolicy: 'on-request',
      approvalMode: 'automatic',
    });
  },
);
