import type { PresentationState } from '@/lib/mockup-presentation';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mockupSource, readMockupMessage } from '@/lib/mockup-sandbox';

export function MockupFrame({
  html,
  title,
  initialState = null,
  onPresentation,
}: {
  html: string;
  title: string;
  initialState?: PresentationState | null;
  onPresentation?: (state: PresentationState) => void;
}) {
  const { t } = useTranslation('mockups');
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState(false);
  const session = useMemo(() => crypto.randomUUID(), []);
  const source = useMemo(
    () => mockupSource(html, session, initialState),
    [html, session, initialState],
  );
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = readMockupMessage(
        event,
        frame.current?.contentWindow ?? null,
        session,
      );
      if (message?.kind === 'error') setError(true);
      if (message?.kind === 'presentation') onPresentation?.(message.state);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [session, onPresentation]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <p
          role="alert"
          className="shrink-0 border-b p-2 text-sm text-destructive"
        >
          {t('scriptError')}
        </p>
      )}
      <iframe
        ref={frame}
        title={title}
        srcDoc={source}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; fullscreen 'none'; payment 'none'; usb 'none'"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
