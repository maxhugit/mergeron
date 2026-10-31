/** Covers the viewport sync's zoom guard, write elision, and UA classification. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMobileViewportFixes } from './mobile-viewport';

interface FakeViewport {
  height: number;
  offsetTop: number;
  scale: number;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  emit: (type: string) => void;
}

/** Stands in for `window.visualViewport`, which jsdom does not implement. */
function fakeVisualViewport(
  height: number,
  scale = 1,
  offsetTop = 0,
): FakeViewport {
  const listeners = new Map<string, Set<() => void>>();
  return {
    height,
    offsetTop,
    scale,
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) =>
      listeners.get(type)?.delete(listener),
    emit: (type) => listeners.get(type)?.forEach((listener) => listener()),
  };
}

/** Installs a stub visual viewport and returns it. */
function useViewport(height: number, scale = 1): FakeViewport {
  const viewport = fakeVisualViewport(height, scale);
  Object.defineProperty(window, 'visualViewport', {
    value: viewport,
    configurable: true,
    writable: true,
  });
  return viewport;
}

/** Overrides the user agent for one test. */
function useUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    value,
    configurable: true,
  });
}

const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const QQ_BROWSER =
  'Mozilla/5.0 (Linux; U; Android 12; zh-cn; Build/SP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.0.0 MQQBrowser/13.7 Mobile Safari/537.36';
const WECHAT_X5 =
  'Mozilla/5.0 (Linux; Android 8.0; MI 6 Build/OPR1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/6.2 TBS/044207 Mobile Safari/537.36 MicroMessenger/6.7.2.1340(0x2607023A) NetType/WIFI Language/zh_CN';

