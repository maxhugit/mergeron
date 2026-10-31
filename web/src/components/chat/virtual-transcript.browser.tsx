/** Real Chromium/WebKit layout verifies the production virtualizer and scroll owner together. */
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { VirtualTranscript } from './virtual-transcript';
import { RetainedSurface } from '@/components/retained-surface';
import { TranscriptScrollOwner } from '@/lib/transcript-scroll-owner';
import {
  captureReadingAnchor,
  forgetTranscriptBookmarks,
  readTranscriptBookmark,
  readingAnchorDelta,
} from '@/lib/transcript-anchor';
import '@/index.css';
import { i18nReady } from '@/i18n';

// Geometry assertions must start after the translated surface can mount,
// including a cold browser run with asynchronously loaded locale catalogs.
beforeAll(async () => {
  await i18nReady;
});

declare module 'vitest/browser' {
  interface BrowserCommands {
    scrollTranscript: (delta: number) => Promise<void>;
    holdTranscriptPointer: (held: boolean) => Promise<void>;
  }
}

const KEYS = Array.from({ length: 40 }, (_, index) => `turn:${index}`);
const TEXT =
  'The same sentence must remain under the reader while another item arrives. '.repeat(
    5,
  );
let threadSequence = 0;

/** The same retained surface changes visibility, width, and item contents without replacing its scroller. */
export function Fixture({
  id,
  active = true,
  width = 800,
  changes = new Map<number, number>(),
  extra = 0,
  inset = 64,
}: {
  id: string;
  active?: boolean;
  width?: number;
  changes?: Map<number, number>;
  extra?: number;
  inset?: number;
}) {
  return (
    <div
      style={{ width, height: 480, visibility: active ? 'visible' : 'hidden' }}
      inert={!active}
    >
      <VirtualTranscript
        threadId={id}
        keys={KEYS}
        active={active}
        ready
        bottomInset={inset}
        scrollSignal={0}
        renderRow={(index) => (
          <div style={{ minHeight: 180 }}>
            {changes.has(index) && (
              <div
                data-transcript-item={`late:${index}`}
                style={{ height: changes.get(index) }}
              >
                Late child activity
              </div>
            )}
            <div data-transcript-item={`answer:${index}`}>
              <p data-sentence={index}>
                {index}: {TEXT}
              </p>
            </div>
            {index === KEYS.length - 1 && <div style={{ height: extra }} />}
          </div>
        )}
      />
    </div>
  );
}

const scroller = () =>
  document.querySelector<HTMLDivElement>('[data-transcript-scroller]')!;
const distance = () =>
  scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight;
const y = (index: number) =>
  document.querySelector(`[data-sentence="${index}"]`)!.getBoundingClientRect()
    .top - scroller().getBoundingClientRect().top;

/** Allows the browser's native wheel gesture and the virtualizer's scroll-end detection to finish. */
async function finishGesture() {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Snapshot history only after native wheel animation has ended, including on Linux WebKit. */
async function scrollAndFinish(delta: number): Promise<void> {
  const element = scroller();
  let timeout: number | undefined;
  let wheelStarted = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onWheel = () => {
    wheelStarted = true;
  };
  const onScrollEnd = () => {
    if (wheelStarted) finish();
  };
  element.addEventListener('wheel', onWheel);
  element.addEventListener('scrollend', onScrollEnd);
  try {
    await commands.scrollTranscript(delta);
    await Promise.race([
      finished,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error('Native transcript scrolling did not finish')),
          5000,
        );
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('scrollend', onScrollEnd);
  }
  // The adapter also has a scroll-end grace period. Native scrollend can
  // arrive before its isScrolling state clears, so wait for that lifecycle too.
  await finishGesture();
}

/** Positions an actual rendered sentence at the reading line, then records native wheel intent. */
async function readHistory(): Promise<number> {
  await expect.poll(distance).toBeLessThan(2);
  await scrollAndFinish(-1300);
  const viewport = scroller().getBoundingClientRect();
  const sentence = [
    ...document.querySelectorAll<HTMLElement>('[data-sentence]'),
  ].find((node) => node.getBoundingClientRect().top > viewport.top + 25)!;
  const index = Number(sentence.dataset.sentence);
  scroller().scrollTop +=
    sentence.getBoundingClientRect().top - viewport.top - 12;
  await scrollAndFinish(-1);
  return index;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (let i = 1; i <= threadSequence; i++)
    forgetTranscriptBookmarks([`browser:${i}`]);
});

