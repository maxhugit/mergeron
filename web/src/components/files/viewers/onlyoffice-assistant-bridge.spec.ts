import { afterEach, expect, it, vi } from 'vitest';
import { connectOfficeAssistant } from './onlyoffice-assistant-bridge';
vi.mock('@/auth-token', () => ({
  getAuthorizationHeader: () => 'Bearer host-only-test-key',
}));
let disconnect: () => void;
afterEach(() => {
  disconnect?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
it('accepts only the current editor channel and same-origin nested window, never forwards credentials or session ids', async () => {
  // Vitest's global Window proxy differs from a jsdom child's raw `.top`.
  // Real nested-window identity is also covered by the browser contract suite.
  const reply = vi.fn();
  const source = { top: window.top, postMessage: reply } as unknown as Window;
  const fetch = vi
    .spyOn(window, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({ agents: [{ id: 'a', name: 'Project agent' }] }),
        { status: 200 },
      ),
    );
  disconnect = connectOfficeAssistant({
    sessionId: 'host-only-document-session',
    channel: 'current-channel',
  });
  const send = (origin: string, channel: string, method = 'context') =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source,
        data: {
          type: 'mergeron.onlyoffice.request',
          id: 'one',
          channel,
          method,
          args: { sessionId: 'attacker-session', url: '/api/people' },
        },
      }),
    );
  send('https://foreign.test', 'current-channel');
  send(location.origin, 'wrong-channel');
  send(location.origin, 'current-channel', 'arbitrary-proxy');
  expect(fetch).not.toHaveBeenCalled();
  send(location.origin, 'current-channel');
  expect(source.top).toBe(window.top);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[0][0]).toBe('/api/onlyoffice/assistant/context');
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
    sessionId: 'host-only-document-session',
  });
  expect(JSON.stringify(reply.mock.calls)).not.toContain('host-only');
  disconnect();
  send(location.origin, 'current-channel');
  expect(fetch).toHaveBeenCalledOnce();
});

it('pins the live panel and permits replacement only after OnlyOffice destroys its window', async () => {
  const oldPanel = { top: window.top, closed: false, postMessage: vi.fn() };
  const newPanel = { top: window.top, closed: false, postMessage: vi.fn() };
  const fetch = vi
    .spyOn(window, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify({ agents: [] }), { status: 200 }),
    );
  disconnect = connectOfficeAssistant({
    sessionId: 'private',
    channel: 'panel',
  });
  let request = 0;
  const send = (source: typeof oldPanel, method = 'context') =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: location.origin,
        source: source as unknown as Window,
        data: {
          type: 'mergeron.onlyoffice.request',
          id: String(++request),
          channel: 'panel',
          method,
        },
      }),
    );
  send(oldPanel);
  await vi.waitFor(() => expect(oldPanel.postMessage).toHaveBeenCalledOnce());
  send(newPanel);
  expect(fetch).toHaveBeenCalledTimes(1);
  oldPanel.closed = true;
  send(newPanel, 'propose');
  expect(fetch).toHaveBeenCalledTimes(1);
  send(newPanel);
  await vi.waitFor(() => expect(newPanel.postMessage).toHaveBeenCalledOnce());
  expect(fetch).toHaveBeenCalledTimes(2);
});
