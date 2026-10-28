import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { showSnackbar } from '@/stores/snackbar-store';
import { dictationWave } from '@/lib/dictation-audio';

const MAX_RECORDING_MS = 2 * 60 * 1_000;

type State = 'idle' | 'recording' | 'transcribing';

function recordingMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

export function VoiceDictationButton({
  disabled = false,
  onTranscript,
}: {
  disabled?: boolean;
  onTranscript: (text: string) => void;
}) {
  const [state, setState] = useState<State>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    recorderRef.current = null;
  };

  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const transcribe = async (blob: Blob) => {
    setState('transcribing');
    try {
      const form = new FormData();
      const wave = await dictationWave(blob);
      form.append('file', wave, 'dictation.wav');
      const authorization = getAuthorizationHeader();
      const response = await fetch(
        withBasePath('/api/simple-chat/transcriptions'),
        {
          method: 'POST',
          headers: authorization ? { Authorization: authorization } : {},
          body: form,
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        text?: string;
        message?: string;
      };
      if (!response.ok || !payload.text) {
        throw new Error(
          payload.message ||
            `Transcription impossible (HTTP ${response.status})`,
        );
      }
      onTranscript(payload.text);
    } catch (error) {
      showSnackbar(
        error instanceof Error ? error.message : 'Transcription impossible.',
        'error',
      );
    } finally {
      setState('idle');
    }
  };

  const stop = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      showSnackbar(
        'La dictée vocale n’est pas prise en charge par ce navigateur.',
        'error',
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = recordingMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        releaseStream();
        setState('idle');
        showSnackbar('L’enregistrement audio a échoué.', 'error');
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        chunksRef.current = [];
        releaseStream();
        if (blob.size) void transcribe(blob);
        else setState('idle');
      };
      recorder.start(250);
      setState('recording');
      timerRef.current = window.setTimeout(stop, MAX_RECORDING_MS);
    } catch {
      releaseStream();
      setState('idle');
      showSnackbar(
        'L’accès au microphone a été refusé ou est indisponible.',
        'error',
      );
    }
  };

  return (
    <Button
      type="button"
      size="icon"
      variant={state === 'recording' ? 'destructive' : 'ghost'}
      className="h-7 w-7 rounded-lg"
      disabled={disabled || state === 'transcribing'}
      onClick={state === 'recording' ? stop : () => void start()}
      aria-label={
        state === 'recording' ? 'Arrêter la dictée' : 'Démarrer la dictée'
      }
      title={state === 'recording' ? 'Arrêter la dictée' : 'Démarrer la dictée'}
    >
      {state === 'transcribing' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === 'recording' ? (
        <Square className="h-3.5 w-3.5 fill-current" />
      ) : (
        <Mic className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
