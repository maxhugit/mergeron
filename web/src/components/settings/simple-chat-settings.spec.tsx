import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SimpleChatSettings } from './simple-chat-settings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('persists the experimental audio choice separately from the chat engine', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    json: async () =>
      url.endsWith('/api-key')
        ? { configured: false, managed: false }
        : init?.method === 'PUT'
          ? { backend: 'openai', audioBackend: 'codex' }
          : { backend: 'openai', audioBackend: 'openai' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  render(<SimpleChatSettings />);
  const audio = await screen.findByRole('combobox', {
    name: 'Dictation engine',
  });
  await waitFor(() => expect(audio).toHaveValue('openai'));
  fireEvent.change(audio, { target: { value: 'codex' } });
  expect(
    await screen.findByText(/Experimental: uses the Codex voice session/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/audio-settings'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ audioBackend: 'codex' }),
      }),
    ),
  );
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) => url.endsWith('/settings') && init?.method === 'PUT',
    ),
  ).toHaveLength(0);
});
