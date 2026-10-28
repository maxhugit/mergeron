import { beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect } from 'react';
import { BrowserSidebar } from './browser-sidebar';
import i18n from '@/i18n';
const api = vi.hoisted(() => vi.fn());
const insert = vi.hoisted(() => vi.fn());
const screenshot = vi.hoisted(() => vi.fn());
const ready = vi.hoisted(() => ({
  auto: true,
  onControl: undefined as ((id: string | null) => void) | undefined,
}));
vi.mock('@/lib/browser-api', () => ({ browserApi: api }));
vi.mock('./browser-live-viewport', () => ({
  BrowserLiveViewport: ({
    onControl,
    tabId,
  }: {
    onControl: (id: string | null) => void;
    tabId: string;
  }) => {
    useEffect(() => {
      ready.onControl = onControl;
      if (ready.auto) onControl('test-control');
    }, [onControl]);
    return <div data-tab-id={tabId}>Live view</div>;
  },
}));
vi.mock('@/lib/browser-annotations', () => ({
  insertBrowserAnnotation: insert,
  markedScreenshot: screenshot,
}));
const frame = {
  frameId: 'frame',
  url: 'https://example.com/',
  title: 'Example',
  image: 'data:image/jpeg;base64,anBlZw==',
  width: 1000,
  height: 700,
};
beforeEach(async () => {
  ready.auto = true;
  ready.onControl = undefined;
  await i18n.changeLanguage('en');
  insert.mockReset().mockResolvedValue(undefined);
  screenshot
    .mockReset()
    .mockResolvedValue(
      new File(['image'], 'annotation.png', { type: 'image/png' }),
    );
  api.mockReset().mockImplementation((path: string) => {
    if (path.endsWith('/tabs')) return Promise.resolve({ tabs: [] });
    if (path.endsWith('/new'))
      return Promise.resolve({
        id: 'tab',
        tabs: [{ id: 'tab', title: '', url: 'about:blank' }],
      });
    if (path.endsWith('/select'))
      return Promise.resolve({
        ...frame,
        selection: {
          id: 'point',
          url: frame.url,
          capturedAt: '2026-10-27',
          point: { x: 20, y: 30 },
          element: {
            tag: 'button',
            text: 'Save',
            selector: 'button:nth-child(1)',
            role: 'button',
            frame: false,
            box: { x: 10, y: 20, width: 100, height: 30 },
          },
        },
      });
    return Promise.resolve(frame);
  });
});
it('automatically opens the project default page in its own browser instance', async () => {
  render(
    <BrowserSidebar
      threadId="thread-a"
      instanceId="view-a"
      homeUrl="https://example.org/new"
      onClose={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/thread-a/navigate', {
      tabId: 'tab',
      url: 'https://example.org/new',
      instanceId: 'view-a',
      allowPopups: true,
    }),
  );
  expect(
    api.mock.calls.filter(([path]) => String(path).endsWith('/new')),
  ).toHaveLength(1);
});

it('starts live view only after an initial navigation has released the server lock', async () => {
  let finish!: (value: typeof frame) => void;
  const navigation = new Promise<typeof frame>((resolve) => {
    finish = resolve;
  });
  const standard = api.getMockImplementation()!;
  api.mockImplementation((path: string) =>
    path.endsWith('/navigate') ? navigation : standard(path),
  );
  render(<BrowserSidebar threadId="thread-a" onClose={vi.fn()} />);
  const address = screen.getByRole('textbox', { name: 'Page address' });
  await waitFor(() => expect(address).toBeEnabled());
  fireEvent.submit(address.closest('form')!);
  await waitFor(() =>
    expect(
      api.mock.calls.some(([path]) => String(path).endsWith('/navigate')),
    ).toBe(true),
  );
  expect(screen.queryByText('Live view')).toBeNull();
  finish(frame);
  expect(await screen.findByText('Live view')).toBeVisible();
});

