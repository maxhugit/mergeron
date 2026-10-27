import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserSidebar } from './browser-sidebar';
import i18n from '@/i18n';
const api = vi.hoisted(() => vi.fn());
const insert = vi.hoisted(() => vi.fn());
const screenshot = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-api', () => ({ browserApi: api }));
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
it('accepts an address in an empty session and creates a tab only when submitted', async () => {
  render(<BrowserSidebar threadId="thread-a" onClose={vi.fn()} />);
  const address = screen.getByRole('textbox', { name: 'Page address' });
  await waitFor(() => expect(address).toBeEnabled());
  fireEvent.change(address, { target: { value: 'https://example.org/new' } });
  expect(address).toHaveValue('https://example.org/new');
  expect(api.mock.calls.some(([path]) => String(path).endsWith('/new'))).toBe(
    false,
  );
  fireEvent.submit(address.closest('form')!);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/thread-a/navigate', {
      tabId: 'tab',
      url: 'https://example.org/new',
    }),
  );
  expect(
    api.mock.calls.filter(([path]) => String(path).endsWith('/new')),
  ).toHaveLength(1);
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
    }),
  );
  expect(api.mock.calls.some(([path]) => String(path).endsWith('/new'))).toBe(
    false,
  );
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

it('opens tabs, navigates and adds evidence only to the keyed conversation draft', async () => {
  render(<BrowserSidebar threadId="thread-a" onClose={vi.fn()} />);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/thread-a/tabs', expect.anything()),
  );
  fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
  await screen.findByRole('tab');
  fireEvent.click(screen.getByRole('button', { name: /^Open$/ }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Point at an element' }));
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
