/** Real CSS layout with injected iOS geometry. This is NOT an iOS system/PWA
 * compositor test: the final blur/physical-screen check needs a real iPhone. */
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { installMobileViewportFixes } from './mobile-viewport';
import '@/index.css';

let dispose: (() => void) | undefined;
let frame: HTMLElement | undefined;
let strip: HTMLElement | undefined;
const engine = navigator.userAgent.includes('Chrome') ? 'chromium' : 'webkit';
afterEach(() => {
  dispose?.();
  frame?.remove();
  strip?.remove();
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
) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148',
  );
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
  const root = document.documentElement;
  root.style.setProperty('--app-safe-top', `${top}px`);
  root.style.setProperty('--app-safe-bottom', `${bottom}px`);
  root.style.setProperty('--app-safe-left', `${sides}px`);
  root.style.setProperty('--app-safe-right', `${sides}px`);
  strip = document.createElement('div');
  strip.id = 'app-status-bar';
  strip.setAttribute('aria-hidden', 'true');
  document.body.append(strip);
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
] as const)(
  'fills an installed iOS %ix%i canvas, reserving safe areas once',
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
    expect(header.getBoundingClientRect().top).toBe(top);
    expect(getComputedStyle(header).backdropFilter).toBe('none');
    expect(getComputedStyle(strip!).position).toBe('fixed');
    expect(strip!.getBoundingClientRect().height).toBe(Math.max(1, top));
    const footer = frame!.querySelector('footer')!;
    expect(footer.getBoundingClientRect().bottom).toBe(height);
    const expectedInset = Math.max(width >= 640 ? 12 : 0, bottom);
    expect(parseFloat(getComputedStyle(footer).paddingBottom)).toBe(
      expectedInset,
    );
    for (const control of frame!.querySelectorAll('button, textarea')) {
      const rect = control.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(sides);
      expect(rect.right).toBeLessThanOrEqual(width - sides);
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
  expect(getComputedStyle(strip!).display).toBe('none');
  expect(
    getComputedStyle(frame!.querySelector('header')!).backdropFilter,
  ).not.toBe('none');
});

test('uses measured installed-app height instead of an obsolete CSS viewport size', async () => {
  await page.viewport(390, 844);
  fixture(true, 844, 59, 34);
  // A CSS viewport is not always the current visible rectangle after resume.
  vi.stubGlobal('innerHeight', 900);
  window.dispatchEvent(new Event('resize'));
  expect(frame!.getBoundingClientRect().height).toBe(900);
  expect(frame!.querySelector('footer')!.getBoundingClientRect().bottom).toBe(
    900,
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
  // Override the injected test inset just as the production keyboard rule does.
  document.documentElement.style.removeProperty('--app-safe-bottom');
  expect(document.documentElement.classList.contains('keyboard-open')).toBe(
    true,
  );
  expect(frame!.getBoundingClientRect().top).toBe(180);
  expect(frame!.getBoundingClientRect().height).toBe(420);
  expect(getComputedStyle(frame!.querySelector('footer')!).paddingBottom).toBe(
    '0px',
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
    expect(getComputedStyle(sheet).paddingTop).toBe('59px');
    expect(getComputedStyle(sheet).paddingBottom).toBe('34px');
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