test('a stale scroll-end notification cannot repin an upward native wheel gesture', async () => {
  const id = `browser:${++threadSequence}`;
  await page.viewport(1180, 900);
  const state: { owner?: TranscriptScrollOwner } = {};
  const commit = TranscriptScrollOwner.prototype.commit;
  const commits = vi
    .spyOn(TranscriptScrollOwner.prototype, 'commit')
    .mockImplementation(function (this: TranscriptScrollOwner, ...args) {
      commit.apply(this, args);
      if (this.threadId === id) state.owner = this;
    });
  render(<Fixture id={id} />);
  await expect.poll(distance).toBeLessThan(2);
  await finishGesture();
  await expect.poll(() => state.owner?.virtualizer?.isScrolling).toBe(false);
  const writes = vi.spyOn(
    TranscriptScrollOwner.prototype,
    'programmaticScroll',
  );
  // Reproduce the observed Linux ordering without relying on an OS timer:
  // deliver wheel intent, then the old scroll's end, before any new offset.
  // No geometry is fabricated. Complete the gesture with native input below.
  try {
    expect(state.owner?.following).toBe(true);
    fireEvent.wheel(scroller(), { deltaY: -650 });
    expect(state.owner?.inputInProgress).toBe(true);
    state.owner!.endInput();
    expect(writes).not.toHaveBeenCalled();
    await commands.scrollTranscript(-650);
    await expect.poll(distance).toBeGreaterThan(300);
  } finally {
    commits.mockRestore();
    writes.mockRestore();
  }
});

test.each([
  { label: 'downward', deltaY: 650, ctrlKey: false },
  { label: 'zoom', deltaY: -650, ctrlKey: true },
])(
  '$label wheel input at the tail keeps following new output',
  async ({ deltaY, ctrlKey }) => {
    const id = `browser:${++threadSequence}`;
    const view = render(<Fixture id={id} />);
    await expect.poll(distance).toBeLessThan(2);
    await finishGesture();
    fireEvent.wheel(scroller(), { deltaY, ctrlKey });
    scroller().dispatchEvent(new Event('scrollend'));
    expect(readTranscriptBookmark(id)?.follow).toBe(true);
    view.rerender(<Fixture id={id} extra={700} />);
    await expect.poll(distance).toBeLessThan(2);
  },
);

test('upward wheel input without scrollable history keeps following new output', async () => {
  const id = `browser:${++threadSequence}`;
  const fixture = (height: number) => (
    <div style={{ width: 800, height: 480 }}>
      <VirtualTranscript
        threadId={id}
        keys={['only']}
        active
        ready
        bottomInset={64}
        scrollSignal={0}
        renderRow={() => <div style={{ height }}>Short conversation</div>}
      />
    </div>
  );
  const view = render(fixture(40));
  await expect.poll(distance).toBeLessThan(2);
  await finishGesture();
  expect(scroller().scrollTop).toBe(0);
  fireEvent.wheel(scroller(), { deltaY: -650 });
  scroller().dispatchEvent(new Event('scrollend'));
  expect(readTranscriptBookmark(id)?.follow).toBe(true);
  view.rerender(fixture(900));
  await expect.poll(distance).toBeLessThan(2);
});

test('retains the hidden scroll box and restores a historical sentence after hidden changes', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} />);
  const index = await readHistory();
  const original = scroller();
  const before = y(index);
  view.rerender(<Fixture id={id} active={false} />);
  expect(scroller()).toBe(original);
  expect(scroller().clientHeight).toBe(480);
  view.rerender(
    <Fixture
      id={id}
      active={false}
      changes={new Map([[index, 210]])}
      extra={700}
    />,
  );
  view.rerender(
    <Fixture id={id} changes={new Map([[index, 210]])} extra={700} />,
  );
  await expect.poll(() => Math.abs(y(index) - before)).toBeLessThan(2);
  expect(distance()).toBeGreaterThan(500);
});

