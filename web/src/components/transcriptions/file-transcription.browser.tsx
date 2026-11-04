import { VideoViewer } from '../files/viewers/video-viewer';
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
for (const mode of ['panel', 'video'] as const)
  for (const width of [1280, 390])
    test(`private transcript ${mode} remains usable at ${width}px`, async () => {
      await i18nReady;
      await i18n.changeLanguage('fr');
      await page.viewport(width, 844);
      const result = {
        text: 'Bonjour et bienvenue.',
        language: 'fr',
        languageProbability: 0.97,
        duration: 300,
        diarization: {
          state: 'ready',
          speakerCount: 2,
          warnings: [
            { code: 'overlapping_speech', count: 1, duration: 0.5 },
            { code: 'short_turns', count: 1, duration: 0.2 },
            { code: 'uncertain_assignment', count: 1 },
          ],
        },
        segments: Array.from({ length: 40 }, (_, i) => ({
          start: i * 6,
          end: i * 6 + 5,
          text: 'Bonjour et bienvenue à notre réunion. Nous préparons les prochaines étapes du projet.',
          speaker: i % 3 === 2 ? null : 'SPEAKER_0' + (i % 3),
        })),
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).includes('/api/files/preview')
            ? new Response(null, { status: 404 })
            : new Response(
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
                          operation: 'both',
                          audio: {
                            filename: 'réunion.mp3',
                            size: 10240,
                            duration: 300,
                            sha256: 'a'.repeat(64),
                            mime: 'audio/mpeg',
                          },
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
      const rendered = render(
        <QueryClientProvider client={client}>
          <div className="flex h-[730px] flex-col p-3">
            {mode === 'video' ? (
              <VideoViewer
                source={{ kind: 'file', filePath: '/test-only/meeting.mp4' }}
              />
            ) : (
              <FileTranscriptionPanel
                source={{ kind: 'file', filePath: '/test-only/meeting.wav' }}
              />
            )}
          </div>
        </QueryClientProvider>,
      );
      if (mode === 'video')
        await page
          .getByRole('button', { name: 'Audio et transcription', exact: true })
          .click();
      await expect
        .element(await screen.findByText('Langue : fr · confiance 97 %'))
        .toBeVisible();
      await expect
        .element(screen.getByRole('button', { name: 'Extraire l’audio' }))
        .toBeVisible();
      await expect
        .element(screen.getByRole('button', { name: 'Audio + transcription' }))
        .toBeVisible();
      await expect
        .element(screen.getByRole('button', { name: 'Télécharger l’audio' }))
        .toBeVisible();
      const panel = screen.getByRole('region', {
        name: 'Audio et transcription',
      });
      const scroller = panel.querySelector('.overflow-y-auto') as HTMLElement;
      await expect
        .poll(() => scroller.scrollHeight > scroller.clientHeight)
        .toBe(true);
      expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      expect(scroller.clientHeight).toBeGreaterThan(0);
      expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        rendered.container.firstElementChild!.getBoundingClientRect().bottom +
          1,
      );
      if (mode === 'video')
        expect(rendered.container.querySelectorAll('video')).toHaveLength(1);
      const before = screen
        .getByRole('button', { name: 'Transcrire' })
        .getBoundingClientRect().top;
      scroller.scrollTop = 1000;
      expect(
        screen
          .getByRole('button', { name: 'Transcrire' })
          .getBoundingClientRect().top,
      ).toBe(before);
      expect(screen.getAllByText(/SPEAKER_00/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Non attribué/).length).toBeGreaterThan(0);
      expect(screen.getByText('Nombre estimé de locuteurs : 2')).toBeTruthy();
      expect(screen.getByText(/Paroles simultanées détectées/)).toBeTruthy();
      expect(
        screen.getByText(/Interventions très courtes détectées/),
      ).toBeTruthy();
      scroller.scrollTop = 0;
      await page.screenshot({
        path: `../../../.vitest-screenshots/transcription-${mode}-${width}.png`,
      });
      client.clear();
    });
