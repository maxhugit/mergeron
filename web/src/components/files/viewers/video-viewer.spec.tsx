import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VideoViewer } from './video-viewer';
import i18n, { i18nReady } from '@/i18n';
const api = vi.hoisted(() => ({ sibling: vi.fn(), read: vi.fn() }));
vi.mock('./video-subtitles', () => ({
  readSiblingSrt: api.sibling,
  readSrtSource: api.read,
}));
vi.mock('./preview-source', () => ({ buildPreviewUrl: () => '/fixture.mp4' }));
vi.mock('./subtitle-picker', () => ({ SubtitlePicker: () => null }));
vi.mock('../../transcriptions/file-transcription-panel', () => ({
  FileTranscriptionPanel: () => <div>Processing panel</div>,
}));
const srt =
  '1\n00:00:01,000 --> 00:00:03,000\nBonjour\n\n2\n00:00:04,000 --> 00:00:06,000\nLa suite';
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  api.sibling.mockReset().mockResolvedValue(srt);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);
function mount(path = '/videos/film.mp4') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (path: string) => (
    <QueryClientProvider client={client}>
      <VideoViewer source={{ kind: 'file', filePath: path }} />
    </QueryClientProvider>
  );
  const rendered = render(tree(path));
  return {
    ...rendered,
    change: (path: string) => rendered.rerender(tree(path)),
  };
}
it('keeps exactly one stable player across repeated renders, errors and processing tabs', async () => {
  const view = mount();
  await screen.findByText('Bonjour');
  const player = view.container.querySelector('video')!;
  for (let i = 0; i < 8; i++) {
    view.change('/videos/film.mp4');
    fireEvent.error(player);
  }
  fireEvent.click(
    screen.getByRole('button', { name: 'Audio et transcription' }),
  );
  expect(await screen.findByText('Processing panel')).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Sous-titres synchronisés' }),
  );
  expect(view.container.querySelectorAll('video')).toHaveLength(1);
  expect(view.container.querySelector('video')).toBe(player);
  expect(api.sibling).toHaveBeenCalledTimes(1);
});
it('highlights the cue at playback time and seeks without starting playback', async () => {
  const view = mount();
  await screen.findByText('La suite');
  const player = view.container.querySelector('video')!;
  const play = vi.spyOn(player, 'play');
  player.currentTime = 4.5;
  fireEvent.timeUpdate(player);
  expect(
    screen.getByRole('button', { name: /00:04\s*La suite/ }),
  ).toHaveAttribute('aria-current', 'true');
  fireEvent.click(screen.getByRole('button', { name: /00:01\s*Bonjour/ }));
  expect(player.currentTime).toBe(1);
  expect(play).not.toHaveBeenCalled();
});
it('keeps a manually selected differently named SRT when automatic discovery finishes late', async () => {
  let complete!: (value: string) => void;
  api.sibling.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  mount();
  fireEvent.change(screen.getByLabelText('Choisir sur cet appareil'), {
    target: {
      files: [
        {
          name: 'autre-nom.srt',
          size: 100,
          text: () => Promise.resolve(srt.replace('Bonjour', 'Manuel')),
        },
      ],
    },
  });
  await screen.findByText('Manuel');
  complete(srt);
  await waitFor(() => expect(screen.queryByText('Bonjour')).toBeNull());
  expect(screen.getByText('autre-nom.srt')).toBeInTheDocument();
});
it('clears previous cues on source changes and discards late reads from the old video', async () => {
  let complete!: (value: string) => void;
  api.sibling
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce(srt.replace('Bonjour', 'Nouvelle vidéo'));
  const view = mount();
  view.change('/videos/other.mp4');
  await screen.findByText('Nouvelle vidéo');
  complete(srt);
  await waitFor(() => expect(screen.queryByText('Bonjour')).toBeNull());
  expect(view.container.querySelectorAll('video')).toHaveLength(1);
});
it('pages long transcripts around the current cue instead of rendering all subtitles', async () => {
  const stamp = (seconds: number) =>
    `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
  api.sibling.mockResolvedValue(
    Array.from(
      { length: 401 },
      (_, index) =>
        `${index + 1}\n${stamp(index)} --> ${stamp(index + 1)}\nPhrase ${index}`,
    ).join('\n\n'),
  );
  const view = mount();
  await screen.findByText('Phrase 0');
  const player = view.container.querySelector('video')!;
  player.currentTime = 300.2;
  fireEvent.timeUpdate(player);
  expect(screen.getByText('Phrase 300').closest('button')).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(view.container.querySelectorAll('ol li')).toHaveLength(200);
  expect(screen.queryByText('Phrase 0')).toBeNull();
});
