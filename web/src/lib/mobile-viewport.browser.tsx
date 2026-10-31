/** Real CSS layout with injected iOS geometry. This is NOT an iOS system/PWA
 * compositor test: the final blur/physical-screen check needs a real iPhone. */
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { installMobileViewportFixes } from './mobile-viewport';
import '@/index.css';

let dispose: (() => void) | undefined;
let frame: HTMLElement | undefined;
let safeAreas: HTMLStyleElement | undefined;
let viewportMeta: HTMLMetaElement | undefined;
let previousViewport: string | null = null;
let createdViewport = false;
const engine = navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit';
afterEach(() => {
  dispose?.();
  frame?.remove();
  safeAreas?.remove();
  if (createdViewport) viewportMeta?.remove();
  else if (previousViewport != null)
    viewportMeta?.setAttribute('content', previousViewport);
  else viewportMeta?.removeAttribute('content');
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('style');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(
  standalone: boolean,
  height: number,
  top: number,
  bottom: number,
  sides = 0,
  userAgent = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148',
) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  vi.stubGlobal('matchMedia', () => ({
    matches: standalone,
    addEventListener() {},
    removeEventListener() {},
  }));
  const viewport = Object.assign(new EventTarget(), {
    height,
    scale: 1,
    offsetTop: 0,
  });
  vi.stubGlobal('visualViewport', viewport);
  // Simulate env() at stylesheet priority, so the installed-app policy can
  // suppress a second inset without pretending to emulate iOS's compositor.
  safeAreas = document.createElement('style');
  safeAreas.textContent = `:root { --app-safe-top: ${top}px; --app-safe-bottom: ${bottom}px; --app-safe-left: ${sides}px; --app-safe-right: ${sides}px; }`;
  document.head.append(safeAreas);
  viewportMeta =
    document.querySelector<HTMLMetaElement>('meta[name="viewport"]') ??
    undefined;
  createdViewport = !viewportMeta;
  viewportMeta ??= document.createElement('meta');
  previousViewport = viewportMeta.getAttribute('content');
  viewportMeta.name = 'viewport';
  viewportMeta.content =
    'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content';
  if (createdViewport) document.head.append(viewportMeta);
  frame = document.createElement('div');
  frame.id = 'root';
  // Static, inert test content only. Production CSS owns all relevant geometry.
  frame.innerHTML = `<main class="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header class="glass-bar flex h-11 shrink-0 items-center px-3"><button>☰</button><span class="px-3">Mergeron · Agent</span><button>↻</button></header>
    <section class="min-h-0 flex-1 overflow-auto p-3"><h1>Conversation</h1><p>Le contenu reste dans la zone visible.</p><div style="height:1200px"></div></section>
    <footer class="app-composer shrink-0 px-3 pt-3"><div class="rounded-2xl border bg-card p-3"><textarea aria-label="Message" placeholder="Tapez un message…" class="min-h-16 w-full"></textarea><button>Envoyer</button></div></footer>
  </main>`;
  document.body.append(frame);
  dispose = installMobileViewportFixes();
  return viewport;
}

test.each([
  [390, 844, 59, 34, 0, false],
  [430, 932, 62, 34, 0, true],
  [844, 390, 0, 21, 44, true],
  [375, 667, 0, 0, 0, false],
  [1280, 800, 0, 0, 0, false],
] as const)(
  'fills the installed iOS %ix%i native viewport without reserving safe areas twice',
  async (width, height, top, bottom, sides, dark) => {
    await page.viewport(width, height);
    document.documentElement.classList.toggle('dark', dark);
    fixture(true, height, top, bottom, sides);
    const bounds = frame!.getBoundingClientRect();
    expect(bounds.top).toBe(0);
    expect(bounds.height).toBe(height);
    expect(getComputedStyle(frame!).position).toBe('absolute');
    expect(getComputedStyle(frame!).paddingBottom).toBe('0px');
    const header = frame!.querySelector('header')!;
    expect(header.getBoundingClientRect().top).toBe(0);
    expect(getComputedStyle(header).backdropFilter).toBe('none');
    expect(viewportMeta!.content).toBe('width=device-width, initial-scale=1.0');
    const footer = frame!.querySelector('footer')!;
    expect(footer.getBoundingClientRect().bottom).toBe(height);
    const expectedInset = width >= 640 ? 20 : 16;
    expect(parseFloat(getComputedStyle(footer).paddingBottom)).toBe(
      expectedInset,
    );
    const surface = getComputedStyle(footer.firstElementChild!);
    expect(surface.borderBottomLeftRadius).toBe(surface.borderTopLeftRadius);
    expect(surface.borderBottomRightRadius).toBe(surface.borderTopRightRadius);
    for (const control of frame!.querySelectorAll('button, textarea')) {
      const rect = control.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
      expect(rect.bottom).toBeLessThanOrEqual(height - expectedInset);
    }
    await page.screenshot({
      path: `../../.vitest-screenshots/ios-pwa-${engine}-${width}-${height}.png`,
    });
  },
);

test('keeps Safari/desktop layout unchanged outside standalone mode', async () => {
  await page.viewport(390, 844);
  fixture(false, 844, 0, 0);
  expect(document.documentElement.classList.contains('ios-standalone')).toBe(
    false,
  );
  expect(getComputedStyle(frame!).position).toBe('fixed');
  expect(getComputedStyle(frame!.querySelector('footer')!).paddingBottom).toBe(
    '0px',
  );
  expect(viewportMeta!.content).toContain('viewport-fit=cover');
  const surface = getComputedStyle(
    frame!.querySelector('footer')!.firstElementChild!,
  );
  expect(surface.borderBottomLeftRadius).toBe(surface.borderTopLeftRadius);
  expect(
    getComputedStyle(frame!.querySelector('header')!).backdropFilter,
  ).not.toBe('none');
});

test('does not override native CSS height with a larger JavaScript reading', async () => {
  await page.viewport(390, 844);
  fixture(true, 844, 59, 34);
  // JS viewport readings can disagree with the native layout after resume.
  vi.stubGlobal('innerHeight', 900);
  window.dispatchEvent(new Event('resize'));
  expect(frame!.getBoundingClientRect().height).toBe(844);
  expect(frame!.querySelector('footer')!.getBoundingClientRect().bottom).toBe(
    844,
  );
});

test('does not pin the resting PWA to a toolbar-sized stale JavaScript rectangle', async () => {
  await page.viewport(390, 844);
  vi.stubGlobal('innerHeight', 760);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(
    760,
  );
  fixture(true, 760, 59, 34);
  expect(frame!.getBoundingClientRect().height).toBe(844);
  expect(frame!.querySelector('header')!.getBoundingClientRect().top).toBe(0);
  expect(frame!.querySelector('footer')!.getBoundingClientRect().bottom).toBe(
    844,
  );
});

test('restores full height after keyboard dismissal even when focus stays in the textarea', async () => {
  await page.viewport(390, 844);
  const viewport = fixture(true, 844, 59, 34);
  const input = frame!.querySelector('textarea')!;
  input.focus();
  viewport.height = 420;
  viewport.offsetTop = 180;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.documentElement.classList.contains('keyboard-open')).toBe(
    true,
  );
  expect(frame!.getBoundingClientRect().top).toBe(180);
  expect(frame!.getBoundingClientRect().height).toBe(420);
  expect(getComputedStyle(frame!.querySelector('footer')!).paddingBottom).toBe(
    '8px',
  );
  viewport.height = 844;
  viewport.offsetTop = 0;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.activeElement).toBe(input);
  expect(document.documentElement.classList.contains('keyboard-open')).toBe(
    false,
  );
  expect(frame!.getBoundingClientRect().top).toBe(0);
  expect(frame!.getBoundingClientRect().height).toBe(844);
  expect(getComputedStyle(frame!.querySelector('footer')!).paddingBottom).toBe(
    '16px',
  );
});

