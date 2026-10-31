import { useEffect, useRef, useState } from 'react';
import { getApiToken, setApiToken } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { recordSessionDiagnostic } from './session-diagnostics';

const MESSAGE = 'mergeron:session-renewed';
export const renewalReturnPath = '/login?renew=true';

/** No redirect URL or account identity from the popup is trusted by the parent. */
export function notifySessionRenewed() {
  if (!window.opener) return;
  window.opener.postMessage(
    { type: MESSAGE, token: getApiToken() },
    window.location.origin,
  );
  window.close();
}

export function useSessionRenewal(recheck: () => void) {
  const popup = useRef<Window | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const recheckRef = useRef(recheck);
  const [popupBlocked, setPopupBlocked] = useState(false);
  useEffect(() => {
    recheckRef.current = recheck;
  }, [recheck]);
  useEffect(() => {
    const completed = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        !popup.current ||
        event.source !== popup.current ||
        event.data?.type !== MESSAGE
      )
        return;
      if (typeof event.data.token === 'string') setApiToken(event.data.token);
      // The message is only a hint. /auth/me must verify the original identity.
      recordSessionDiagnostic('renewal_hint');
      recheckRef.current();
    };
    window.addEventListener('message', completed);
    return () => {
      window.removeEventListener('message', completed);
      clearInterval(timer.current);
      popup.current?.close();
    };
  }, []);
  const open = (manual = false) => {
    if (popup.current && !popup.current.closed) {
      popup.current.focus();
      return;
    }
    const params = new URLSearchParams({ renew: 'true' });
    if (manual) params.set('manual', 'true');
    popup.current = window.open(
      withBasePath(`/login?${params}`),
      '_blank',
      'popup,width=560,height=720',
    );
    setPopupBlocked(!popup.current);
    recordSessionDiagnostic(
      popup.current ? 'renewal_opened' : 'renewal_blocked',
    );
    clearInterval(timer.current);
    if (!popup.current) return;
    // Cookies are shared even if the IdP's COOP severs window.opener. Bounded
    // read-only verification also covers a login completed in another window.
    const deadline = Date.now() + 2 * 60_000;
    timer.current = setInterval(() => {
      if (Date.now() >= deadline) clearInterval(timer.current);
      else if (navigator.onLine && document.visibilityState === 'visible')
        recheckRef.current();
    }, 5_000);
  };
  return { open, popupBlocked };
}
