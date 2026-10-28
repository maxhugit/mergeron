export const CHANNEL = 'mergeron-local-browser-v1';
export function instanceOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw Error('HTTPS_ORIGIN_REQUIRED');
  return url.origin;
}
export function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw Error('HTTPS_REQUIRED');
  return url.origin + url.pathname;
}
export function bounded(value, size = 64000) {
  if (JSON.stringify(value).length > size) throw Error('MESSAGE_TOO_LARGE');
  return value;
}
