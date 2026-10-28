import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  browserApi,
  browserLive,
  type BrowserLiveEvent,
} from '@/lib/browser-api';
import { Button } from '@/components/ui/button';

type Frame = Extract<BrowserLiveEvent, { type: 'frame' }>;
type Input = Record<string, unknown>;

/** Live pixels belong only to this human viewer, never to the annotation draft. */
export function BrowserLiveViewport(props: {
  threadId: string;
  tabId: string;
  active: boolean;
  onControl: (id: string | null) => void;
  onLocation: (url: string, title: string) => void;
}) {
  const { t } = useTranslation('browser');
  const callbacks = useRef(props);
  useEffect(() => {
    callbacks.current = props;
  });
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const enqueue = useRef<(input: Input) => void>(() => {});
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState('connecting');
  const [error, setError] = useState('');
  const takeover = useRef(false);
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!props.active || paused || !visible) return;
    const abort = new AbortController();
    let controlId = '';
    let frame: Frame | null = null;
    let drawing = false;
    let pending: Frame | null = null;
    let queue: { input: Input; view: Frame }[] = [];
    let sending = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    const path = `/${encodeURIComponent(props.threadId)}`;
    const sameView = (a: Frame, b: Frame) =>
      a.width === b.width && a.height === b.height && a.url === b.url;
    const fail = (reason: unknown) => {
      if (abort.signal.aborted) return;
      setError(
        reason instanceof Error && reason.message === 'BROWSER_CONTROL_REQUIRED'
          ? 'controlRequired'
          : reason instanceof Error && reason.message === 'BROWSER_STALE_VIEW'
            ? 'staleView'
            : 'liveFailed',
      );
      setState('released');
      abort.abort();
      callbacks.current.onControl(null);
    };
    async function flush() {
      if (sending || !controlId || abort.signal.aborted) return;
      sending = true;
      try {
        while (queue.length && !abort.signal.aborted) {
          const first = queue.shift()!;
          if (!frame || !sameView(first.view, frame)) {
            queue = [];
            break;
          }
          // Resize is deliberately alone: subsequent events must use the new frame geometry.
          const batch = [first.input];
          while (
            batch.length < 32 &&
            queue.length &&
            first.input.type !== 'resize' &&
            queue[0].input.type !== 'resize' &&
            sameView(first.view, queue[0].view)
          )
            batch.push(queue.shift()!.input);
          await browserApi(
            `${path}/input`,
            {
              tabId: props.tabId,
              controlId,
              url: first.view.url,
              width: first.view.width,
              height: first.view.height,
              events: batch,
            },
            abort.signal,
          );
          if (batch.some((input) => input.type === 'resize')) queue = [];
        }
      } catch (reason) {
        fail(reason);
      } finally {
        sending = false;
      }
    }
    enqueue.current = (input) => {
      if (!frame || !controlId || abort.signal.aborted) return;
      const last = queue.at(-1);
      if (
        input.type === 'pointer' &&
        input.phase === 'move' &&
        last?.input.type === 'pointer' &&
        last.input.phase === 'move'
      )
        last.input = input;
      else if (queue.length < 128) queue.push({ input, view: frame });
      else {
        fail(new Error('Input queue full'));
        return;
      }
      void flush();
    };
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!stage.current || !frame) return;
        const width = Math.max(
          480,
          Math.min(1920, Math.floor(stage.current.clientWidth)),
        );
        const height = Math.max(
          320,
          Math.min(1200, Math.floor(stage.current.clientHeight)),
        );
        if (width !== frame.width || height !== frame.height)
          enqueue.current({ type: 'resize', width, height });
      }, 200);
    };
    const observer = new ResizeObserver(resize);
    if (stage.current) observer.observe(stage.current);
    async function draw(next: Frame) {
      pending = next;
      if (drawing) return;
      drawing = true;
      try {
        while (pending && !abort.signal.aborted) {
          const current = pending;
          pending = null;
          const img = new Image();
          img.src = current.image;
          await img.decode();
          if (abort.signal.aborted || !canvas.current) break;
          const target = canvas.current;
          target.width = current.width;
          target.height = current.height;
          target.getContext('2d')?.drawImage(img, 0, 0);
          const changed = !frame || !sameView(frame, current);
          const locationChanged =
            !frame ||
            frame.url !== current.url ||
            frame.title !== current.title;
          frame = current;
          if (changed) {
            queue = [];
            resize();
          }
          if (locationChanged)
            callbacks.current.onLocation(current.url, current.title);
        }
      } catch (reason) {
        fail(reason);
      } finally {
        drawing = false;
      }
    }
    const takeControl = takeover.current;
    takeover.current = false;
    queueMicrotask(() => {
      if (!abort.signal.aborted) {
        setState('connecting');
        setError('');
      }
    });
    void browserLive(
      path,
      { tabId: props.tabId, takeControl },
      abort.signal,
      (event) => {
        if (abort.signal.aborted) return;
        if (event.type === 'ready') {
          controlId = event.controlId;
          callbacks.current.onControl(controlId);
          setState('live');
          resize();
        } else if (event.type === 'frame') void draw(event);
        else if (event.type === 'error') fail(new Error(event.code));
      },
    )
      .then(() => {
        if (abort.signal.aborted) return;
        callbacks.current.onControl(null);
        setState('connecting');
        renewal = setTimeout(() => setAttempt((value) => value + 1), 500);
      })
      .catch(fail);
    return () => {
      abort.abort();
      queue = [];
      pending = null;
      enqueue.current = () => {};
      clearTimeout(resizeTimer);
      clearTimeout(renewal);
      observer.disconnect();
      callbacks.current.onControl(null);
    };
  }, [props.threadId, props.tabId, props.active, paused, visible, attempt]);
  const pointer = (
    event: React.PointerEvent<HTMLCanvasElement>,
    phase: 'move' | 'down' | 'up',
  ) => {
    if (event.button !== 0 && event.button !== 2 && phase !== 'move') return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (phase === 'down') {
      target.setPointerCapture(event.pointerId);
      keyboard.current?.focus({ preventScroll: true });
    }
    const x = Math.min(
      target.width - 1,
      Math.max(0, ((event.clientX - rect.left) * target.width) / rect.width),
    );
    const y = Math.min(
      target.height - 1,
      Math.max(0, ((event.clientY - rect.top) * target.height) / rect.height),
    );
    enqueue.current({
      type: 'pointer',
      phase,
      x,
      y,
      button: event.button === 2 ? 'right' : 'left',
      clickCount: Math.min(2, Math.max(1, event.detail || 1)),
    });
    if (phase === 'up' && target.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId);
    event.preventDefault();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs">
        <span role="status" className="flex-1">
          {t(
            paused || !visible
              ? 'released'
              : state === 'live'
                ? 'liveControl'
                : state === 'connecting'
                  ? 'connecting'
                  : 'released',
          )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (!paused && state === 'live') {
              setPaused(true);
              return;
            }
            takeover.current = true;
            setPaused(false);
            setAttempt((value) => value + 1);
          }}
        >
          {t(!paused && state === 'live' ? 'releaseControl' : 'takeControl')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="p-2 text-xs text-destructive">
          {t(
            error === 'controlRequired'
              ? 'controlRequired'
              : error === 'staleView'
                ? 'staleView'
                : 'liveFailed',
          )}
        </p>
      )}
      <div
        ref={stage}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30"
      >
        <canvas
          ref={canvas}
          width={1000}
          height={700}
          aria-label={t('livePage')}
          className="max-h-full max-w-full touch-none"
          style={{ width: 'auto', height: 'auto' }}
          onPointerDown={(event) => pointer(event, 'down')}
          onPointerUp={(event) => pointer(event, 'up')}
          onPointerMove={(event) => pointer(event, 'move')}
          onPointerCancel={() => {
            setPaused(true);
          }}
          onContextMenu={(event) => event.preventDefault()}
          onWheel={(event) => {
            event.preventDefault();
            enqueue.current({
              type: 'wheel',
              deltaX: Math.max(-1400, Math.min(1400, event.deltaX)),
              deltaY: Math.max(-1400, Math.min(1400, event.deltaY)),
            });
          }}
        />
        <textarea
          ref={keyboard}
          aria-label={t('liveKeyboard')}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="absolute left-0 top-0 h-px w-px opacity-0"
          tabIndex={0}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            if (
              (event.ctrlKey || event.metaKey) &&
              ['v', 'c', 'x'].includes(event.key.toLowerCase())
            )
              return;
            const key = event.key === ' ' ? 'Space' : event.key;
            if (
              [
                'Enter',
                'Tab',
                'Backspace',
                'Delete',
                'Escape',
                'ArrowUp',
                'ArrowDown',
                'ArrowLeft',
                'ArrowRight',
                'Home',
                'End',
                'PageUp',
                'PageDown',
              ].includes(key) ||
              ((event.ctrlKey || event.metaKey) && /^[abiuyz]$/i.test(key))
            ) {
              event.preventDefault();
              enqueue.current({
                type: 'key',
                key: `${event.ctrlKey ? 'Control+' : ''}${event.metaKey ? 'Meta+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`,
              });
            } else if (event.ctrlKey || event.metaKey || event.altKey)
              event.preventDefault();
          }}
          onInput={(event) => {
            if (!(event.nativeEvent as InputEvent).isComposing) {
              const text = event.currentTarget.value;
              event.currentTarget.value = '';
              if (text)
                enqueue.current({ type: 'text', text: text.slice(0, 2000) });
            }
          }}
          onCompositionEnd={(event) => {
            const text = event.currentTarget.value;
            event.currentTarget.value = '';
            if (text)
              enqueue.current({ type: 'text', text: text.slice(0, 2000) });
          }}
          onPaste={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const text = event.clipboardData.getData('text/plain');
            if (text)
              enqueue.current({ type: 'text', text: text.slice(0, 2000) });
          }}
        />
      </div>
    </div>
  );
}
