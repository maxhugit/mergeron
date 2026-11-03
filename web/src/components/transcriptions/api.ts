import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
export interface Transcript {
  text: string;
  language: string;
  languageProbability: number;
  duration: number;
  segments: {
    start: number;
    end: number;
    text: string;
    speaker: string | null;
  }[];
  diarization: {
    state: 'ready' | 'unavailable' | 'failed';
    speakerCount?: number;
  };
}
export type MediaOperation = 'transcribe' | 'extract' | 'both';
export interface TranscriptionJob {
  operation?: MediaOperation;
  audio?: {
    filename: string;
    size: number;
    duration: number;
    sha256: string;
    mime: 'audio/mpeg';
  } | null;
  id: string;
  filename: string;
  state: string;
  error: string | null;
  result: Transcript | null;
  createdAt: number;
}
export async function transcriptionRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const auth = getAuthorizationHeader();
  if (auth) headers.set('Authorization', auth);
  const response = await fetch(withBasePath('/api/transcriptions/' + path), {
    ...init,
    headers,
    credentials: 'same-origin',
  });
  if (!response.ok) throw Error('HTTP ' + response.status);
  return response.json() as Promise<T>;
}
export async function mediaSourceKey(source: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export function transcriptSrt(result: Transcript) {
  const stamp = (time: number) => {
    const ms = Math.round(time * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return result.segments
    .map(
      (s, i) =>
        `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.speaker ? s.speaker + ': ' : ''}${s.text}\n`,
    )
    .join('\n');
}

export async function downloadJobAudio(job: TranscriptionJob) {
  const headers = new Headers();
  const auth = getAuthorizationHeader();
  if (auth) headers.set('Authorization', auth);
  const response = await fetch(
    withBasePath('/api/transcriptions/jobs/' + job.id + '/audio'),
    { headers, credentials: 'same-origin' },
  );
  if (!response.ok) throw Error('HTTP ' + response.status);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = job.audio?.filename ?? 'audio.mp3';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
