import {
  buildPreviewHeaders,
  buildPreviewUrl,
  type PreviewSource,
} from './preview-source';
import { MAX_SRT_BYTES } from '@/lib/srt';
export function siblingSrt(source: PreviewSource): PreviewSource {
  const sibling = (path: string) => path.replace(/\.[^/.]+$/, '') + '.srt';
  return source.kind === 'file'
    ? { kind: 'file', filePath: sibling(source.filePath) }
    : {
        ...source,
        entryPath: sibling(source.entryPath),
        label: sibling(source.label),
      };
}
export async function readSrtSource(
  source: PreviewSource,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(buildPreviewUrl(source), {
    headers: buildPreviewHeaders(),
    signal,
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('loadFailed');
  }
  if (Number(response.headers.get('Content-Length')) > MAX_SRT_BYTES) {
    await response.body?.cancel();
    throw new Error('tooLarge');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('loadFailed');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SRT_BYTES) throw new Error('tooLarge');
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).text();
}

export const readSiblingSrt = (source: PreviewSource, signal: AbortSignal) =>
  readSrtSource(siblingSrt(source), signal);
