/** A real container PTY. Input is sequenced and never replayed into a replacement shell. */
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from 'react-i18next';
import { projectsApi } from '@/lib/projects-api';

export function PreviewContainerTerminal({
  prefix,
  runId,
  component,
}: {
  prefix: string;
  runId: string;
  component: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const { t } = useTranslation('previews');
  useEffect(() => {
    if (!element.current) return;
    let disposed = false,
      sessionId: string | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    let halted = false;
    let queued = '',
      sequence = 0,
      offset = 0;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 2000,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element.current);
    const resize = () => {
      if (element.current?.clientHeight && element.current.clientWidth)
        fit.fit();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    const request = <T,>(body: Record<string, unknown>) =>
      projectsApi<T>(prefix + '/terminal', {
        method: 'POST',
        body: JSON.stringify({ ...body, runId, component, sessionId }),
      });
    const close = () => {
      if (sessionId) void request({ action: 'close' }).catch(() => {});
    };
    const onData = term.onData((data) => {
      if (disposed || halted || !sessionId) return;
      if (queued.length + data.length > 32768) {
        halted = true;
        setError(t('terminalDisconnected'));
        close();
        return;
      }
      queued += data;
    });
    const pump = async () => {
      if (disposed || halted) return;
      const data = queued.slice(0, 2048);
      queued = queued.slice(data.length);
      const next = data ? sequence + 1 : sequence;
      try {
        const result = await request<{
          text: string;
          offset: number;
          ended: boolean;
          truncated: boolean;
          sequence: number;
        }>({
          action: 'exchange',
          sequence: next,
          offset,
          data,
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) return;
        sequence = result.sequence;
        offset = result.offset;
        if (result.truncated) term.reset();
        term.write(result.text);
        if (result.ended) {
          halted = true;
          setError(t('terminalEnded'));
          return;
        }
        timer = setTimeout(() => void pump(), 250);
      } catch {
        if (!disposed) {
          halted = true;
          setError(t('terminalDisconnected'));
          close();
        }
      }
    };
    void request<{ sessionId: string }>({
      action: 'open',
      cols: term.cols,
      rows: term.rows,
    })
      .then((result) => {
        sessionId = result.sessionId;
        if (disposed) {
          close();
          return;
        }
        term.focus();
        void pump();
      })
      .catch(() => {
        if (!disposed) setError(t('terminalUnavailable'));
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
      onData.dispose();
      observer.disconnect();
      close();
      term.dispose();
    };
  }, [prefix, runId, component, t]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {error && (
        <p role="alert" className="shrink-0 p-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div
        ref={element}
        aria-label={t('containerTerminal')}
        className="min-h-0 flex-1 overflow-hidden p-2"
      />
    </div>
  );
}
