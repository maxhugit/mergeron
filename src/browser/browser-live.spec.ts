import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import {
  browserInput,
  applyBrowserInput,
  streamBrowserPage,
} from './browser-live';

it.each([
  { type: 'resize', width: 20_000, height: 700 },
  {
    type: 'pointer',
    phase: 'down',
    button: 'left',
    clickCount: 1.5,
    x: 0,
    y: 0,
  },
  {
    type: 'pointer',
    phase: 'down',
    button: 'left',
    clickCount: 1,
    x: NaN,
    y: 0,
  },
  { type: 'text', text: 'x'.repeat(2001) },
  { type: 'key', key: 'Control+F12' },
  { type: 'evaluate', script: 'document.cookie' },
])('rejects invalid or privileged input %j', (input) => {
  expect(() => browserInput(input)).toThrow();
});

function fixture() {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn().mockResolvedValue({}),
    detach: vi.fn().mockResolvedValue(undefined),
  });
  const page = Object.assign(new EventEmitter(), {
    bringToFront: vi.fn().mockResolvedValue(undefined),
    url: () => 'https://example.com/',
    title: vi.fn().mockResolvedValue('Example'),
    viewportSize: () => ({ width: 1000, height: 700 }),
    mouse: {
      move: vi.fn().mockResolvedValue(undefined),
      down: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined),
    },
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      insertText: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockResolvedValue(undefined),
    },
    setViewportSize: vi.fn().mockResolvedValue(undefined),
  });
  return {
    cdp,
    page,
    context: { newCDPSession: vi.fn().mockResolvedValue(cdp) },
  };
}

it('applies only validated input and bounds pointers to the current viewport', async () => {
  const { page } = fixture();
  await applyBrowserInput(
    page as never,
    browserInput({ type: 'text', text: 'hello' }),
  );
  expect(page.keyboard.insertText).toHaveBeenCalledWith('hello');
  await applyBrowserInput(
    page as never,
    browserInput({ type: 'key', key: 'Control+a' }),
  );
  expect(page.keyboard.press).toHaveBeenCalledWith('Control+a');
  await expect(
    applyBrowserInput(
      page as never,
      browserInput({
        type: 'pointer',
        phase: 'down',
        button: 'left',
        clickCount: 1,
        x: 1100,
        y: 5,
      }),
    ),
  ).rejects.toThrow();
  expect(page.mouse.down).not.toHaveBeenCalled();
});

it('streams pixels without exposing CDP, honors backpressure and releases input on disconnect', async () => {
  const { context, page, cdp } = fixture();
  const abort = new AbortController();
  let drain!: () => void;
  const emit = vi.fn(async (event: Record<string, unknown>) => {
    if (event.type === 'frame')
      await new Promise<void>((resolve) => {
        drain = resolve;
      });
  });
  const authorize = vi.fn();
  const done = streamBrowserPage(
    context as never,
    page as never,
    abort.signal,
    emit,
    authorize,
    'lease',
  );
  await vi.waitFor(() =>
    expect(emit).toHaveBeenCalledWith({ type: 'ready', controlId: 'lease' }),
  );
  cdp.emit('Page.screencastFrame', {
    sessionId: 7,
    data: 'anBlZw==',
    metadata: { deviceWidth: 1000, deviceHeight: 700 },
  });
  await vi.waitFor(() =>
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'frame',
        image: 'data:image/jpeg;base64,anBlZw==',
      }),
    ),
  );
  expect(cdp.send).not.toHaveBeenCalledWith('Page.screencastFrameAck', {
    sessionId: 7,
  });
  drain();
  await vi.waitFor(() =>
    expect(cdp.send).toHaveBeenCalledWith('Page.screencastFrameAck', {
      sessionId: 7,
    }),
  );
  abort.abort();
  await done;
  expect(cdp.detach).toHaveBeenCalledOnce();
  expect(page.keyboard.up).toHaveBeenCalledWith('Control');
  expect(page.mouse.up).toHaveBeenCalledWith({ button: 'left' });
  expect(authorize.mock.calls.length).toBeGreaterThan(1);
});

it('stops delivering frames as soon as authorization is revoked', async () => {
  const { context, page, cdp } = fixture();
  const abort = new AbortController();
  const emit = vi.fn().mockResolvedValue(undefined);
  const authorize = vi.fn();
  const done = streamBrowserPage(
    context as never,
    page as never,
    abort.signal,
    emit,
    authorize,
    'lease',
  );
  const rejected = expect(done).rejects.toThrow('revoked');
  await vi.waitFor(() =>
    expect(emit).toHaveBeenCalledWith({ type: 'ready', controlId: 'lease' }),
  );
  authorize.mockImplementation(() => {
    throw new Error('revoked');
  });
  cdp.emit('Page.screencastFrame', {
    sessionId: 1,
    data: 'anBlZw==',
    metadata: { deviceWidth: 1000, deviceHeight: 700 },
  });
  await rejected;
  expect(emit).toHaveBeenCalledTimes(1);
  expect(cdp.detach).toHaveBeenCalledOnce();
});