it('selects a restored tab and navigates it without creating another', async () => {
  api.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith('/tabs')
        ? {
            tabs: [
              {
                id: 'restored',
                title: 'Existing',
                url: 'https://example.net/',
              },
            ],
          }
        : frame,
    ),
  );
  render(<BrowserSidebar threadId="thread-a" onClose={vi.fn()} />);
  const address = screen.getByRole('textbox', { name: 'Page address' });
  await waitFor(() => expect(address).toHaveValue('https://example.net/'));
  fireEvent.change(address, { target: { value: 'https://example.org/next' } });
  fireEvent.click(screen.getByRole('button', { name: /^Open$/ }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/thread-a/navigate', {
      tabId: 'restored',
      url: 'https://example.org/next',
      controlId: 'test-control',
      instanceId: undefined,
      allowPopups: true,
    }),
  );
  expect(api.mock.calls.some(([path]) => String(path).endsWith('/new'))).toBe(
    false,
  );
});

it('keeps navigation disabled until the selected page has its control lease', async () => {
  ready.auto = false;
  api.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith('/tabs')
        ? { tabs: [{ id: 'restored', title: 'Existing', url: frame.url }] }
        : frame,
    ),
  );
  render(<BrowserSidebar threadId="thread-a" onClose={vi.fn()} />);
  await screen.findByText('Live view');
  const open = screen.getByRole('button', { name: /^Open$/ });
  expect(open).toBeDisabled();
  fireEvent.submit(
    screen.getByRole('textbox', { name: 'Page address' }).closest('form')!,
  );
  expect(
    api.mock.calls.some(([path]) => String(path).endsWith('/navigate')),
  ).toBe(false);
  act(() => ready.onControl?.('owned'));
  expect(open).toBeEnabled();
  fireEvent.click(open);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/thread-a/navigate',
      expect.objectContaining({ controlId: 'owned' }),
    ),
  );
});

it('keeps reload and point actions in the address form without submitting it', async () => {
  render(<BrowserSidebar threadId="thread-a" onClose={vi.fn()} />);
  const form = screen
    .getByRole('textbox', { name: 'Page address' })
    .closest('form');
  for (const name of ['Reload', 'Point at an element']) {
    const action = screen.getByRole('button', { name });
    expect(action.closest('form')).toBe(form);
    expect(action).toHaveAttribute('type', 'button');
  }
});

it('restores the secondary window without displaying an internal tab bar', async () => {
  api.mockResolvedValue({
    tabs: [
      { id: 'first', title: 'First', url: frame.url },
      { id: 'second', title: 'Second', url: frame.url, popup: true },
    ],
  });
  render(<BrowserSidebar threadId="thread-a" onClose={vi.fn()} />);
  expect(
    await screen.findByText('Secondary window · same session'),
  ).toBeVisible();
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/thread-a/tabs']);
});

