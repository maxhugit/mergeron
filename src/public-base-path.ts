/** Marker kept in the built index and replaced for each HTML response. */
export const PUBLIC_BASE_PATH_TOKEN = '__CODEX_WEBUI_BASE_PATH__';

/**
 * Normalizes a trusted reverse-proxy prefix for use in an HTML base href.
 * Invalid values fall back to the domain root instead of entering the page.
 */
export function normalizeForwardedPrefix(
  header: string | string[] | undefined,
): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const candidate = raw?.split(',', 1)[0]?.trim();
  if (!candidate || candidate === '/') return '/';
  if (!candidate.startsWith('/') || /["'<>?#\\]/.test(candidate)) return '/';

  const segments = candidate.split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/** Renders the built SPA index for the current public proxy prefix. */
export function renderIndexHtml(
  indexHtml: string,
  basePath: string,
  environment?: string,
): string {
  const html = indexHtml.replaceAll(PUBLIC_BASE_PATH_TOKEN, basePath);
  if (environment !== 'development') return html;
  return html
    .replace(
      'data-mergeron-environment="production"',
      'data-mergeron-environment="development"',
    )
    .replaceAll('favicon.svg', 'mergeron-dev-icon.svg')
    .replaceAll('manifest.webmanifest', 'manifest-dev.webmanifest')
    .replaceAll('pwa-icon-180.png', 'pwa-dev-icon-180.png')
    .replaceAll('content="Mergeron"', 'content="Mergeron Dev"')
    .replace('<title>Mergeron</title>', '<title>Mergeron Dev</title>');
}
