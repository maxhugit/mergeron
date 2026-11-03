import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { VideoViewer } from './video-viewer';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => ({ sibling: vi.fn(), read: vi.fn() }));
vi.mock('./video-subtitles', () => ({
  readSiblingSrt: api.sibling,
  readSrtSource: api.read,
}));
vi.mock('../../transcriptions/file-transcription-panel', () => ({
  FileTranscriptionPanel: () => <p>Outils de traitement</p>,
}));
vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  filesReadTreeOptions: () => ({
    queryKey: ['subtitle-folder'],
    queryFn: () =>
      Promise.resolve([
        { name: 'autre-nom.srt', path: '/videos/autre-nom.srt', type: 'file' },
      ]),
  }),
}));
vi.mock('./preview-source', () => ({
  buildPreviewUrl: () => {
    const bytes = new Uint8Array(48044),
      view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) =>
      Array.from(value).forEach((c, i) => {
        bytes[offset + i] = c.charCodeAt(0);
      });
    text(0, 'RIFF');
    view.setUint32(4, 48036, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    text(36, 'data');
    view.setUint32(40, 48000, true);
    bytes.fill(128, 44);
    return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...bytes));
  },
}));
afterEach(cleanup);
test.each([390, 1280])(
  'single player and clickable transcript remain usable at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 913);
    api.sibling
      .mockReset()
      .mockResolvedValue(
        '1\n00:00:00,000 --> 00:00:02,000\nBonjour\n\n2\n00:00:03,000 --> 00:00:05,000\nLa suite',
      );
    api.read
      .mockReset()
      .mockResolvedValue(
        '1\n00:00:00,000 --> 00:00:05,000\nAutre transcription',
      );
    const client = new QueryClient();
    const tree = () => (
      <QueryClientProvider client={client}>
        <div className="h-[800px] min-h-0">
          <VideoViewer
            source={{ kind: 'file', filePath: '/videos/film.mp4' }}
          />
        </div>
      </QueryClientProvider>
    );
    const view = render(tree());
    const player = view.container.querySelector('video')!;
    await expect.poll(() => player.duration).toBeGreaterThan(5);
    await expect
      .element(page.getByRole('button', { name: '00:03 La suite' }))
      .toBeVisible();
    await page.getByRole('button', { name: '00:03 La suite' }).click();
    await expect.poll(() => player.currentTime).toBeCloseTo(3, 1);
    await expect
      .element(page.getByRole('button', { name: '00:03 La suite' }))
      .toHaveAttribute('aria-current', 'true');
    for (let index = 0; index < 8; index++) view.rerender(tree());
    await page.getByRole('button', { name: 'Audio et transcription' }).click();
    await expect.element(page.getByText('Outils de traitement')).toBeVisible();
    await page
      .getByRole('button', { name: 'Sous-titres synchronisés' })
      .click();
    expect(view.container.querySelectorAll('video')).toHaveLength(1);
    expect(view.container.querySelector('video')).toBe(player);
    await page
      .getByRole('button', { name: 'Charger un fichier SRT', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'autre-nom.srt', exact: true })
      .click();
    await expect.element(page.getByText('Autre transcription')).toBeVisible();
    expect(api.read).toHaveBeenCalledWith(
      { kind: 'file', filePath: '/videos/autre-nom.srt' },
      expect.any(AbortSignal),
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(player.getBoundingClientRect().height).toBeLessThanOrEqual(384);
    await expect
      .poll(
        () => document.querySelectorAll('[data-slot="dialog-content"]').length,
      )
      .toBe(0);
    await page.screenshot({
      path: `../../../../.vitest-screenshots/video-subtitles-${width}.png`,
    });
    expect(
      screen.getAllByRole('region', { name: 'Sous-titres synchronisés' }),
    ).toHaveLength(1);
    client.clear();
  },
);