test('leaves a small visible gap beneath the rounded composer without moving the header or shrinking the viewport', async () => {
  await page.viewport(390, 844);
  fixture(true, 844, 59, 34);
  const footer = frame!.querySelector('footer')!;
  const card = footer.firstElementChild!;
  expect(frame!.getBoundingClientRect().height).toBe(844);
  expect(frame!.querySelector('header')!.getBoundingClientRect().top).toBe(0);
  expect(footer.getBoundingClientRect().bottom).toBe(844);
  expect(card.getBoundingClientRect().bottom).toBe(828);
  const control = footer.querySelector('button')!;
  expect(control.getBoundingClientRect().bottom).toBeLessThanOrEqual(828);
});

test.each([
  [390, 844],
  [844, 390],
] as const)(
  'lifts the composer by an extra 8px above the software keyboard at %ix%i',
  async (width, height) => {
    await page.viewport(width, height);
    const viewport = fixture(true, height, 0, 0);
    frame!.querySelector('textarea')!.focus();
    // Leave enough space for the real textarea's intrinsic height in landscape.
    viewport.height = height === 390 ? 260 : 420;
    viewport.offsetTop = 30;
    viewport.dispatchEvent(new Event('resize'));
    const footer = frame!.querySelector('footer')!;
    const baseGap = width >= 640 ? 12 : 0;
    expect(getComputedStyle(footer).paddingBottom).toBe(`${baseGap + 8}px`);
    expect(frame!.getBoundingClientRect().top).toBe(30);
    expect(frame!.getBoundingClientRect().height).toBe(viewport.height);
    expect(footer.getBoundingClientRect().bottom).toBe(30 + viewport.height);
    expect(footer.firstElementChild!.getBoundingClientRect().bottom).toBe(
      30 + viewport.height - baseGap - 8,
    );
    await page.screenshot({
      path: `../../.vitest-screenshots/ios-pwa-keyboard-${engine}-${width}-${height}.png`,
    });
  },
);

