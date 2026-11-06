/** The same real message components must preserve formatting on narrow screens. */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { UserMessageBubble } from './user-message-bubble';
import { MarkdownRenderer } from './markdown-renderer';
import { i18nReady } from '@/i18n';
import '@/index.css';
const code = '  première ligne\n    indentation conservée\\n';
const content =
  '\nBonjour **équipe**,\nDeuxième ligne, sans syntaxe spéciale.\n\n\n\n# Plan de travail\n\n3. Vérifier\n4. Corriger\n\n| Article | Montant |\n| :--- | ---: |\n| Intervention | 123,45 |\n\n```\n' +
  code +
  '\n```';
beforeEach(async () => {
  await i18nReady;
});
afterEach(cleanup);
for (const width of [390, 1280])
  test(`preserves line breaks and styles in all message states at ${width}px`, async () => {
    await page.viewport(width, 1100);
    const view = render(
      <main style={{ width: 'min(720px, calc(100vw - 24px))', margin: 12 }}>
        {(['user', 'stream', 'completed'] as const).map((mode) => (
          <section
            key={mode}
            data-mode={mode}
            style={{ marginBottom: 24, border: '1px solid #888', padding: 12 }}
          >
            <h2>{mode}</h2>
            {mode === 'user' ? (
              <UserMessageBubble
                content={content}
                threadCwd={null}
                threadId={null}
              />
            ) : (
              <MarkdownRenderer
                content={content}
                completed={mode === 'completed'}
              />
            )}
          </section>
        ))}
      </main>,
    );
    for (const section of view.container.querySelectorAll('section')) {
      const paragraph = section.querySelector('p')!;
      expect(paragraph.querySelectorAll('br')).toHaveLength(1);
      const lineHeight = parseFloat(getComputedStyle(paragraph).lineHeight);
      expect(paragraph.getBoundingClientRect().height).toBeCloseTo(
        lineHeight * 2,
        0,
      );
      const gap = section.querySelector('[data-message-blank-lines="2"]')!;
      expect(gap.getBoundingClientRect().height).toBeGreaterThan(lineHeight);
      expect(getComputedStyle(section.querySelector('h1')!).fontSize).toBe(
        '20px',
      );
      expect(section.querySelector('ol')!.start).toBe(3);
      expect(
        getComputedStyle(section.querySelectorAll('th')[1]).textAlign,
      ).toBe('right');
      expect(section.querySelector('pre')!.textContent?.trimEnd()).toBe(code);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    // Capture the complete synthetic examples after checking the phone-sized
    // viewport, rather than clipping the completed response below the fold.
    await page.viewport(width, 1900);
    await page.screenshot({
      path: `../../../.vitest-screenshots/message-formatting-${width}.png`,
    });
    await page.viewport(width, 1100);
  });
test('finishing a response does not collapse line breaks or change paragraph geometry', async () => {
  const view = render(
    <MarkdownRenderer content={'Un\nDeux\n\n\n\nTrois'} completed={false} />,
  );
  const before = view.container.innerHTML;
  const height = view.container.getBoundingClientRect().height;
  view.rerender(
    <MarkdownRenderer content={'Un\nDeux\n\n\n\nTrois'} completed />,
  );
  expect(view.container.innerHTML).toBe(before);
  expect(view.container.getBoundingClientRect().height).toBe(height);
});
