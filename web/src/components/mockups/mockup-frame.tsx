import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mockupSource, validMockupMessage } from '@/lib/mockup-sandbox';

export function MockupFrame({ html, title }: { html: string; title: string }) {
  const { t } = useTranslation('mockups');
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState(false);
  const session = useMemo(() => crypto.randomUUID(), []);
  const source = useMemo(() => mockupSource(html, session), [html, session]);
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        validMockupMessage(event, frame.current?.contentWindow ?? null, session)
      )
        setError(true);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [session]);
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