test('does not add the keyboard lift to Safari tabs', async () => {
  await page.viewport(390, 844);
  const viewport = fixture(false, 844, 0, 0);
  frame!.querySelector('textarea')!.focus();
  viewport.height = 420;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.documentElement.classList.contains('keyboard-open')).toBe(
    true,
  );
  expect(getComputedStyle(frame!.querySelector('footer')!).paddingBottom).toBe(
    '0px',
  );
});

test('does not add the iOS lift to an installed Android app, with or without its keyboard', async () => {
  await page.viewport(390, 844);
  const viewport = fixture(
    true,
    844,
    0,
    0,
    0,
    'Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile',
  );
  const footer = frame!.querySelector('footer')!;
  expect(document.documentElement.classList.contains('ios-standalone')).toBe(
    false,
  );
  expect(getComputedStyle(footer).paddingBottom).toBe('0px');
  expect(viewportMeta!.content).toContain('viewport-fit=cover');
  frame!.querySelector('textarea')!.focus();
  viewport.height = 420;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.documentElement.classList.contains('keyboard-open')).toBe(
    true,
  );
  expect(getComputedStyle(footer).paddingBottom).toBe('0px');
});

test('sizes portalled navigation to the same rectangle and reserves bottom safety only once', async () => {
  await page.viewport(390, 844);
  const viewport = fixture(true, 844, 59, 34);
  const sheet = document.createElement('aside');
  sheet.dataset.slot = 'sheet-content';
  sheet.className = 'mobile-sidebar-sheet';
  document.body.append(sheet);
  try {
    expect(sheet.getBoundingClientRect().height).toBe(844);
    expect(getComputedStyle(sheet).paddingTop).toBe('0px');
    expect(getComputedStyle(sheet).paddingBottom).toBe('0px');
    frame!.querySelector('textarea')!.focus();
    viewport.height = 420;
    viewport.offsetTop = 180;
    viewport.dispatchEvent(new Event('resize'));
    expect(sheet.getBoundingClientRect().top).toBe(180);
    expect(sheet.getBoundingClientRect().height).toBe(420);
  } finally {
    sheet.remove();
  }
});
