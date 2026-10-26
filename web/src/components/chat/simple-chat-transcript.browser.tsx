import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { createRef } from 'react';
import {
  SimpleChatBubble,
  SimpleChatTranscript,
} from './simple-chat-transcript';
import { MarkdownRenderer } from './markdown-renderer';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(cleanup);

test.each([320, 390, 768, 1280])(
  'keeps the simple conversation vertical with long content at %ipx',
  async (width) => {
    await page.viewport(width, 700);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const scrollRef = createRef<HTMLDivElement>();
    const long = 'very_long_unbroken_content_'.repeat(60);
    render(
      <main className="flex h-dvh min-h-0 min-w-0 overflow-hidden">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <SimpleChatTranscript scrollRef={scrollRef}>
            <SimpleChatBubble role="user">
              <p className="whitespace-pre-wrap">{long}</p>
            </SimpleChatBubble>
            <SimpleChatBubble role="assistant">
              <MarkdownRenderer
                completed
                content={`## Réponse\n\nhttps://example.invalid/${long}\n\n\`${long}\`\n\n| Colonne | Valeur |\n|---|---|\n| Test | ${long} |\n\n\`\`\`\n${long}\n\`\`\``}
              />
            </SimpleChatBubble>
            {Array.from({ length: 30 }, (_, index) => (
              <SimpleChatBubble role="assistant" key={index}>
                <p>Réponse supplémentaire {index}</p>
              </SimpleChatBubble>
            ))}
          </SimpleChatTranscript>
          <footer className="shrink-0 p-3">Saisie fixe</footer>
        </section>
      </main>,
    );
    const scroller = scrollRef.current!;
    expect(getComputedStyle(scroller).overflowX).toBe('hidden');
    expect(getComputedStyle(scroller).overflowY).toBe('auto');
    expect(getComputedStyle(scroller).scrollbarGutter).toBe('stable');
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    scroller.scrollTop = scroller.scrollHeight;
    expect(scroller.scrollTop).toBeGreaterThan(0);
  },
);
