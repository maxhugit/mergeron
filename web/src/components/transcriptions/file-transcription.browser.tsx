import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { FileTranscriptionPanel } from './file-transcription-panel';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
for (const width of [1280, 390])
  test(`private transcript remains usable at ${width}px`, async () => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 844);
    const result = {
      text: 'Bonjour et bienvenue.',
      language: 'fr',
      languageProbability: 0.97,
      duration: 300,
      diarization: { state: 'ready', speakerCount: 2 },
      segments: Array.from({ length: 40 }, (_, i) => ({
        start: i * 6,
        end: i * 6 + 5,
        text: 'Bonjour et bienvenue à notre réunion. Nous préparons les prochaines étapes du projet.',
        speaker: 'speaker_' + ((i % 2) + 1),
      })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (input: RequestInfo | URL) =>
          new Response(
            JSON.stringify(
              String(input).endsWith('/status')
                ? { enabled: true, state: 'ready' }
                : [
                    {
                      id: 'fixture',
                      filename: 'réunion.wav',
                      state: 'ready',
                      createdAt: 1793617800000,
                      result,
                      error: null,
                    },
                  ],
            ),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <div className="flex h-[730px] flex-col p-3">
          <FileTranscriptionPanel
            source={{ kind: 'file', filePath: '/test-only/meeting.wav' }}
          />
        </div>
      </QueryClientProvider>,
    );
    await expect
      .element(await screen.findByText('Langue : fr · confiance 97 %'))
      .toBeVisible();
    const panel = screen.getByRole('region', {
      name: 'Transcription du fichier',
    });
    const scroller = panel.querySelector('.overflow-y-auto') as HTMLElement;
    await expect
      .poll(() => scroller.scrollHeight > scroller.clientHeight)
      .toBe(true);
    expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    const before = screen
      .getByRole('button', { name: 'Transcrire' })
      .getBoundingClientRect().top;
    scroller.scrollTop = 1000;
    expect(
      screen.getByRole('button', { name: 'Transcrire' }).getBoundingClientRect()
        .top,
    ).toBe(before);
    expect(screen.getAllByText(/Locuteur 1/).length).toBeGreaterThan(0);
    scroller.scrollTop = 0;
    await page.screenshot({
      path: `../../../.vitest-screenshots/transcription-${width}.png`,
    });
    client.clear();
  });
