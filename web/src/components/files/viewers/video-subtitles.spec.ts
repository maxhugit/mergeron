import { afterEach, expect, it, vi } from 'vitest';
import { readSiblingSrt, siblingSrt } from './video-subtitles';
import { MAX_SRT_BYTES } from '@/lib/srt';
vi.mock('./preview-source', () => ({
  buildPreviewHeaders: () => new Headers(),
  buildPreviewUrl: (source: { filePath: string }) => source.filePath,
}));
afterEach(() => vi.unstubAllGlobals());
it('resolves only a sibling path, preserving spaces and archive ownership', () => {
  expect(
    siblingSrt({ kind: 'file', filePath: '/videos/My recording.v2.mp4' }),
  ).toEqual({ kind: 'file', filePath: '/videos/My recording.v2.srt' });
  expect(
    siblingSrt({
      kind: 'archive',
      archivePath: '/private.zip',
      entryPath: 'nested/film.mp4',
      label: 'film.mp4',
    }),
  ).toMatchObject({
    archivePath: '/private.zip',
    entryPath: 'nested/film.srt',
  });
});
it('treats only a missing sidecar as absence and keeps authorization failures visible', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  expect(
    await readSiblingSrt({ kind: 'file', filePath: '/a.mp4' }, signal),
  ).toBeNull();
  await expect(
    readSiblingSrt({ kind: 'file', filePath: '/a.mp4' }, signal),
  ).rejects.toThrow('loadFailed');
  expect(fetcher).toHaveBeenCalledWith(
    '/a.srt',
    expect.objectContaining({ signal }),
  );
});
it('bounds streamed bodies even without a content length', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_SRT_BYTES + 1))),
  );
  await expect(
    readSiblingSrt(
      { kind: 'file', filePath: '/a.mp4' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('tooLarge');
});
