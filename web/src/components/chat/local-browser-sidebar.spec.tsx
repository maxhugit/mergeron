import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { LocalBrowserSidebar } from './local-browser-sidebar';
const api = vi.hoisted(() => vi.fn());
const extension = vi.hoisted(() => vi.fn());
vi.mock('@/lib/local-browser-api', () => ({
  localBrowserApi: api,
  extensionRequest: extension,
}));
beforeEach(async () => {
  await i18n.changeLanguage('en');
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
