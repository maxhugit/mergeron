import { afterEach, expect, it, vi } from 'vitest';
import {
  copyFormattedResponse,
  responseClipboardPayload,
} from './formatted-clipboard';

afterEach(() => vi.unstubAllGlobals());

function response() {
  const root = document.createElement('div');
  root.innerHTML =
    '<h2>Titre</h2><p>Un <strong>texte</strong> <em>formaté</em>.</p><ul><li>Premier</li><li>Second</li></ul><table><tbody><tr><td>Cellule</td></tr></tbody></table><div data-copy-exclude>Copier le code</div><pre><code>const x = 1;</code></pre><a href="https://example.com" onclick="alert(1)">Lien</a><a href="javascript:alert(1)">Dangereux</a><svg>icon</svg><button>Copier</button><script>alert(1)</script>';
  return root;
}

it('exports portable formatting without controls, scripts or unsafe links', () => {
  const { html, text } = responseClipboardPayload(response());
  expect(html).toContain('<h2>Titre</h2>');
  expect(html).toContain('<strong>texte</strong>');
  expect(html).toContain('<em>formaté</em>');
  expect(html).toContain('<ul><li>Premier</li><li>Second</li></ul>');
  expect(html).toContain('border-collapse:collapse');
  expect(html).toContain('font-family:monospace');
  expect(html).toContain('href="https://example.com"');
  expect(html).not.toMatch(/onclick|javascript:|<script|<svg|<button|Copier/);
  expect(text).toContain('Premier\nSecond');
  expect(text).toContain('const x = 1;');
});

it('writes HTML and plain text in a single ClipboardItem', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { clipboard: { write } });
  vi.stubGlobal(
    'ClipboardItem',
    class {
      data: Record<string, Blob>;
      constructor(data: Record<string, Blob>) {
        this.data = data;
      }
    },
  );
  await copyFormattedResponse(response());
  const item = write.mock.calls[0][0][0];
  expect(item.data['text/html'].type).toBe('text/html');
  expect(item.data['text/plain'].type).toBe('text/plain');
});

it('uses the copy event as a rich fallback, removes its listener, and reports failure', async () => {
  vi.stubGlobal('isSecureContext', false);
  const data = { setData: vi.fn() };
  const command = vi.fn(() => {
    const event = new Event('copy', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data });
    document.dispatchEvent(event);
    return true;
  });
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: command,
  });
  await copyFormattedResponse(response());
  expect(data.setData.mock.calls.map(([type]) => type)).toEqual([
    'text/html',
    'text/plain',
  ]);
  data.setData.mockClear();
  document.dispatchEvent(new Event('copy'));
  expect(data.setData).not.toHaveBeenCalled();
  command.mockReturnValue(false);
  await expect(copyFormattedResponse(response())).rejects.toThrow(
    'Formatted copy failed',
  );
});
