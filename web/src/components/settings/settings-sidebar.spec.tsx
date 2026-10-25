import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsSidebar } from './settings-sidebar';
import { useLayoutStore } from '@/stores/layout-store';
import { serverReleaseQueryKey } from './server-release-api';

const routing = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: { pathname: '/settings', search: { section: 'general' } },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => routing.navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: routing.location }),
}));
vi.mock('./codex-cli-api', () => ({
  requestCli: async () => ({
    installationState: 'installed',
    updateAvailable: false,
  }),
}));
let client: QueryClient;
const renderSidebar = () =>
  render(
    <QueryClientProvider client={client}>
      <SettingsSidebar />
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  client.clear();
});
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(serverReleaseQueryKey, {
    updateAvailable: false,
    checkError: null,
  });
  routing.navigate.mockClear();
  routing.location = { pathname: '/settings', search: { section: 'general' } };
  useLayoutStore.setState({ sidebarOpen: true });
});

it('separates server settings from operations and closes the mobile drawer on section selection', () => {
  renderSidebar();
  expect(screen.getByRole('heading', { name: 'Administration' })).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: 'Operations tools' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Server' }).getAttribute('aria-current'),
  ).toBe('page');
  fireEvent.click(screen.getByRole('button', { name: 'OnlyOffice' }));
  expect(routing.navigate).toHaveBeenCalledWith({
    to: '/settings',
    search: { section: 'onlyOffice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'File settings' }));
  expect(routing.navigate).toHaveBeenCalledWith({
    to: '/settings',
    search: { section: 'files' },
  });
  expect(useLayoutStore.getState().sidebarOpen).toBe(false);
});

it('keeps global tools distinct from their configuration and supports returning to projects', () => {
  renderSidebar();
  fireEvent.click(screen.getByRole('button', { name: 'Files' }));
  expect(routing.navigate).toHaveBeenLastCalledWith({ to: '/files' });
  fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
  expect(routing.navigate).toHaveBeenLastCalledWith({ to: '/terminal' });
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  expect(routing.navigate).toHaveBeenLastCalledWith({ to: '/diagnostics' });
  fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
  expect(routing.navigate).toHaveBeenLastCalledWith({ to: '/' });
});

it('marks the current operations tool rather than a settings category', () => {
  routing.location.pathname = '/files';
  renderSidebar();
  expect(
    screen.getByRole('button', { name: 'Files' }).getAttribute('aria-current'),
  ).toBe('page');
  expect(
    screen
      .getByRole('button', { name: 'File settings' })
      .getAttribute('aria-current'),
  ).toBeNull();
});

it('routes Infrastructure to its own section and marks it selected', () => {
  routing.location.search.section = 'infrastructure';
  renderSidebar();
  const button = screen.getByRole('button', { name: 'Infrastructure' });
  expect(button).toHaveAttribute('aria-current', 'page');
  fireEvent.click(button);
  expect(routing.navigate).toHaveBeenLastCalledWith({
    to: '/settings',
    search: { section: 'infrastructure' },
  });
  expect(useLayoutStore.getState().sidebarOpen).toBe(false);
});
it('shows a server update indicator from the shared discovery and removes it when current', async () => {
  renderSidebar();
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => {
    client.setQueryData(serverReleaseQueryKey, {
      updateAvailable: true,
      checkError: null,
    });
  });
  expect(
    await screen.findByRole('status', {
      name: 'A new Mergeron image is available.',
    }),
  ).toBeVisible();
  await act(async () => {
    client.setQueryData(serverReleaseQueryKey, {
      updateAvailable: false,
      checkError: null,
    });
  });
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});
it('does not advertise an update when discovery reports an error', () => {
  client.setQueryData(serverReleaseQueryKey, {
    updateAvailable: true,
    checkError: 'unavailable',
  });
  renderSidebar();
  expect(screen.queryByRole('status')).toBeNull();
});
