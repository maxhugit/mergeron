import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  timeout = 35000,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/simple-chat/${path}`), {
    method,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
    keepalive: method === 'DELETE',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.message || 'La connexion à la dictée a échoué.');
  return payload as T;
}

export async function dictationBackend(): Promise<'codex' | 'openai'> {
  const status = await request<{ audioBackend?: string }>('status');
  if (status.audioBackend !== 'codex' && status.audioBackend !== 'openai')
    throw new Error('Moteur de dictée indisponible. Rechargez la page.');
  return status.audioBackend;
}

export interface CliDictation {
  finish(): Promise<string>;
  cancel(): Promise<void>;
}

/** Media goes over the CLI-negotiated WebRTC connection. No token leaves the CLI. */
export async function startCliDictation(
  signal: AbortSignal,
): Promise<CliDictation> {
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof RTCPeerConnection === 'undefined'
  )
    throw new Error(
      'Ce navigateur ne prend pas en charge la dictée CLI en WebRTC.',
    );
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let pc: RTCPeerConnection;
  try {
    pc = new RTCPeerConnection();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  let closed = false;
  let id: string | undefined;
  let deleted = false;
  const releaseMedia = () => {
    stream.getTracks().forEach((track) => track.stop());
    pc.close();
  };
  const cancel = async () => {
    closed = true;
    signal.removeEventListener('abort', onAbort);
    releaseMedia();
    if (id && !deleted) {
      deleted = true;
      await request(
        `audio-sessions/${encodeURIComponent(id)}`,
        'DELETE',
        undefined,
        6000,
      ).catch(() => {});
    }
  };
  const onAbort = () => {
    void cancel();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Dictée annulée', 'AbortError');
    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
    // Required by Codex's native WebRTC protocol, created before the offer.
    pc.createDataChannel('oai-events');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (closed) throw new DOMException('Dictée annulée', 'AbortError');
    const answer = await request<{ id: string; sdp: string }>(
      'audio-sessions',
      'POST',
      { sdp: pc.localDescription?.sdp ?? offer.sdp },
    );
    if (typeof answer.id !== 'string' || !/^[a-f0-9-]{36}$/.test(answer.id))
      throw new Error('Session vocale invalide.');
    id = answer.id;
    if (closed) throw new DOMException('Dictée annulée', 'AbortError');
    if (
      typeof answer.sdp !== 'string' ||
      answer.sdp.length > 65536 ||
      !answer.sdp.startsWith('v=0')
    )
      throw new Error('Réponse WebRTC invalide.');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (pc.connectionState === 'connected') {
          cleanup();
          resolve();
        } else if (
          closed ||
          signal.aborted ||
          ['failed', 'closed'].includes(pc.connectionState)
        ) {
          cleanup();
          reject(new Error('La connexion audio WebRTC a échoué.'));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        pc.removeEventListener('connectionstatechange', check);
        signal.removeEventListener('abort', check);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Le démarrage audio WebRTC a expiré.'));
      }, 15000);
      pc.addEventListener('connectionstatechange', check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
    return {
      cancel,
      finish: async () => {
        if (closed) throw new Error('La session de dictée est terminée.');
        // Keep silent RTP flowing for the final VAD/transcript, but stop capturing speech.
        stream.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        try {
          const result = await request<{ text?: string }>(
            `audio-sessions/${encodeURIComponent(id!)}/finish`,
            'POST',
            undefined,
            20000,
          );
          if (signal.aborted)
            throw new DOMException('Dictée annulée', 'AbortError');
          if (!result.text?.trim())
            throw new Error('Aucune parole n’a été reconnue.');
          deleted = true; // The finish endpoint already closed the owned session.
          return result.text.trim();
        } finally {
          await cancel();
        }
      },
    };
  } catch (error) {
    await cancel();
    throw error;
  }
}