describe('installMobileViewportFixes', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    useUserAgent(CHROME_ANDROID);
  });

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    document.documentElement.classList.remove('qq-browser');
    document.documentElement.classList.remove('keyboard-open');
    delete (navigator as Navigator & { standalone?: boolean }).standalone;
    Reflect.deleteProperty(navigator, 'maxTouchPoints');
    document.documentElement.removeAttribute('style');
    useUserAgent(CHROME_ANDROID);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Installs the fixes and registers the cleanup for teardown. */
  function install(): void {
    cleanups.push(installMobileViewportFixes());
  }

  it.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X)',
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148',
  ])('detects installed iPhones without an iOS version condition: %s', (ua) => {
    useUserAgent(ua);
    Object.defineProperty(navigator, 'standalone', {
      configurable: true,
      value: true,
    });
    useViewport(844);
    install();
    expect(document.documentElement.classList.contains('ios-standalone')).toBe(
      true,
    );
  });

  it('does not change Safari tabs or installed Android apps to the iOS layout', () => {
    useUserAgent('Mozilla/5.0 (iPhone)');
    useViewport(844);
    install();
    expect(document.documentElement.classList.contains('ios-standalone')).toBe(
      false,
    );
    cleanups.splice(0).forEach((cleanup) => cleanup());
    useUserAgent(CHROME_ANDROID);
    Object.defineProperty(navigator, 'standalone', {
      configurable: true,
      value: true,
    });
    install();
    expect(document.documentElement.classList.contains('ios-standalone')).toBe(
      false,
    );
  });

  it('recognizes iPadOS desktop identity and display-mode changes', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 5,
    });
    const media = new EventTarget() as EventTarget & { matches: boolean };
    media.matches = true;
    vi.stubGlobal('matchMedia', () => media);
    useViewport(844);
    install();
    expect(document.documentElement.classList.contains('ios-standalone')).toBe(
      true,
    );
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    expect(document.documentElement.classList.contains('ios-standalone')).toBe(
      false,
    );
  });

  it('keeps the full canvas with hardware keyboard focus and after Hide Keyboard', () => {
    const viewport = useViewport(844);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    const input = document.createElement('textarea');
    document.body.append(input);
    install();
    input.focus();
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(
      false,
    );
    viewport.height = 450;
    viewport.emit('resize');
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(
      true,
    );
    viewport.height = 844;
    viewport.emit('resize');
    expect(document.activeElement).toBe(input);
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(
      false,
    );
    input.remove();
  });

  it.each(['checkbox', 'button', 'range'])(
    'does not treat a %s as a text keyboard',
    (type) => {
      const viewport = useViewport(844);
      const input = document.createElement('input');
      input.type = type;
      document.body.append(input);
      install();
      input.focus();
      viewport.height = 450;
      viewport.emit('resize');
      expect(document.documentElement.classList.contains('keyboard-open')).toBe(
        false,
      );
      input.remove();
    },
  );

  it('settles a stale viewport after rotation/resume without an extra resize event', () => {
    vi.useFakeTimers();
    const viewport = useViewport(844);
    const height = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    install();
    window.dispatchEvent(new Event('orientationchange'));
    viewport.height = 390;
    height.mockReturnValue(390);
    width.mockReturnValue(844);
    vi.advanceTimersByTime(100);
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '390px',
    );
    window.dispatchEvent(new Event('pageshow'));
    viewport.height = 844;
    height.mockReturnValue(844);
    width.mockReturnValue(390);
    vi.advanceTimersByTime(100);
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '844px',
    );
    expect(vi.getTimerCount()).toBeLessThanOrEqual(4);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('publishes the visible height and tracks it as the viewport changes', () => {
    const viewport = useViewport(800);
    install();
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '800px',
    );

    // The iOS keyboard shrinks the visual viewport without resizing the layout.
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    viewport.height = 500;
    viewport.emit('resize');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '500px',
    );
    textarea.remove();
  });

  it('anchors the shell to the visual viewport when iOS pans for the keyboard', () => {
    const viewport = useViewport(800);
    install();
    expect(document.documentElement.style.getPropertyValue('--app-vtop')).toBe(
      '0px',
    );

    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    viewport.height = 500;
    viewport.offsetTop = 260;
    viewport.emit('scroll');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '500px',
    );
    expect(document.documentElement.style.getPropertyValue('--app-vtop')).toBe(
      '260px',
    );
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(
      true,
    );
    textarea.remove();
  });

  it('restores full height when iOS keeps a stale viewport after blur', () => {
    const viewport = useViewport(800);
    const innerHeight = vi
      .spyOn(window, 'innerHeight', 'get')
      .mockReturnValue(800);
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    install();

    viewport.height = 500;
    viewport.emit('resize');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '500px',
    );

    // Standalone iOS occasionally does not restore visualViewport.height.
    textarea.blur();
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '800px',
    );
    expect(document.documentElement.style.getPropertyValue('--app-vtop')).toBe(
      '0px',
    );
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(
      false,
    );
    textarea.remove();
    innerHeight.mockRestore();
  });

  it('holds the last height while the page is pinch-zoomed', () => {
    const viewport = useViewport(800);
    install();

    // Zooming to 2x halves the visual viewport. Sizing the shell from it would
    // collapse the whole app to the magnified region.
    viewport.height = 400;
    viewport.scale = 2;
    viewport.emit('resize');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '800px',
    );

    // Zooming back out resumes tracking.
    viewport.height = 780;
    viewport.scale = 1;
    viewport.emit('resize');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '780px',
    );
  });

  it('does not rewrite the properties when the viewport is unchanged', () => {
    const viewport = useViewport(800);
    install();
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty');

    // Panning fires `scroll` continuously; the height is the same every time.
    viewport.emit('scroll');
    viewport.emit('scroll');
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('stops tracking once cleaned up', () => {
    const viewport = useViewport(800);
    install();
    cleanups.splice(0).forEach((cleanup) => cleanup());

    viewport.height = 500;
    viewport.emit('resize');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '800px',
    );
  });

  it('reserves toolbar space for QQ Browser but not for WeChat', () => {
    useViewport(800);
    useUserAgent(QQ_BROWSER);
    install();
    expect(document.documentElement.classList.contains('qq-browser')).toBe(
      true,
    );

    document.documentElement.classList.remove('qq-browser');
    // WeChat's older Android webview shares the X5 engine and reports
    // `MQQBrowser`, but draws no bottom toolbar.
    useUserAgent(WECHAT_X5);
    install();
    expect(document.documentElement.classList.contains('qq-browser')).toBe(
      false,
    );
  });
});
