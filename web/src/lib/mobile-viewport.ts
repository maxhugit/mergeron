/**
 * Mirrors the visual viewport into `--app-vh` and `--app-vtop`, the size and
 * position every full-height surface in the app is anchored to.
 *
 * `100dvh` tracks retractable browser chrome but not the software keyboard on
 * iOS, where the keyboard neither resizes the layout viewport nor honours
 * `interactive-widget`. Some embedded browsers additionally draw a bottom
 * toolbar over the page without reducing `innerHeight`. In both cases a
 * `100dvh` shell puts the composer underneath something, and
 * `visualViewport.height` is the only reading that reflects what is visible.
 */

/** Extra bottom padding reserved for overlay browser chrome (QQ Browser). */
const QQ_BOTTOM_GAP_PX = 56;

/** Matches QQ Browser and its embedded webview user agents. */
const QQ_BROWSER_UA = /MQQBrowser|QQBrowser|QQ\//i;

/**
 * WeChat's Android webview is built on the same X5/TBS engine and carries
 * `MQQBrowser` in its user agent, but draws no such toolbar. Without this
 * exclusion every WeChat user loses a strip of the composer area to chrome
 * that is not there.
 */
const WECHAT_UA = /MicroMessenger/i;

/** Whether focus can currently summon an on-screen keyboard. */
function hasKeyboardFocus(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement) {
    return (
      !active.disabled &&
      !active.readOnly &&
      active.inputMode !== 'none' &&
      ![
        'button',
        'checkbox',
        'color',
        'file',
        'hidden',
        'radio',
        'range',
        'reset',
        'submit',
      ].includes(active.type)
    );
  }
  return (
    (active instanceof HTMLTextAreaElement &&
      !active.disabled &&
      !active.readOnly &&
      active.inputMode !== 'none') ||
    active instanceof HTMLSelectElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
}

/** Marks QQ Browser so CSS can reserve space for its overlay toolbar. */
function markQqBrowser(): void {
  const ua = navigator.userAgent;
  if (WECHAT_UA.test(ua) || !QQ_BROWSER_UA.test(ua)) return;
  document.documentElement.classList.add('qq-browser');
  document.documentElement.style.setProperty(
    '--qq-bottom-gap',
    `${QQ_BOTTOM_GAP_PX}px`,
  );
}

/**
 * Installs the viewport sync and returns a cleanup function.
 *
 * Each call registers its own listeners and its own cleanup, so calling it
 * more than once leaks nothing as long as every returned function is invoked.
 *
 * @returns Removes the listeners this call registered.
 */
export function installMobileViewportFixes(): () => void {
  markQqBrowser();

  const root = document.documentElement;
  // iPadOS can identify as a Mac. Do not parse an iOS version: installed-app
  // viewport bugs predate iOS 27, and standalone UAs may omit version tokens.
  const ios =
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const displayMode = window.matchMedia?.('(display-mode: standalone)');
  let appliedHeight: string | null = null;
  let appliedTop: string | null = null;
  let restingHeight = 0;
  let restingWidth = 0;
  const timers = new Set<number>();

  const sync = () => {
    const viewport = window.visualViewport;
    // Pinch zoom shrinks the visual viewport without shrinking the layout, and
    // scrolls it away from the document origin. Sizing the shell from it then
    // collapses the whole app to the magnified region — and because the visual
    // viewport also emits `scroll` while zoomed, it would do so on every pan.
    // The layout is already correct at scale 1, so zoom simply holds the last
    // reading. At scale 1, however, iOS can move the visual viewport away from
    // the document origin while focusing a textarea. The shell must follow that
    // offset as well as its height or the composer appears at the top of the
    // screen, outside the portion left visible above the keyboard.
    if (viewport && viewport.scale !== 1) return;
    root.classList.toggle(
      'ios-standalone',
      ios &&
        Boolean(
          displayMode?.matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone,
        ),
    );
    const visualHeight = viewport?.height || 0;
    const layoutHeight = Math.max(
      window.innerHeight || 0,
      root.clientHeight || 0,
    );
    const width = window.innerWidth;
    if (width !== restingWidth) {
      restingWidth = width;
      restingHeight = layoutHeight;
    }
    // Focus alone is NOT a keyboard: hardware keyboards and iOS's Hide
    // Keyboard leave the textarea focused. Only reserve a shrunken rectangle
    // when there is actual occlusion. The baseline also handles browsers that
    // resize both layout and visual viewports when their keyboard appears.
    const keyboardOpen =
      hasKeyboardFocus() &&
      visualHeight > 0 &&
      Math.max(layoutHeight, restingHeight) - visualHeight > 100;
    root.classList.toggle('keyboard-open', keyboardOpen);
    const height = keyboardOpen
      ? visualHeight
      : Math.max(layoutHeight, visualHeight);
    if (height <= 0) return;
    if (!keyboardOpen) restingHeight = height;
    const top = keyboardOpen ? Math.max(0, viewport?.offsetTop || 0) : 0;
    const nextHeight = `${height}px`;
    const nextTop = `${top}px`;
    // `scroll` fires far more often than either reading changes; writing an
    // identical value still dirties style on every one of them.
    if (nextHeight !== appliedHeight) {
      appliedHeight = nextHeight;
      root.style.setProperty('--app-vh', nextHeight);
    }
    if (nextTop !== appliedTop) {
      appliedTop = nextTop;
      root.style.setProperty('--app-vtop', nextTop);
    }
  };

  // iOS settles safe areas/viewport readings after focus, rotation and resume;
  // it does not always emit a final resize. Bounded retries, not a polling loop.
  const settle = () => {
    timers.forEach((timer) => window.clearTimeout(timer));
    timers.clear();
    sync();
    for (const delay of [0, 100, 300, 700]) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        sync();
      }, delay);
      timers.add(timer);
    }
  };
  const visible = () => {
    if (document.visibilityState === 'visible') settle();
  };

  sync();
  window.addEventListener('resize', sync, { passive: true });
  window.addEventListener('orientationchange', settle, { passive: true });
  window.addEventListener('pageshow', settle);
  document.addEventListener('visibilitychange', visible);
  document.addEventListener('focusin', settle);
  document.addEventListener('focusout', settle);
  displayMode?.addEventListener?.('change', settle);
  window.visualViewport?.addEventListener('resize', sync, { passive: true });
  window.visualViewport?.addEventListener('scroll', sync, { passive: true });

  return () => {
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', settle);
    window.removeEventListener('pageshow', settle);
    document.removeEventListener('visibilitychange', visible);
    document.removeEventListener('focusin', settle);
    document.removeEventListener('focusout', settle);
    displayMode?.removeEventListener?.('change', settle);
    window.visualViewport?.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('scroll', sync);
    root.classList.remove('keyboard-open');
    root.classList.remove('ios-standalone');
    timers.forEach((timer) => window.clearTimeout(timer));
  };
}
