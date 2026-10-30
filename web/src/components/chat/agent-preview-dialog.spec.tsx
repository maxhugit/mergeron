import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentPreviewDialog, type AgentPreview } from './agent-preview-dialog';
import i18n, { i18nReady } from '@/i18n';

const api = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ isAdministrator: true }));
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => session,
}));

const address =
  'https://22222222-2222-4222-8222-222222222222.preview.example.org/help';
const grant =
  'https://22222222-2222-4222-8222-222222222222.preview.example.org/.__mergeron_preview/open#mergeron-preview=synthetic-ticket';
const prefix = '/project/agents/agent/preview';
const readyPreview: AgentPreview = {
  state: 'running',
  ready: true,
  url: address,
  sourcePath: '/workspaces/synthetic-project',
  error: null,
  expiresAt: null,
  lastSyncedAt: null,
  updateMode: 'hot',
  requiresRestart: false,
};
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  'clipboard',
);
let preview: AgentPreview;
let client: QueryClient;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  session.isAdministrator = true;
  preview = { ...readyPreview };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  api
    .mockReset()
    .mockImplementation(async (path: string) =>
      path.endsWith('/open') ? { url: grant } : { preview },
    );
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  if (originalClipboard)
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function mount() {
  return render(
    <QueryClientProvider client={client}>
      <AgentPreviewDialog
        projectId="project"
        threadId="agent"
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

it('shows a labelled read-only address and copies only the stable URL on request', async () => {
  session.isAdministrator = false;
  mount();
  const input = await screen.findByRole('textbox', {
    name: 'Test environment address',
  });
  expect(input).toHaveValue(address);
  expect(input).toHaveAttribute('readonly');
  expect(writeText).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.focus(input);
  expect((input as HTMLInputElement).selectionStart).toBe(0);
  expect((input as HTMLInputElement).selectionEnd).toBe(address.length);
  fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
  expect(await screen.findByText('URL copied.')).toBeVisible();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(address);
  expect(api).not.toHaveBeenCalledWith(prefix + '/open', expect.anything());
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

it('keeps the address selectable when the clipboard is denied', async () => {
  writeText.mockRejectedValue(new Error('permission denied'));
  mount();
  await screen.findByRole('textbox', { name: 'Test environment address' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Unable to copy the URL.',
  );
  expect(
    screen.getByRole('textbox', { name: 'Test environment address' }),
  ).toHaveValue(address);
  expect(api.mock.calls.some(([path]) => path.endsWith('/open'))).toBe(false);
});

it('opens through the existing access-grant endpoint without putting its ticket in the address field', async () => {
  const tab = {
    opener: window,
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
  const popup = vi
    .spyOn(window, 'open')
    .mockReturnValue(tab as unknown as Window);
  mount();
  await screen.findByRole('textbox', { name: 'Test environment address' });
  expect(popup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
  await waitFor(() =>
    expect(tab.location.replace).toHaveBeenCalledExactlyOnceWith(grant),
  );
  expect(popup).toHaveBeenCalledExactlyOnceWith('about:blank', '_blank');
  expect(tab.opener).toBeNull();
  expect(api).toHaveBeenCalledWith(prefix + '/open', { method: 'POST' });
  expect(
    screen.getByRole('textbox', { name: 'Test environment address' }),
  ).toHaveValue(address);
  expect(writeText).not.toHaveBeenCalled();
});

it('does not mint an access ticket if the native popup is blocked', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  mount();
  await screen.findByRole('textbox', { name: 'Test environment address' });
  fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('blocked');
  expect(api.mock.calls.some(([path]) => path.endsWith('/open'))).toBe(false);
});

it.each([
  'https://unrelated.example.org/.__mergeron_preview/open#ticket',
  'https://22222222-2222-4222-8222-222222222222.preview.example.org/wrong-path',
  'https://user:password@22222222-2222-4222-8222-222222222222.preview.example.org/.__mergeron_preview/open',
])('rejects an unrelated access-grant URL: %s', async (url) => {
  const tab = {
    opener: window,
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  api.mockImplementation(async (path: string) =>
    path.endsWith('/open') ? { url } : { preview },
  );
  mount();
  await screen.findByRole('textbox', { name: 'Test environment address' });
  fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
  await waitFor(() => expect(tab.close).toHaveBeenCalledOnce());
  expect(tab.location.replace).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
});

it.each([
  { state: 'starting', ready: false },
  { state: 'running', ready: false },
  { state: 'failed', ready: false },
  { state: 'stopped', ready: false },
  { state: 'stopped', ready: true },
  { url: null },
  { url: 'javascript:alert(1)' },
  { url: 'http://preview.example.org/' },
  { url: 'https://user:password@preview.example.org/' },
  { url: address + '#mergeron-preview=do-not-copy-a-ticket' },
])(
  'does not offer a URL for an unavailable or unsafe preview: %j',
  async (changes) => {
    preview = { ...preview, ...changes };
    mount();
    await waitFor(() => expect(api).toHaveBeenCalled());
    await screen.findByText(/State:/);
    expect(
      screen.queryByRole('textbox', { name: 'Test environment address' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy URL' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull();
  },
);

it('reveals the URL when the HTTP check becomes ready after the dialog is already open', async () => {
  preview.ready = false;
  mount();
  await screen.findByText(/waiting for a valid HTTP response/i);
  expect(
    screen.queryByRole('textbox', { name: 'Test environment address' }),
  ).toBeNull();
  preview = { ...preview, ready: true };
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ['agent-preview', 'project', 'agent'],
    });
  });
  expect(
    await screen.findByRole('textbox', { name: 'Test environment address' }),
  ).toHaveValue(address);
});

it('hides a cached ready URL when the latest status request failed', async () => {
  client.setQueryData(['agent-preview', 'project', 'agent'], { preview });
  api.mockRejectedValue(new Error('status unavailable'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
  expect(
    screen.queryByRole('textbox', { name: 'Test environment address' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull();
});
