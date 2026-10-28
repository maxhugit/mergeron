import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { page, userEvent } from 'vitest/browser';
import { BrowserLiveViewport } from './browser-live-viewport';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => vi.fn());
const live = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-api', () => ({ browserApi: api, browserLive: live }));
afterEach(cleanup);

test('draws live frames, sends mouse and keyboard in order and releases control when hidden', async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  const source = document.createElement('canvas');
  source.width = 800;
  source.height = 500;
  source.getContext('2d')!.fillStyle = '#336699';
  source.getContext('2d')!.fillRect(0, 0, 800, 500);
  const image = source.toDataURL('image/jpeg');
  let signal!: AbortSignal;
  api.mockReset().mockResolvedValue({ applied: true });
  live.mockReset().mockImplementation((_path, _body, abort, receive) => {
    signal = abort;
    receive({ type: 'ready', controlId: 'lease' });
    receive({
      type: 'frame',
      image,
      width: 800,
      height: 500,
      url: 'https://example.com/',
      title: 'Live fixture',
    });
    return new Promise<void>((resolve) =>
      abort.addEventListener('abort', () => resolve(), { once: true }),
    );
  });
  const control = vi.fn();
  const location = vi.fn();
  const view = render(
    <div style={{ width: 800, height: 530, display: 'flex' }}>
      <BrowserLiveViewport
        threadId="thread"
        tabId="tab"
        active
        onControl={control}
        onLocation={location}
      />
    </div>,
  );
  await expect.poll(() => location.mock.calls.length).toBe(1);
  const canvas = document.querySelector('canvas')!;
  expect(
    canvas.getContext('2d')!.getImageData(10, 10, 1, 1).data[2],
  ).toBeGreaterThan(100);
  await page.getByLabelText('Live remote page — click to interact').click();
  await userEvent.keyboard('hello{Enter}');
  await expect
    .poll(() =>
      api.mock.calls
        .flatMap(([, body]) => body.events)
        .some((input) => input.type === 'key' && input.key === 'Enter'),
    )
    .toBe(true);
  const events = api.mock.calls.flatMap(([, body]) => body.events);
  expect(
    events.some((input) => input.type === 'pointer' && input.phase === 'down'),
  ).toBe(true);
  expect(
    events
      .filter((input) => input.type === 'text')
      .map((input) => input.text)
      .join(''),
  ).toBe('hello');
  expect(
    api.mock.calls.every(
      ([path, body]) =>
        path === '/thread/input' &&
        body.controlId === 'lease' &&
        body.tabId === 'tab',
    ),
  ).toBe(true);
  expect(control).toHaveBeenCalledWith('lease');
  const oldSignal = signal;
  view.rerender(
    <div style={{ width: 800, height: 530, display: 'flex' }}>
      <BrowserLiveViewport
        threadId="thread"
        tabId="second"
        active
        onControl={control}
        onLocation={location}
      />
    </div>,
  );
  await expect.poll(() => live.mock.calls.length).toBe(2);
  expect(oldSignal.aborted).toBe(true);
  expect(live.mock.calls[1][1]).toMatchObject({
    tabId: 'second',
    previousControlId: 'lease',
    takeControl: false,
  });
  view.unmount();
  expect(signal.aborted).toBe(true);
  expect(control).toHaveBeenLastCalledWith(null);
});

test('requires an explicit user action to replace another controller and never retries input', async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  live.mockReset().mockRejectedValue(new Error('BROWSER_CONTROL_REQUIRED'));
  api.mockReset();
  render(
    <div style={{ width: 800, height: 530, display: 'flex' }}>
      <BrowserLiveViewport
        threadId="thread"
        tabId="tab"
        active
        onControl={() => {}}
        onLocation={() => {}}
      />
    </div>,
  );
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('Another view controls');
  expect(live).toHaveBeenCalledTimes(1);
  expect(live.mock.calls[0][1].takeControl).toBe(false);
  await page.getByRole('button', { name: 'Take control' }).click();
  await expect.poll(() => live.mock.calls.length).toBe(2);
  expect(live.mock.calls[1][1].takeControl).toBe(true);
  expect(api).not.toHaveBeenCalled();
});