test('does not replace measured row heights with zero while a retained view has no layout', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(
    <div style={{ display: 'contents' }}>
      <Fixture id={id} />
    </div>,
  );
  const index = await readHistory();
  const before = y(index);
  view.rerender(
    <div style={{ display: 'none' }}>
      <Fixture id={id} active={false} />
    </div>,
  );
  // ResizeObserver reports zero boxes while React retains this DOM subtree.
  // Wait for actual frames, rather than assuming the hide/reveal is synchronous.
  await finishGesture();
  expect(scroller().clientHeight).toBe(0);
  view.rerender(
    <div style={{ display: 'contents' }}>
      <Fixture id={id} extra={700} />
    </div>,
  );
  await expect.poll(() => Math.abs(y(index) - before)).toBeLessThan(2);
  await finishGesture();
  expect(Math.abs(y(index) - before)).toBeLessThan(2);
  expect(distance()).toBeGreaterThan(500);
});

test('snapshots the visible reading point when Activity hides during a gesture after row resizing', async () => {
  const id = `browser:${++threadSequence}`;
  const fixture = (active: boolean, extra = 0) => (
    <RetainedSurface active={active}>
      <Fixture id={id} active={active} extra={extra} />
    </RetainedSurface>
  );
  const view = render(fixture(true));
  const index = await readHistory();
  const original = scroller();
  await commands.holdTranscriptPointer(true);
  // Like estimate-to-measured rows arriving during Linux WebKit's animation:
  // resize an actual row above the reading point, while corrections are paused.
  const late = document.createElement('div');
  late.style.height = '144px';
  document
    .querySelector(`[data-transcript-item="answer:${index - 1}"]`)!
    .before(late);
  await finishGesture();
  const before = y(index);
  const heldBookmark = readTranscriptBookmark(id);
  expect(heldBookmark?.anchor).not.toBeNull();
  expect(
    Math.abs(readingAnchorDelta(original, heldBookmark!.anchor!)!),
  ).toBeGreaterThan(2);
  const visibleAnchor = captureReadingAnchor(original);
  view.rerender(fixture(false));
  expect(readTranscriptBookmark(id)?.anchor).toEqual(visibleAnchor);
  await commands.holdTranscriptPointer(false);
  await finishGesture();
  view.rerender(fixture(false, 700));
  view.rerender(fixture(true, 700));
  expect(scroller()).toBe(original);
  await expect.poll(() => Math.abs(y(index) - before)).toBeLessThan(2);
  await finishGesture();
  expect(Math.abs(y(index) - before)).toBeLessThan(2);
  expect(distance()).toBeGreaterThan(500);
});

test('corrects only the residual when several measured rows change in the same commit', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} />);
  const index = await readHistory();
  const before = y(index);
  await act(async () =>
    view.rerender(
      <Fixture
        id={id}
        changes={
          new Map([
            [index - 1, 150],
            [index, 230],
            [index + 1, 190],
          ])
        }
      />,
    ),
  );
  await expect.poll(() => Math.abs(y(index) - before)).toBeLessThan(2);
  await finishGesture();
  expect(Math.abs(y(index) - before)).toBeLessThan(2);
});

test('preserves follow intent while hidden and reconciles width before revealing', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} />);
  await expect.poll(distance).toBeLessThan(2);
  view.rerender(<Fixture id={id} active={false} width={430} extra={1200} />);
  await finishGesture();
  view.rerender(<Fixture id={id} width={430} extra={1200} />);
  await expect.poll(distance).toBeLessThan(2);
});

test('late content during native scrolling does not install a chasing scroll target', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} />);
  const index = await readHistory();
  await commands.scrollTranscript(-180);
  view.rerender(
    <Fixture id={id} changes={new Map([[index, 300]])} extra={400} />,
  );
  await commands.scrollTranscript(-220);
  await finishGesture();
  const position = scroller().scrollTop;
  view.rerender(
    <Fixture id={id} changes={new Map([[index, 300]])} extra={900} />,
  );
  await finishGesture();
  expect(distance()).toBeGreaterThan(700);
  expect(Math.abs(scroller().scrollTop - position)).toBeLessThan(2);
});

