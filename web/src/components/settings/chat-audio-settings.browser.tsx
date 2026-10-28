import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { SimpleChatSettings } from './simple-chat-settings';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test('shows the experimental native audio choice independently at mobile and desktop widths', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        configured: false,
        managed: false,
        backend: 'openai',
        audioBackend: 'openai',
      }),
    })),
  );
  render(
    <div className="h-dvh min-w-0 overflow-auto p-4">
      <SimpleChatSettings />
    </div>,
  );
  const audio = await screen.findByRole('combobox', {
    name: 'Moteur de dictée',
  });
  fireEvent.change(audio, { target: { value: 'codex' } });
  await screen.findByText(/Expérimental : utilise la session vocale/);
  for (const width of [1100, 390]) {
    await page.viewport(width, 800);
    expect(audio).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  }
});