it('keeps the address editable after browser initialization fails', async () => {
  api.mockRejectedValue(new Error('Unavailable'));
  render(<BrowserSidebar threadId="thread-a" onClose={vi.fn()} />);
  await screen.findByRole('alert');
  const address = screen.getByRole('textbox', { name: 'Page address' });
  expect(address).toBeEnabled();
  fireEvent.change(address, { target: { value: 'https://example.org/retry' } });
  expect(address).toHaveValue('https://example.org/retry');
  expect(screen.getByRole('button', { name: /^Open$/ })).toBeEnabled();
});
it('restores a retained remote page on remount without navigating or resetting its state', async () => {
  api.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith('/tabs')
        ? {
            alive: true,
            tabs: [
              {
                id: 'retained',
                title: 'Retained',
                url: 'https://example.org/form',
              },
            ],
          }
        : frame,
    ),
  );
  const view = render(
    <BrowserSidebar
      threadId="thread-a"
      instanceId="browser-1"
      wasOpened
      onClose={vi.fn()}
    />,
  );
  expect(await screen.findByText('Live view')).toHaveAttribute(
    'data-tab-id',
    'retained',
  );
  view.unmount();
  render(
    <BrowserSidebar
      threadId="thread-a"
      instanceId="browser-1"
      wasOpened
      onClose={vi.fn()}
    />,
  );
  expect(await screen.findByText('Live view')).toHaveAttribute(
    'data-tab-id',
    'retained',
  );
  expect(
    api.mock.calls.some(([path]) =>
      /\/(new|navigate|close|dispose)$/.test(String(path)),
    ),
  ).toBe(false);
});
it('warns when a retained session is gone without silently opening Google', async () => {
  api.mockResolvedValue({ alive: false, tabs: [] });
  render(
    <BrowserSidebar
      threadId="thread-a"
      instanceId="browser-1"
      wasOpened
      onClose={vi.fn()}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'remote session expired',
  );
  expect(api.mock.calls.every(([path]) => String(path).endsWith('/tabs'))).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: /^Open$/ })).toBeEnabled();
});
it('shows a newly opened authentication window and returns to its opener after it closes', async () => {
  const main = { id: 'main', title: 'Main', url: frame.url };
  const popup = {
    id: 'popup',
    title: 'Authenticate',
    url: 'https://example.org/login',
    popup: true,
  };
  let entries = [main];
  api.mockImplementation((path: string) => {
    if (path.endsWith('/tabs')) return Promise.resolve({ tabs: entries });
    return Promise.resolve(frame);
  });
  render(
    <BrowserSidebar
      threadId="thread-a"
      instanceId="browser-1"
      onClose={vi.fn()}
    />,
  );
  expect(await screen.findByText('Live view')).toHaveAttribute(
    'data-tab-id',
    'main',
  );
  entries = [main, popup];
  await waitFor(
    () =>
      expect(screen.getByText('Live view')).toHaveAttribute(
        'data-tab-id',
        'popup',
      ),
    { timeout: 2500 },
  );
  expect(screen.getByText('Secondary window · same session')).toBeVisible();
  entries = [main];
  await waitFor(
    () =>
      expect(screen.getByText('Live view')).toHaveAttribute(
        'data-tab-id',
        'main',
      ),
    { timeout: 2500 },
  );
  expect(screen.queryByText('Secondary window · same session')).toBeNull();
});

it('opens tabs, navigates and adds evidence only to the keyed conversation draft', async () => {
  render(<BrowserSidebar threadId="thread-a" onClose={vi.fn()} />);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/thread-a/tabs', expect.anything()),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Point at an element' }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Point at an element' }));
  const image = await screen.findByRole('img');
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 700,
    width: 1000,
    height: 700,
    toJSON: () => ({}),
  });
  fireEvent.click(image, { clientX: 20, clientY: 30 });
  const comment = await screen.findByRole('textbox', {
    name: 'Describe the requested change…',
  });
  expect(insert).not.toHaveBeenCalled();
  fireEvent.change(comment, { target: { value: 'Make this clearer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add to chat draft' }));
  await waitFor(() =>
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-a',
        text: expect.stringContaining('Make this clearer'),
      }),
    ),
  );
  expect(insert.mock.calls[0][0].text).toContain('Untrusted webpage evidence');
  expect(insert.mock.calls[0][0].text).toContain('button:nth-child(1)');
  expect(await screen.findByRole('status')).toHaveTextContent(
    'added to the draft',
  );
});
it.each([
  ['BROWSER_NOT_CONFIGURED', 'not configured on this server'],
  ['BROWSER_RUNTIME_UNAVAILABLE', 'service cannot be reached'],
  ['BROWSER_ACCESS_DENIED', 'Access denied'],
])(
  'shows the specific error %s without blaming the URL',
  async (code, message) => {
    api.mockRejectedValue(new Error(code));
    render(<BrowserSidebar threadId="thread-b" onClose={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent('Only public');
  },
);
it('shows a configuration/error state without embedding remote HTML', async () => {
  api.mockRejectedValue(new Error('Unavailable'));
  const { container } = render(
    <BrowserSidebar threadId="thread-b" onClose={vi.fn()} />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'isolated browser configuration',
  );
  expect(container.querySelector('iframe')).toBeNull();
  expect(insert).not.toHaveBeenCalled();
});
