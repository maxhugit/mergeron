import { BadRequestException } from '@nestjs/common';
import type { BrowserContext, Page } from 'playwright-core';

export type BrowserInput =
  | {
      type: 'pointer';
      phase: 'move' | 'down' | 'up';
      x: number;
      y: number;
      button: 'left' | 'right';
      clickCount: number;
    }
  | { type: 'wheel'; deltaX: number; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
  | { type: 'resize'; width: number; height: number };

export function browserInput(value: unknown): BrowserInput {
  if (!value || typeof value !== 'object')
    throw new BadRequestException('Invalid input');
  const v = value as Record<string, unknown>;
  const finite = (name: string, min: number, max: number) => {
    const n = v[name];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
      throw new BadRequestException('Invalid input');
    return n;
  };
  if (
    v.type === 'pointer' &&
    ['move', 'down', 'up'].includes(String(v.phase)) &&
    ['left', 'right'].includes(String(v.button)) &&
    Number.isInteger(v.clickCount)
  )
    return {
      type: 'pointer',
      phase: v.phase as 'move' | 'down' | 'up',
      x: finite('x', 0, 1919),
      y: finite('y', 0, 1199),
      button: v.button as 'left' | 'right',
      clickCount: finite('clickCount', 1, 2),
    };
  if (v.type === 'wheel')
    return {
      type: 'wheel',
      deltaX: finite('deltaX', -1400, 1400),
      deltaY: finite('deltaY', -1400, 1400),
    };
  if (v.type === 'resize')
    return {
      type: 'resize',
      width: Math.round(finite('width', 480, 1920)),
      height: Math.round(finite('height', 320, 1200)),
    };
  if (v.type === 'text' && typeof v.text === 'string' && v.text.length <= 2000)
    return { type: 'text', text: v.text };
  if (
    v.type === 'key' &&
    typeof v.key === 'string' &&
    /^(?:(?:Control|Meta|Alt|Shift)\+){0,3}(?:Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|[aAbBiIuUzZyY])$/.test(
      v.key,
    )
  )
    return { type: 'key', key: v.key };
  throw new BadRequestException('Invalid input');
}

export async function applyBrowserInput(page: Page, input: BrowserInput) {
  if (input.type === 'pointer') {
    const size = page.viewportSize();
    if (!size || input.x >= size.width || input.y >= size.height)
      throw new BadRequestException('Invalid point');
    await page.mouse.move(input.x, input.y);
    if (input.phase !== 'move')
      await page.mouse[input.phase]({
        button: input.button,
        clickCount: input.clickCount,
      });
  } else if (input.type === 'wheel')
    await page.mouse.wheel(input.deltaX, input.deltaY);
  else if (input.type === 'key') await page.keyboard.press(input.key);
  else if (input.type === 'text') await page.keyboard.insertText(input.text);
  else await page.setViewportSize({ width: input.width, height: input.height });
}

/** Private CDP stays server-side. Only bounded pixels/metadata reach the authenticated viewer. */
export async function streamBrowserPage(
  context: BrowserContext,
  page: Page,
  signal: AbortSignal,
  emit: (event: Record<string, unknown>) => Promise<void>,
  authorize: () => void,
  controlId: string,
) {
  const cdp = await context.newCDPSession(page);
  let sending = false;
  let closed = false;
  let failure: unknown;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    closed = true;
    finish();
  };
  const fail = (error: unknown) => {
    failure = error;
    stop();
  };
  signal.addEventListener('abort', stop, { once: true });
  cdp.on('close', stop);
  page.on('close', stop);
  page.on('crash', stop);
  let ticks = 0;
  const heartbeat = setInterval(() => {
    try {
      authorize();
      if (++ticks % 15 === 0 && !sending && !closed) {
        sending = true;
        void emit({ type: 'heartbeat' })
          .catch(fail)
          .finally(() => {
            sending = false;
          });
      }
    } catch (error) {
      fail(error);
    }
  }, 1000).unref();
  // Renew through authenticated ingress regularly; no indefinitely valid bearer stream.
  const renewal = setTimeout(stop, 5 * 60_000).unref();
  cdp.on('Page.screencastFrame', (event) => {
    if (closed) return;
    if (sending) {
      void cdp
        .send('Page.screencastFrameAck', { sessionId: event.sessionId })
        .catch(fail);
      return;
    }
    sending = true;
    void (async () => {
      try {
        authorize();
        if (event.data.length > 4_000_000)
          throw new Error('Frame exceeds limit');
        const width = Math.round(event.metadata.deviceWidth),
          height = Math.round(event.metadata.deviceHeight);
        if (width < 1 || width > 1920 || height < 1 || height > 1200)
          throw new Error('Invalid frame size');
        await emit({
          type: 'frame',
          image: `data:image/jpeg;base64,${event.data}`,
          width,
          height,
          url: page.url(),
          title: (await page.title().catch(() => '')).slice(0, 200),
        });
        // Acknowledge after transport backpressure, capped at about 15 fps.
        await new Promise<void>((resolve) => setTimeout(resolve, 65));
        if (!closed)
          await cdp.send('Page.screencastFrameAck', {
            sessionId: event.sessionId,
          });
      } catch (error) {
        fail(error);
      } finally {
        sending = false;
      }
    })();
  });
  try {
    authorize();
    if (signal.aborted) return;
    await cdp.send('Page.enable');
    await page.bringToFront();
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: 1920,
      maxHeight: 1200,
      everyNthFrame: 1,
    });
    await emit({ type: 'ready', controlId });
    await done;
    if (failure)
      throw failure instanceof Error
        ? failure
        : new Error('Browser stream failed');
  } finally {
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(renewal);
    signal.removeEventListener('abort', stop);
    page.off('close', stop);
    page.off('crash', stop);
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
    // Never leave a mouse button or modifier held after disconnect/hidden view.
    await page.mouse.up({ button: 'left' }).catch(() => {});
    await page.mouse.up({ button: 'right' }).catch(() => {});
    for (const key of ['Control', 'Meta', 'Alt', 'Shift'])
      await page.keyboard.up(key).catch(() => {});
  }
}