test('a small upward gesture leaves follow intent even inside the former 80px threshold', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} />);
  await expect.poll(distance).toBeLessThan(2);
  await commands.scrollTranscript(-24);
  await finishGesture();
  expect(distance()).toBeGreaterThan(10);
  const before = scroller().scrollTop;
  view.rerender(<Fixture id={id} extra={300} />);
  await finishGesture();
  expect(Math.abs(scroller().scrollTop - before)).toBeLessThan(2);
});

test('shrinking composer padding cannot turn a history reader into a follower through clamping', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} inset={340} />);
  await expect.poll(distance).toBeLessThan(2);
  await commands.scrollTranscript(-24);
  await finishGesture();
  expect(distance()).toBeGreaterThan(10);
  view.rerender(<Fixture id={id} inset={64} />);
  await finishGesture();
  view.rerender(<Fixture id={id} inset={64} extra={400} />);
  await finishGesture();
  expect(distance()).toBeGreaterThan(300);
});

test('browser navigation without wheel or pointer input is not undone by later output', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} />);
  await expect.poll(distance).toBeLessThan(2);
  // scrollIntoView is also what browser focus/search navigation performs; no
  // synthetic wheel event or fabricated layout is involved in this test.
  const viewport = scroller().getBoundingClientRect();
  const target = [
    ...document.querySelectorAll<HTMLElement>('[data-transcript-row]'),
  ].find((row) => row.getBoundingClientRect().bottom < viewport.top)!;
  target.scrollIntoView({ block: 'start' });
  await finishGesture();
  expect(distance()).toBeGreaterThan(200);
  const before = scroller().scrollTop;
  view.rerender(<Fixture id={id} extra={500} />);
  await finishGesture();
  expect(Math.abs(scroller().scrollTop - before)).toBeLessThan(2);
});

test('a browser row resize during input cannot leave a stale correction armed after release', async () => {
  const id = `browser:${++threadSequence}`;
  render(<Fixture id={id} />);
  const index = await readHistory();
  const changing = document.querySelector<HTMLElement>(
    `[data-transcript-row="turn:${index}"]`,
  )!;
  const preceding = document.querySelector<HTMLElement>(
    `[data-transcript-row="turn:${index - 2}"]`,
  )!;
  await commands.holdTranscriptPointer(true);
  try {
    const height = changing.getBoundingClientRect().height;
    changing.style.minHeight = `${height + 120}px`;
    await finishGesture();
    // A held gesture can continue scrolling after that resize; the next
    // geometry batch must preserve this newer point, not the earlier one.
    scroller().scrollTop -= 40;
    await finishGesture();
  } finally {
    await commands.holdTranscriptPointer(false);
  }
  await finishGesture();
  const before = y(index);
  preceding.style.minHeight = `${preceding.getBoundingClientRect().height + 90}px`;
  await expect.poll(() => Math.abs(y(index) - before)).toBeLessThan(2);
});

test('large native scrolling mounts the new range while remaining in history', async () => {
  const id = `browser:${++threadSequence}`;
  render(<Fixture id={id} />);
  await expect.poll(distance).toBeLessThan(2);
  await commands.scrollTranscript(-3500);
  // wheel() only dispatches input; WebKit on Linux can still be animating a
  // large gesture after the short scroll-end grace used by the other cases.
  // Keep the full-distance requirement and wait for the real browser to reach it.
  await expect.poll(distance).toBeGreaterThan(3000);
  await finishGesture();
  expect(distance()).toBeGreaterThan(3000);
  const viewport = scroller().getBoundingClientRect();
  expect(
    document
      .elementFromPoint(viewport.left + 20, viewport.top + 200)
      ?.closest('[data-transcript-row]'),
  ).not.toBeNull();
});

