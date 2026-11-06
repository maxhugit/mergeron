import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UserMessageBubble } from './user-message-bubble';
import { MarkdownRenderer } from './markdown-renderer';
import { responseClipboardPayload } from '@/lib/formatted-clipboard';
import { normalizeThreadItem } from '@/lib/thread-item-normalizer';
import { OPEN_FILE_EVENT } from '@/lib/open-file-request';
afterEach(cleanup);

for (const mode of ['user', 'stream', 'completed'] as const) {
  const show = (content: string) =>
    render(
      mode === 'user' ? (
        <UserMessageBubble
          content={content}
          threadCwd="/work"
          threadId="agent"
        />
      ) : (
        <MarkdownRenderer content={content} completed={mode === 'completed'} />
      ),
    );
  it.each(['\n', '\r\n', '\r'])(
    `${mode}: preserves real %j line endings and a literal backslash-n`,
    (ending) => {
      const view = show(`Ligne A${ending}Ligne B avec \\n littéral`);
      expect(view.container.querySelectorAll('br')).toHaveLength(1);
      expect(view.container.textContent).toContain('\\n littéral');
      const copy = responseClipboardPayload(view.container);
      expect(copy.text).toBe('Ligne A\nLigne B avec \\n littéral');
      expect(copy.html).toContain('<br>');
    },
  );
  it(`${mode}: preserves extra blank lines and existing Markdown hard breaks`, () => {
    const view = show('\n\nAvant  \naprès\n\n\n\nDernier\n');
    expect(
      Array.from(
        view.container.querySelectorAll('[data-message-blank-lines]'),
      ).map((n) => n.getAttribute('data-message-blank-lines')),
    ).toEqual(['2', '2', '1']);
    expect(view.container.querySelectorAll('p')).toHaveLength(2);
    expect(
      view.container.querySelector('p')?.querySelectorAll('br'),
    ).toHaveLength(1);
    expect(responseClipboardPayload(view.container).text).toBe(
      'Avant\naprès\n\n\n\nDernier',
    );
  });
  it(`${mode}: keeps list starts, headings and table alignment`, () => {
    const view = show(
      '# Titre\n\n3. Trois\n4. Quatre\n\n| Gauche | Centre | Droite |\n| :--- | :---: | ---: |\n| a | b | c |',
    );
    expect(view.container.querySelector('ol')?.start).toBe(3);
    expect(view.container.querySelector('h1')?.className).toContain(
      'font-bold',
    );
    expect(
      Array.from(view.container.querySelectorAll('th')).map(
        (n) => n.style.textAlign,
      ),
    ).toEqual(['left', 'center', 'right']);
    expect(responseClipboardPayload(view.container).html).toContain(
      'text-align: right',
    );
    expect(responseClipboardPayload(view.container).html).toContain(
      'start="3"',
    );
  });
  it(`${mode}: leaves code indentation, literal escapes and unsafe HTML inert`, () => {
    const source = '  Ligne A\n    Ligne B\\n';
    const view = show(
      '```\n' +
        source +
        '\n```\n\n<script>alert(1)</script>\n\n[x](javascript:alert)',
    );
    expect(view.container.querySelector('pre')?.textContent?.trimEnd()).toBe(
      source,
    );
    expect(view.container.querySelector('script')).toBeNull();
    expect(
      view.container.querySelector('a')?.getAttribute('href') ?? '',
    ).not.toContain('javascript:');
    expect(responseClipboardPayload(view.container).text).toContain(source);
  });
}
it('keeps whitespace in history normalization and renders the same user request after reload', () => {
  const text = '\n\nBonjour\nDeuxième ligne\n\n';
  const item = normalizeThreadItem(
    { type: 'userMessage', id: 'm', content: [{ type: 'text', text }] },
    true,
  );
  expect(item.kind).toBe('userMessage');
  if (item.kind !== 'userMessage') throw new Error('Missing message');
  expect(item.message.text).toBe(text);
  const view = render(
    <UserMessageBubble
      content={item.message.text}
      threadCwd={null}
      threadId={null}
    />,
  );
  expect(view.container.querySelectorAll('p br')).toHaveLength(1);
  expect(
    view.container.querySelectorAll('[data-message-blank-lines]'),
  ).toHaveLength(2);
});
it('keeps mentions and their file action across line breaks', () => {
  const listener = vi.fn();
  const view = render(
    <UserMessageBubble
      content={'Consulter\n@notes.md\nPuis répondre'}
      threadCwd="/work"
      threadId="agent"
    />,
  );
  expect(view.container.querySelectorAll('br')).toHaveLength(2);
  const mention = view.getByRole('button', { name: '@notes.md' });
  window.addEventListener(OPEN_FILE_EVENT, listener);
  try {
    fireEvent.click(mention);
    expect(listener.mock.calls[0][0].detail).toEqual({
      path: '/work/notes.md',
      sourceThreadId: 'agent',
    });
  } finally {
    window.removeEventListener(OPEN_FILE_EVENT, listener);
  }
});
