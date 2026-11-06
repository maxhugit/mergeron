import { useEffect, useRef, useState } from 'react';
import { withBasePath } from '@/base-path';
import { recordSessionDiagnostic } from './session-diagnostics';

export const SILENT_RENEWAL_TIMEOUT_MS = 15_000;
export type SilentRenewalState =
  | 'idle'
  | 'running'
  | 'interactive'
  | 'unavailable';

/** One attempt per closed gate. A frame message can request verification, never access. */
export function useSilentSessionRenewal(
  enabled: boolean,
  generation: number,
  recheck: () => Promise<boolean>,
) {
  const [state, setState] = useState<SilentRenewalState>('idle');
  const attempted = useRef<number | null>(null);
  const dispose = useRef<(() => void) | undefined>(undefined);
  const verify = useRef(recheck);
  useEffect(() => {
    verify.current = recheck;
  }, [recheck]);
  useEffect(
    () => () => {
      dispose.current?.();
      attempted.current = null;
    },
    [],
  );
  useEffect(() => {
    dispose.current?.();
  }, [generation]);
  useEffect(() => {
    if (!enabled || attempted.current === generation) return;
    dispose.current?.();
    if (!navigator.onLine || document.visibilityState !== 'visible') return;
    attempted.current = generation;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const request = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms',
    );
    frame.title = 'Session renewal';
    frame.referrerPolicy = 'no-referrer';
    let active = true;
    let received = false;
    const cleanup = () => {
      active = false;
      clearTimeout(timeout);
      window.removeEventListener('message', completed);
      frame.remove();
    };
    const finish = (next: SilentRenewalState) => {
      if (!active) return;
      cleanup();
      if (next === 'interactive') recordSessionDiagnostic('silent_interactive');
      if (next === 'unavailable') recordSessionDiagnostic('silent_failed');
      setState(next);
    };
    const completed = (event: MessageEvent) => {
      if (
        received ||
        event.origin !== window.location.origin ||
        event.source !== frame.contentWindow ||
        event.data?.type !== 'mergeron:silent-renewal' ||
        event.data.request !== request
      )
        return;
      if (event.data.status === 'interactive') return finish('interactive');
      if (event.data.status === 'unavailable') return finish('unavailable');
      if (event.data.status !== 'complete') return;
      received = true;
      recordSessionDiagnostic('renewal_hint');
      // The normal coordinator rejects revoked accounts, changed rights and stale responses.
      void verify.current().then(
        (ok) => finish(ok ? 'idle' : 'unavailable'),
        () => finish('unavailable'),
      );
    };
    const timeout = window.setTimeout(
      () => finish('unavailable'),
      SILENT_RENEWAL_TIMEOUT_MS,
    );
    dispose.current = cleanup;
    window.addEventListener('message', completed);
    recordSessionDiagnostic('silent_started');
    frame.src = withBasePath(`/api/auth/session/renew?request=${request}`);
    // React StrictMode replays mount effects; do not start an obsolete login
    // request which could race a newer state cookie.
    queueMicrotask(() => {
      if (active) {
        setState('running');
        document.body.append(frame);
      }
    });
  }, [enabled, generation]);
  return state;
}