test('a large browser-animated scroll is not interrupted by row measurement', async () => {
  const id = `browser:${++threadSequence}`;
  render(<Fixture id={id} />);
  await expect.poll(distance).toBeLessThan(2);
  await finishGesture();
  // Linux WebKit animates wheel input. Explicit native smooth scrolling also
  // exercises that path on platforms whose wheel input moves immediately.
  scroller().focus({ preventScroll: true });
  scroller().scrollBy({ top: -3500, behavior: 'smooth' });
  await expect.poll(distance, { timeout: 3000 }).toBeGreaterThan(3000);
  await finishGesture();
  expect(distance()).toBeGreaterThan(3000);
  const viewport = scroller().getBoundingClientRect();
  expect(
    document
      .elementFromPoint(viewport.left + 20, viewport.top + 200)
      ?.closest('[data-transcript-row]'),
  ).not.toBeNull();
});

test('a browser-only width resize preserves a historical reading point', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} />);
  const index = await readHistory();
  const before = y(index);
  (view.container.firstElementChild as HTMLElement).style.width = '430px';
  await finishGesture();
  expect(scroller().clientWidth).toBeLessThan(500);
  expect(Math.abs(y(index) - before)).toBeLessThan(2);
});

test('a delayed image starts a new correction after a width change has settled', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} />);
  const index = await readHistory();
  const before = y(index);
  (view.container.firstElementChild as HTMLElement).style.width = '430px';
  await finishGesture();
  expect(Math.abs(y(index) - before)).toBeLessThan(2);
  // Actual image layout after the earlier resize batch, with no React commit
  // and no network/file access. ResizeObserver must schedule the new batch.
  const image = new Image();
  image.width = 100;
  image.style.display = 'block';
  document
    .querySelector(`[data-transcript-item="answer:${index}"]`)!
    .before(image);
  image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="220"></svg>')}`;
  await image.decode();
  await finishGesture();
  expect(Math.abs(y(index) - before)).toBeLessThan(2);
});

test('browser navigation while reading history cancels a pending correction before its scroll event', async () => {
  const id = `browser:${++threadSequence}`;
  const view = render(<Fixture id={id} />);
  const index = await readHistory();
  // Create a geometry batch, then navigate synchronously before native scroll
  // dispatch. The history path needs the same input attribution as following.
  view.rerender(<Fixture id={id} changes={new Map([[index, 120]])} />);
  const target = document.querySelector<HTMLElement>(
    `[data-sentence="${index - 2}"]`,
  )!;
  target.scrollIntoView({ block: 'start' });
  const before = y(index - 2);
  view.rerender(
    <Fixture id={id} changes={new Map([[index, 120]])} extra={200} />,
  );
  await finishGesture();
  // The navigated sentence, not `scrollTop`, is what must hold: rows entering
  // the range above it measure taller than their estimate, and keeping the
  // reader's text still is exactly what makes the offset move (measured: the
  // extent grew 248px and the owner absorbed 96px of it above this point).
  // Undoing the navigation would instead put the former anchor back at the
  // reading line and carry this sentence off the top.
  await expect.poll(() => Math.abs(y(index - 2) - before)).toBeLessThan(2);
});

test('rows fill the surface rather than a centred column, and dissolve under the composer band', async () => {
  const id = `browser:${++threadSequence}`;
  // Wider than the 896px cap the tab redesign introduced, so a surviving cap
  // would leave the column narrower than its scroller instead of filling it.
  render(<Fixture id={id} width={1400} inset={140} />);
  await finishGesture();

  const column = document.querySelector<HTMLElement>(
    '[data-transcript-column]',
  )!;
  expect(column.getBoundingClientRect().width).toBeCloseTo(
    // Linux reserves a classic scrollbar gutter; rows must fill the usable
    // content box, not paint beneath that gutter. macOS overlays its scrollbar.
    scroller().clientWidth,
    0,
  );

  // The composer floats over the transcript and is inset from the scroller, so
  // rows have to be gone before they reach it rather than cut against its edge.
  // Asserting the mask geometry, not a screenshot: the ramp must start exactly
  // at the reserved band so a transcript resting at the end is never faded.
  const mask = getComputedStyle(scroller()).maskImage;
  expect(mask).toContain('140px');
  expect(mask).not.toBe('none');
});
