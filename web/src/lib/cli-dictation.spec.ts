import { afterEach, expect, it, vi } from 'vitest';
import { dictationBackend, startCliDictation } from './cli-dictation';

const id = '55555555-1111-4111-8111-111111111111';
const offer = 'v=0\r\nm=audio 9\r\nm=application 9\r\n';
class Peer extends EventTarget {
  static instances: Peer[] = [];
  connectionState = 'connected';
  localDescription?: RTCSessionDescriptionInit;
  addTrack = vi.fn();
  createDataChannel = vi.fn();
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: offer }));
  setLocalDescription = vi.fn(async (value: RTCSessionDescriptionInit) => {
    this.localDescription = value;
  });
  setRemoteDescription = vi.fn(async () => {});
  close = vi.fn();
  constructor() {
    super();
    Peer.instances.push(this);
  }
}
function setup() {
  Peer.instances = [];
  const track = { enabled: true, stop: vi.fn() };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('RTCPeerConnection', Peer);
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => ({
    ok: true,
    json: async () =>
      url.endsWith('/status')
        ? { audioBackend: 'codex' }
        : options?.method === 'POST' && url.endsWith('/audio-sessions')
          ? { id, sdp: 'v=0\r\nanswer' }
          : { text: ' Bonjour le helpdesk. ' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return { track, stream, getUserMedia, fetchMock };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('chooses the explicitly configured engine and refuses unknown status without API fallback', async () => {
  const { fetchMock } = setup();
  await expect(dictationBackend()).resolves.toBe('codex');
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({}),
  } as never);
  await expect(dictationBackend()).rejects.toThrow(
    /Moteur de dictée indisponible/,
  );
});

it('forwards browser SDP with a data channel, sends no recording, mutes for the tail, then releases media', async () => {
  const { track, fetchMock } = setup();
  const handle = await startCliDictation(new AbortController().signal);
  const pc = Peer.instances[0];
  expect(pc.createDataChannel).toHaveBeenCalledWith('oai-events');
  expect(pc.createDataChannel.mock.invocationCallOrder[0]).toBeLessThan(
    pc.createOffer.mock.invocationCallOrder[0],
  );
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
    sdp: offer,
  });
  expect(pc.setRemoteDescription).toHaveBeenCalledWith({
    type: 'answer',
    sdp: 'v=0\r\nanswer',
  });
  await expect(handle.finish()).resolves.toBe('Bonjour le helpdesk.');
  expect(track.enabled).toBe(false);
  expect(track.stop).toHaveBeenCalled();
  expect(pc.close).toHaveBeenCalled();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    '/api/simple-chat/audio-sessions',
    `/api/simple-chat/audio-sessions/${id}/finish`,
  ]);
});

it('cancels media and the owned session when navigating away', async () => {
  const { track, fetchMock } = setup();
  const controller = new AbortController();
  const handle = await startCliDictation(controller.signal);
  controller.abort();
  await handle.cancel();
  expect(track.stop).toHaveBeenCalled();
  expect(
    fetchMock.mock.calls.filter(([, options]) => options?.method === 'DELETE'),
  ).toHaveLength(1);
});

it('cleans up a late start response even if the view was closed while negotiating', async () => {
  const { track, fetchMock } = setup();
  let release!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }) as never,
  );
  const controller = new AbortController();
  const pending = startCliDictation(controller.signal);
  const rejected = expect(pending).rejects.toThrow(/annulée/);
  for (let n = 0; n < 15; n++) await Promise.resolve();
  controller.abort();
  release({ ok: true, json: async () => ({ id, sdp: 'v=0\r\nanswer' }) });
  await rejected;
  expect(track.stop).toHaveBeenCalled();
  expect(
    fetchMock.mock.calls.filter(([, options]) => options?.method === 'DELETE'),
  ).toHaveLength(1);
});

it('never retries an upstream error through recorded audio or a different engine', async () => {
  const { track, fetchMock } = setup();
  fetchMock.mockResolvedValueOnce({
    ok: false,
    json: async () => ({ message: 'CLI non compatible' }),
  } as never);
  await expect(startCliDictation(new AbortController().signal)).rejects.toThrow(
    'CLI non compatible',
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(track.stop).toHaveBeenCalled();
  expect(Peer.instances[0].close).toHaveBeenCalled();
});

it('deletes the session after a failed finish and does not return text from an error', async () => {
  const { fetchMock, track } = setup();
  const handle = await startCliDictation(new AbortController().signal);
  fetchMock.mockResolvedValueOnce({
    ok: false,
    json: async () => ({ message: 'Session interrompue', text: 'not valid' }),
  } as never);
  await expect(handle.finish()).rejects.toThrow('Session interrompue');
  expect(track.stop).toHaveBeenCalled();
  expect(
    fetchMock.mock.calls.filter(([, options]) => options?.method === 'DELETE'),
  ).toHaveLength(1);
});
