import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { LocalBrowserSidebar } from './local-browser-sidebar';
const api = vi.hoisted(() => vi.fn());
const extension = vi.hoisted(() => vi.fn());
const insert = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-annotations', async (original) => ({
  ...(await original<typeof import('@/lib/browser-annotations')>()),
  insertBrowserAnnotation: insert,
}));
vi.mock('@/lib/local-browser-api', () => ({
  localBrowserApi: api,
  extensionRequest: extension,
}));
beforeEach(async () => {
  await i18n.changeLanguage('en');
  insert.mockReset().mockResolvedValue(undefined);
  api
    .mockReset()
    .mockImplementation((_thread, path) =>
      path === 'open'
        ? Promise.resolve({ id: 'session' })
        : Promise.resolve({ dispatch: [], approvals: [] }),
    );
  extension
    .mockReset()
    .mockImplementation((action) =>
      Promise.resolve(
        action === 'state'
          ? { state: 'shared', epoch: 'e', url: 'https://example.org/' }
          : { ok: true },
      ),
    );
});
it('adds only a submitted annotation and image to this draft, without relaying pixels to the command broker', async () => {
  extension.mockImplementation((action) =>
    Promise.resolve(
      action === 'state'
        ? {
            state: 'shared',
            epoch: 'e',
            url: 'https://example.org/',
            annotation: { id: 'annotation', text: 'My comment' },
          }
        : action === 'annotation'
          ? {
              id: 'annotation',
              comment: 'My comment',
              image: 'data:image/jpeg;base64,/9j/AA==',
              selection: {
                id: 'annotation',
                url: 'https://example.org/',
                tag: 'button',
                text: 'Save',
              },
            }
          : { ok: true },
    ),
  );
  render(<LocalBrowserSidebar threadId="agent" docked onClose={vi.fn()} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Pair the extension with this agent' }),
  );
  await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
  expect(insert.mock.calls[0][0]).toMatchObject({
    threadId: 'agent',
    text: expect.stringContaining('My comment'),
    image: expect.any(File),
  });
  expect(insert.mock.calls[0][0].image.type).toBe('image/jpeg');
  await waitFor(() =>
    expect(extension).toHaveBeenCalledWith('annotationAck', {
      sessionId: 'session',
      annotationId: 'annotation',
    }),
  );
  expect(JSON.stringify(api.mock.calls)).not.toContain('base64');
  expect(JSON.stringify(api.mock.calls)).not.toContain('My comment');
  expect(api.mock.calls.every(([, path]) => !path.includes('turn'))).toBe(true);
});
it('never uploads twice if acknowledgement fails; manual retry only retries acknowledgement', async () => {
  let attempts = 0;
  extension.mockImplementation((action) => {
    if (action === 'annotationAck' && ++attempts === 1)
      return Promise.reject(Error('uncertain'));
    return Promise.resolve(
      action === 'state'
        ? {
            state: 'paused',
            annotation: { id: 'annotation', text: 'My comment' },
          }
        : action === 'annotation'
          ? {
              id: 'annotation',
              comment: 'My comment',
              image: 'data:image/jpeg;base64,/9j/AA==',
              selection: { id: 'annotation' },
            }
          : { ok: true },
    );
  });
  render(<LocalBrowserSidebar threadId="agent" docked onClose={vi.fn()} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Pair the extension with this agent' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Resume adding to the draft' }),
  );
  await waitFor(() => expect(attempts).toBe(2));
  expect(insert).toHaveBeenCalledTimes(1);
  expect(
    extension.mock.calls.filter(([action]) => action === 'annotation'),
  ).toHaveLength(1);
});
it('pauses the broker and refuses dispatched commands while annotating Mergeron itself', async () => {
  extension.mockImplementation((action) =>
    Promise.resolve(
      action === 'state'
        ? {
            state: 'shared',
            epoch: 'e',
            url: 'https://example.org/',
            annotationOnly: true,
            inputBlocked: true,
          }
        : { ok: true },
    ),
  );
  api.mockImplementation((_thread, path) =>
    Promise.resolve(
      path === 'open'
        ? { id: 'session' }
        : {
            dispatch: [
              { id: 'write', executionId: 'no', action: 'click', args: {} },
            ],
            approvals: [],
          },
    ),
  );
  render(<LocalBrowserSidebar threadId="agent" docked onClose={vi.fn()} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Pair the extension with this agent' }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      'agent',
      'session/poll',
      expect.objectContaining({ state: 'paused' }),
    ),
  );
  expect(extension.mock.calls.some(([action]) => action === 'execute')).toBe(
    false,
  );
});
it('offers separate manual packages for Chromium and Safari Mac while keeping the isolated mode separate', () => {
  render(<LocalBrowserSidebar threadId="agent" docked onClose={vi.fn()} />);
  fireEvent.click(screen.getByText('Install the extension manually'));
  expect(screen.getByRole('link', { name: /Chrome \/ Edge:/ })).toHaveAttribute(
    'href',
    '/mergeron-browser-extension.zip',
  );
  expect(screen.getByRole('link', { name: /Safari on Mac:/ })).toHaveAttribute(
    'href',
    '/mergeron-browser-extension-safari.zip',
  );
  expect(screen.getByText(/Safari removes the extension/)).toBeInTheDocument();
  expect(api).not.toHaveBeenCalled();
});
it('never connects on mount, never falls back when extension is absent, and closes the failed association', async () => {
  extension.mockRejectedValue(Error('missing'));
  render(<LocalBrowserSidebar threadId="agent" docked onClose={vi.fn()} />);
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Pair the extension with this agent' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'extension unavailable',
  );
  expect(api).toHaveBeenCalledWith('agent', 'session/close');
  expect(
    api.mock.calls.every(
      ([, path]) => !path.includes('navigate') && !path.includes('dispose'),
    ),
  ).toBe(true);
});
it('relays a command once, shows approvals and revokes sharing when the panel unmounts', async () => {
  api.mockImplementation((_thread, path) => {
    if (path === 'open') return Promise.resolve({ id: 'session' });
    return Promise.resolve({
      dispatch: [
        { id: 'read', action: 'observe', args: {}, executionId: 'once' },
      ],
      approvals: [
        { id: 'write', action: 'click', args: { elementId: 'observed' } },
      ],
    });
  });
  const view = render(
    <LocalBrowserSidebar threadId="agent" docked onClose={vi.fn()} />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Pair the extension with this agent' }),
  );
  const approve = await screen.findByRole('button', {
    name: 'Allow this action',
  });
  expect(api.mock.calls.some(([, path]) => path.endsWith('/decide'))).toBe(
    false,
  );
  fireEvent.click(approve);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('agent', 'session/decide', {
      commandId: 'write',
      approve: true,
    }),
  );
  expect(
    extension.mock.calls.filter(([action]) => action === 'execute'),
  ).toHaveLength(1);
  view.unmount();
  expect(extension).toHaveBeenCalledWith('revoke', { sessionId: 'session' });
  expect(api).toHaveBeenCalledWith('agent', 'session/close');
});
