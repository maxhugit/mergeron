import {
  normalizeForwardedPrefix,
  PUBLIC_BASE_PATH_TOKEN,
  renderIndexHtml,
} from './public-base-path';

describe('public base path', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['/', '/'],
    ['/codex', '/codex/'],
    ['/codex/', '/codex/'],
    ['//tools///codex//', '/tools/codex/'],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeForwardedPrefix(input)).toBe(expected);
  });

  it.each(['codex', '/codex?<script>', '/codex#fragment', '/codex\\path'])(
    'rejects unsafe value %p',
    (input) => {
      expect(normalizeForwardedPrefix(input)).toBe('/');
    },
  );

  it('replaces the runtime marker', () => {
    expect(
      renderIndexHtml(`<base href="${PUBLIC_BASE_PATH_TOKEN}">`, '/codex/'),
    ).toBe('<base href="/codex/">');
  });

  it('selects dev identity only for an explicitly declared development environment', () => {
    const html =
      '<html data-mergeron-environment="production"><base href="' +
      PUBLIC_BASE_PATH_TOKEN +
      '"><link href="./favicon.svg"><link href="./manifest.webmanifest"><link href="./pwa-icon-180.png"><meta name="application-name" content="Mergeron"><title>Mergeron</title></html>';
    const dev = renderIndexHtml(html, '/tools/', 'development');
    expect(dev).toContain('data-mergeron-environment="development"');
    expect(dev).toContain('href="/tools/"');
    expect(dev).toContain('./mergeron-dev-icon.svg');
    expect(dev).toContain('./manifest-dev.webmanifest');
    expect(dev).toContain('./pwa-dev-icon-180.png');
    expect(dev).toContain('<title>Mergeron Dev</title>');
    for (const environment of [undefined, 'production', 'edge', '<script>']) {
      expect(renderIndexHtml(html, '/', environment)).toBe(
        html.replace(PUBLIC_BASE_PATH_TOKEN, '/'),
      );
    }
  });
});
