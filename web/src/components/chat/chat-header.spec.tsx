import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatHeader } from './chat-header';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTimelineStore } from '@/stores/timeline-store';
import { simpleChatThreadsQueryKey } from '@/lib/simple-chat-api';
import { useBreakpoint } from '@/hooks/use-breakpoint';

let pathname = '/simple-chat';
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

function renderHeader(simpleChatTitle?: string) {
  const client = new QueryClient();
  if (simpleChatTitle) {
    client.setQueryData(simpleChatThreadsQueryKey, {
      threads: [
        {
          id: 'simple-123',
          title: simpleChatTitle,
          model: 'gpt-5-mini',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
  }
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
    pathname = '/simple-chat';
    search = {};
    useTimelineStore
      .getState()
      .setActiveThread('thread-123', '/workspaces/demo', 'Titre conservé');
  });

  it.each(['mobile', 'tablet', 'desktop'] as const)(
    'keeps the explicit refresh button available on %s',
    (breakpoint) => {
      vi.mocked(useBreakpoint).mockReturnValue(breakpoint);
      renderHeader();
      expect(
        screen.getByRole('button', { name: 'Refresh the app' }),
      ).toBeEnabled();
    },
  );

  it('shows the selected Simple Chat title in the global header', () => {
    search = { thread: 'simple-123' };
    renderHeader('Actualités tech');

    expect(
      screen.getByRole('heading', { name: 'Actualités tech' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Mergeron' }),
    ).not.toBeInTheDocument();
  });

  it('does not leak the cached Codex thread title into Simple Chat', () => {
    renderHeader();

    expect(
      screen.getByRole('heading', { name: 'Mergeron' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Titre conservé')).not.toBeInTheDocument();
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
