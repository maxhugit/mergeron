import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { showSnackbar } from '@/stores/snackbar-store';
import { startCliDictation, type CliDictation } from '@/lib/cli-dictation';

const MAX_RECORDING_MS = 2 * 60 * 1000;
type State = 'idle' | 'connecting' | 'recording' | 'transcribing';

/** Dictation uses the authenticated CLI exclusively; no direct API fallback. */
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
  const cliRef = useRef<CliDictation | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      void cliRef.current?.cancel();
      cliRef.current = null;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      setState('idle');
    },
    [active],
  );

  const stop = () => {
    const cli = cliRef.current;
    if (!cli) return;
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
  };
  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState('connecting');
    try {
      const cli = await startCliDictation(controller.signal);
      if (controller.signal.aborted) {
        await cli.cancel();
        return;
      }
      cliRef.current = cli;
      setState('recording');
      timerRef.current = window.setTimeout(stop, MAX_RECORDING_MS);
    } catch (error) {
      if (controller.signal.aborted) return;
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
