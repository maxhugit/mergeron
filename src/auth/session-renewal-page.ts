import { randomBytes } from 'node:crypto';
/** Structural response contract keeps the synthetic frontend fixture independent
 * of backend packages, including during frontend-only TypeScript builds. */
export interface RenewalPageReply {
  header(name: string, value: string): RenewalPageReply;
  type(value: string): RenewalPageReply;
  send(value: string): unknown;
}

export function renewalRequest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value))
    throw new TypeError('Invalid renewal request');
  return value;
}

/** A hint only: contains no identity or credential and never grants access. */
export function sendRenewalPage(
  reply: RenewalPageReply,
  request: string,
  status: 'complete' | 'interactive' | 'unavailable',
): void {
  const nonce = randomBytes(24).toString('base64');
  reply
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Frame-Options', 'SAMEORIGIN')
    .header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
    )
    .type('text/html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Session</title><script nonce="${nonce}">window.parent.postMessage(${JSON.stringify({ type: 'mergeron:silent-renewal', request: renewalRequest(request), status })},window.location.origin)</script>`,
    );
}
