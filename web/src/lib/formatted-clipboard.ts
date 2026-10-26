/** Export only portable document markup, never application controls or handlers. */
export function responseClipboardPayload(element: HTMLElement) {
  const allowed = new Set(
    'p br h1 h2 h3 h4 h5 h6 strong b em i s del blockquote ul ol li pre code table thead tbody tr th td hr a span div'.split(
      ' ',
    ),
  );
  const styles: Record<string, string> = {
    table: 'border-collapse:collapse',
    th: 'border:1px solid #999;padding:6px;text-align:left;font-weight:bold',
    td: 'border:1px solid #999;padding:6px',
    pre: 'white-space:pre-wrap;font-family:monospace;background:#f4f4f4;padding:12px;color:#222',
    code: 'font-family:monospace',
    blockquote: 'border-left:3px solid #999;padding-left:12px',
  };
  const clean = (node: Node): Node => {
    if (node.nodeType === Node.TEXT_NODE)
      return document.createTextNode(node.textContent ?? '');
    const fragment = document.createDocumentFragment();
    if (!(node instanceof HTMLElement)) return fragment;
    const tag = node.tagName.toLowerCase();
    if (
      node.hasAttribute('data-copy-exclude') ||
      ['button', 'script', 'style', 'input', 'textarea', 'iframe'].includes(tag)
    )
      return fragment;
    const target = allowed.has(tag) ? document.createElement(tag) : fragment;
    if (target instanceof HTMLElement) {
      if (styles[tag]) target.setAttribute('style', styles[tag]);
      if (tag === 'a') {
        const href = node.getAttribute('href') ?? '';
        if (/^(https?:|mailto:)/i.test(href)) target.setAttribute('href', href);
      }
      if (tag === 'ol' && /^\d+$/.test(node.getAttribute('start') ?? ''))
        target.setAttribute('start', node.getAttribute('start')!);
    }
    for (const child of node.childNodes) target.appendChild(clean(child));
    return target;
  };
  const output = document.createElement('div');
  output.appendChild(clean(element));
  const plain = output.cloneNode(true) as HTMLElement;
  plain
    .querySelectorAll('td,th')
    .forEach((node) => node.appendChild(document.createTextNode('\t')));
  plain
    .querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,tr,pre,blockquote,br')
    .forEach((node) => node.appendChild(document.createTextNode('\n')));
  return { html: output.innerHTML, text: plain.textContent?.trim() ?? '' };
}

/** Rich and plain representations are written together for the paste destination. */
export async function copyFormattedResponse(
  element: HTMLElement,
): Promise<void> {
  const { html, text } = responseClipboardPayload(element);
  if (
    window.isSecureContext &&
    navigator.clipboard?.write &&
    typeof ClipboardItem !== 'undefined'
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return;
    } catch {
      // Older browsers / denied Clipboard API: try the synchronous copy event.
    }
  }
  let handled = false;
  const listener = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/html', html);
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    handled = true;
  };
  document.addEventListener('copy', listener);
  try {
    if (!document.execCommand('copy') || !handled)
      throw new Error('Formatted copy failed');
  } finally {
    document.removeEventListener('copy', listener);
  }
}
