/** Actual header and profile typography; synthetic account and private preference fixtures only. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { ChatHeader } from './chat-header';
import { ProfileTextSizeApplier } from '@/components/account/profile-text-size';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  platformSessionKey,
  type PlatformSession,
} from '@/lib/platform-session';
import {
  accountReadAccountQueryKey,
  accountReadRateLimitsQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { useAccountStore } from '@/stores/account-store';
import { useConnectionStore } from '@/stores/connection-store';
import { useTimelineStore } from '@/stores/timeline-store';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const saved = vi.hoisted(() => ({
  sizes: { mobile: 100, tablet: 100, desktop: 100 },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: '/t/header-fixture', search: {} } }),
}));
vi.mock('@/hooks/use-message-branches', () => ({
  useMessageVersions: () => ({ isTracked: false }),
}));
vi.mock('@/components/branches/branch-graph-dialog', () => ({
  BranchGraphDialog: () => null,
}));
vi.mock('./mcp-status-badge', () => ({ McpStatusBadge: () => null }));
vi.mock('@/lib/platform-session', async (original) => ({
  ...(await original<typeof import('@/lib/platform-session')>()),
  usePlatformSession: () => {
    const { data } = useQuery<PlatformSession>({
      queryKey: ['platform-session'],
      enabled: false,
      queryFn: () => Promise.reject(Error('No identity network in fixture')),
    });
    return { data, isAdministrator: data?.role === 'administrator' };
  },
  updateAuthResource: async (
    _path: string,
    body: {
      textSize?: { support: 'mobile' | 'tablet' | 'desktop'; percent: number };
      language?: string;
    },
  ) => {
    if (body.language) return { language: body.language };
    if (!body.textSize) throw Error('Missing preference');
    saved.sizes[body.textSize.support] = body.textSize.percent;
    return { textSizes: { ...saved.sizes } };
  },
}));
let client: QueryClient;
let wasDark: boolean;
export function Fixture() {
  const { data } = useQuery<PlatformSession>({
    queryKey: platformSessionKey,
    enabled: false,
    queryFn: () => Promise.reject(Error('No identity network in fixture')),
  });
  return (
    <TooltipProvider>
      <ProfileTextSizeApplier sizes={data?.textSizes} />
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <ChatHeader />
        <p data-testid="sample-text" className="p-4 text-base">
          Conversation · sample text
        </p>
      </div>
    </TooltipProvider>
  );
}
const ui = () => (
  <QueryClientProvider client={client}>
    <Fixture />
  </QueryClientProvider>
);
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  await i18n.loadNamespaces(['headerControls', 'pwa']);
  wasDark = document.documentElement.classList.contains('dark');
  document.documentElement.classList.add('dark');
  client = new QueryClient();
  saved.sizes = { mobile: 100, tablet: 100, desktop: 90 };
  client.setQueryData(platformSessionKey, {
    kind: 'person',
    personId: 'synthetic-person',
    active: true,
    role: 'administrator',
    textSizes: { ...saved.sizes },
  });
  client.setQueryData(accountReadAccountQueryKey(), {
    account: {
      type: 'chatgpt',
      email: 'fixture@example.invalid',
      planType: 'plus',
    },
    requiresOpenaiAuth: false,
  });
  client.setQueryData(accountReadRateLimitsQueryKey(), {
    rateLimits: {
      primary: { usedPercent: 42, resetsAt: null, windowDurationMins: 300 },
      secondary: { usedPercent: 7, resetsAt: null, windowDurationMins: 10080 },
    },
  });
  useAccountStore.setState({ account: null, rateLimits: null });
  useConnectionStore.setState({ connected: true });
  useTimelineStore
    .getState()
    .setActiveThread('header-fixture', '/synthetic', 'Compact header');
});
afterEach(() => {
  cleanup();
  document.documentElement.classList.toggle('dark', wasDark);
  client.clear();
});
for (const width of [390, 800, 1280])
  test(`groups quota, connection and actions without header overflow at ${width}px, including 150% text`, async () => {
    await page.viewport(width, 844);
    if (width >= 1024) {
      saved.sizes.desktop = 100;
      client.setQueryData<PlatformSession>(platformSessionKey, (current) =>
        current ? { ...current, textSizes: { ...saved.sizes } } : current,
      );
    }
    const view = render(ui());
    expect(
      screen.queryByRole('button', { name: 'Refresh the app' }),
    ).toBeNull();
    await page.getByRole('button', { name: 'More actions' }).click();
    expect(await screen.findByText('Codex account')).toBeVisible();
    expect(screen.getByText('42%')).toBeVisible();
    expect(screen.getByText('7%')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Mergeron documentation' }),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Suggest an improvement' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/maxhugit/mergeron/issues/new?template=feature_request.yml',
    );
    expect(
      screen.getByRole('link', { name: 'Report an issue' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/maxhugit/mergeron/issues/new?template=bug_report.yml',
    );
    expect(
      screen.queryByText('Saved in your profile for this screen category.'),
    ).toBeNull();
    expect(screen.getByText('Connected')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Platform' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Refresh the app' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Increase text size' }).click();
    await waitFor(() =>
      expect(document.documentElement.style.fontSize).toBe('110%'),
    );
    expect(
      parseFloat(getComputedStyle(screen.getByTestId('sample-text')).fontSize),
    ).toBeCloseTo(17.6, 1);
    await page.screenshot({
      path: `../../../.vitest-screenshots/compact-header-${width}.png`,
    });
    await page.getByRole('button', { name: 'Français', exact: true }).click();
    expect(await screen.findByText('Compte Codex')).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Français' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/compact-header-${width}-fr.png`,
    });
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await screen.findByRole('button', { name: 'Increase text size' });
    for (let percent = 120; percent <= 150; percent += 10) {
      await page.getByRole('button', { name: 'Increase text size' }).click();
      await waitFor(() =>
        expect(document.documentElement.style.fontSize).toBe(`${percent}%`),
      );
    }
    expect(
      screen.getByRole('button', { name: 'Increase text size' }),
    ).toBeDisabled();
    const header = document.querySelector('header')!;
    expect(header.scrollWidth).toBeLessThanOrEqual(width);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/compact-header-${width}-large.png`,
    });
    view.unmount();
    client.setQueryData(platformSessionKey, {
      ...client.getQueryData<PlatformSession>(platformSessionKey)!,
      textSizes: { ...saved.sizes },
    });
    render(ui());
    expect(document.documentElement.style.fontSize).toBe('150%');
    await page.viewport(1200, 844);
    await waitFor(() =>
      expect(document.documentElement.style.fontSize).toBe(
        width >= 1024 ? '150%' : '90%',
      ),
    );
    await page.getByRole('button', { name: 'More actions' }).click();
    expect(
      screen.getByRole('button', { name: 'Refresh the app' }),
    ).toBeVisible();
  });
