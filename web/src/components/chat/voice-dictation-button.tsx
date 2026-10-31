import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { showSnackbar } from '@/stores/snackbar-store';
import { dictationWave } from '@/lib/dictation-audio';
import {
  dictationBackend,
  startCliDictation,
  type CliDictation,
} from '@/lib/cli-dictation';

const MAX_RECORDING_MS = 2 * 60 * 1_000;

type State = 'idle' | 'connecting' | 'recording' | 'transcribing';

function recordingMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

export function VoiceDictationButton({
  active = true,
  disabled = false,
  onTranscript,
}: {
  active?: boolean;
  disabled?: boolean;
  onTranscript: (text: string) => void;
}) {
  const [state, setState] = useState<State>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const cliRef = useRef<CliDictation | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    recorderRef.current = null;
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      void cliRef.current?.cancel();
      cliRef.current = null;
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      chunksRef.current = [];
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      setState('idle');
    };
  }, [active]);

  const transcribe = async (blob: Blob, signal: AbortSignal) => {
    if (signal.aborted) return;
    setState('transcribing');
    try {
      const form = new FormData();
      const wave = await dictationWave(blob);
      if (signal.aborted) return;
      form.append('file', wave, 'dictation.wav');
      const authorization = getAuthorizationHeader();
      const response = await fetch(
        withBasePath('/api/simple-chat/transcriptions'),
        {
          method: 'POST',
          headers: authorization ? { Authorization: authorization } : {},
          body: form,
          signal,
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
      if (!signal.aborted) onTranscript(payload.text);
    } catch (error) {
      if (!signal.aborted)
        showSnackbar(
          error instanceof Error ? error.message : 'Transcription impossible.',
          'error',
        );
    } finally {
      if (!signal.aborted) setState('idle');
    }
  };

  const stop = () => {
    if (cliRef.current) {
      const cli = cliRef.current;
      cliRef.current = null;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      setState('transcribing');
      const signal = abortRef.current?.signal;
      void cli
        .finish()
        .then((text) => {
          if (!signal?.aborted) onTranscript(text);
        })
        .catch((error) => {
          if (!signal?.aborted)
            showSnackbar(
              error instanceof Error
                ? error.message
                : 'Transcription impossible.',
              'error',
            );
        })
        .finally(() => {
          if (!signal?.aborted) setState('idle');
        });
      return;
    }
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      showSnackbar(
        'La dictée vocale n’est pas prise en charge par ce navigateur.',
        'error',
      );
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setState('connecting');
    try {
      const backend = await dictationBackend();
      if (controller.signal.aborted) return;
      if (backend === 'codex') {
        const cli = await startCliDictation(controller.signal);
        if (controller.signal.aborted) {
          await cli.cancel();
          return;
        }
        cliRef.current = cli;
        setState('recording');
        timerRef.current = window.setTimeout(stop, MAX_RECORDING_MS);
        return;
      }
      if (!window.MediaRecorder)
        throw new Error(
          'L’enregistrement audio n’est pas pris en charge par ce navigateur.',
        );
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (controller.signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = recordingMimeType();
      streamRef.current = stream;
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        if (controller.signal.aborted) return;
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
        if (blob.size) void transcribe(blob, controller.signal);
        else setState('idle');
      };
      recorder.start(250);
      setState('recording');
      timerRef.current = window.setTimeout(stop, MAX_RECORDING_MS);
    } catch (error) {
      if (controller.signal.aborted) return;
      releaseStream();
      setState('idle');
      showSnackbar(
        error instanceof Error && error.name !== 'NotAllowedError'
          ? error.message
          : 'L’accès au microphone a été refusé ou est indisponible.',
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
      disabled={
        !active ||
        disabled ||
        state === 'transcribing' ||
        state === 'connecting'
      }
      onClick={state === 'recording' ? stop : () => void start()}
      aria-label={
        state === 'recording' ? 'Arrêter la dictée' : 'Démarrer la dictée'
      }
      title={state === 'recording' ? 'Arrêter la dictée' : 'Démarrer la dictée'}
    >
      {state === 'transcribing' || state === 'connecting' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === 'recording' ? (
        <Square className="h-3.5 w-3.5 fill-current" />
      ) : (
        <Mic className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
