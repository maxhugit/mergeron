import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatHeader } from './chat-header';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTimelineStore } from '@/stores/timeline-store';
import { useBreakpoint } from '@/hooks/use-breakpoint';

let pathname = '/';
let search: { thread?: string; section?: string } = {};

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname, search } }),
}));

vi.mock('@/hooks/use-breakpoint', () => ({
  useBreakpoint: vi.fn(() => 'desktop'),
  useIsMobile: () => false,
}));

vi.mock('@/hooks/use-message-branches', () => ({
  useMessageVersions: () => ({ isTracked: false }),
}));

vi.mock('./account-rate-limit-badge', () => ({
  AccountRateLimitBadge: () => null,
}));

vi.mock('./mcp-status-badge', () => ({
  McpStatusBadge: () => null,
}));

function renderHeader() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ChatHeader />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('ChatHeader', () => {
  beforeEach(() => {
    vi.mocked(useBreakpoint).mockReturnValue('desktop');
    pathname = '/';
    search = {};
    useTimelineStore
      .getState()
      .setActiveThread('thread-123', '/workspaces/demo', 'Titre conservé');
  });

  it.each(['mobile', 'tablet', 'desktop'] as const)(
    'keeps the explicit refresh button available on %s',
    async (breakpoint) => {
      vi.mocked(useBreakpoint).mockReturnValue(breakpoint);
      renderHeader();
      {
        expect(
          screen.queryByRole('button', { name: 'Refresh the app' }),
        ).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      }
      expect(
        await screen.findByRole('button', { name: 'Refresh the app' }),
      ).toBeEnabled();
    },
  );

  it('does not label a read-only fallback as an archived conversation', () => {
    pathname = '/t/thread-123';
    useTimelineStore.setState({ threadMode: 'readOnly' });
    renderHeader();
    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.queryByText('Archived read-only')).toBeNull();
  });

  it('shows the active title on an actual Codex thread route', () => {
    pathname = '/t/thread-123';
    renderHeader();

    expect(screen.getByText('Titre conservé')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Mergeron' }),
    ).not.toBeInTheDocument();
  });

  it('shows the current administration section in the global header', () => {
    pathname = '/settings';
    search = { section: 'people' };
    renderHeader();

    expect(screen.getByRole('heading', { name: 'People' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Create people before they connect. The manual reference uniquely identifies each person.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Mergeron' }),
    ).not.toBeInTheDocument();
  });
});
