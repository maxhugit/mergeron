import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useState } from 'react';
import { VoiceDictationButton } from './voice-dictation-button';
import '@/index.css';

let remote: RTCPeerConnection | undefined;
let context: AudioContext | undefined;
afterEach(async () => {
  cleanup();
  remote?.close();
  await context?.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('negotiates real local WebRTC peers without a microphone or account, then adds the explicit final text', async () => {
  context = new AudioContext();
  const stream = context.createMediaStreamDestination().stream;
  const track = stream.getAudioTracks()[0];
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(stream);
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/status'))
      return { ok: true, json: async () => ({ audioBackend: 'codex' }) };
    if (url.endsWith('/audio-sessions')) {
      remote = new RTCPeerConnection({ iceServers: [] });
      const { sdp } = JSON.parse(options!.body as string);
      await remote.setRemoteDescription({ type: 'offer', sdp });
      await remote.setLocalDescription(await remote.createAnswer());
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Local ICE gathering timeout')),
          5000,
        );
        const check = () => {
          if (remote!.iceGatheringState === 'complete') {
            clearTimeout(timeout);
            remote!.removeEventListener('icegatheringstatechange', check);
            resolve();
          }
        };
        remote!.addEventListener('icegatheringstatechange', check);
        check();
      });
      return {
        ok: true,
        json: async () => ({
          id: '55555555-1111-4111-8111-111111111111',
          sdp: remote!.localDescription!.sdp,
        }),
      };
    }
    if (url.endsWith('/finish')) {
      expect(track.enabled).toBe(false);
      expect(remote!.connectionState).toBe('connected');
      return {
        ok: true,
        json: async () => ({ text: 'Transcription de test explicite.' }),
      };
    }
    if (options?.method === 'DELETE')
      return { ok: true, json: async () => ({ ok: true }) };
    throw new Error('Unexpected request in isolated voice fixture');
  });
  vi.stubGlobal('fetch', fetchMock);
  function Harness() {
    const [draft, setDraft] = useState('');
    return (
      <div className="min-h-dvh p-4">
        <textarea aria-label="Brouillon" value={draft} readOnly />
        <VoiceDictationButton onTranscript={setDraft} />
      </div>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Démarrer la dictée' }));
  const stop = await screen.findByRole(
    'button',
    { name: 'Arrêter la dictée' },
    { timeout: 20000 },
  );
  expect(screen.getByRole('textbox', { name: 'Brouillon' })).toHaveValue('');
  for (const width of [1100, 390]) {
    await page.viewport(width, 800);
    expect(stop).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  }
  fireEvent.click(stop);
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Brouillon' })).toHaveValue(
      'Transcription de test explicite.',
    ),
  );
  expect(track.readyState).toBe('ended');
  expect(
    fetchMock.mock.calls.filter(([url]) => url.endsWith('/finish')),
  ).toHaveLength(1);
}, 30000);
