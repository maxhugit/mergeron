import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';

export function renewalRequest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value))
    throw new TypeError('Invalid renewal request');
  return value;
}

/** A hint only: contains no identity or credential and never grants access. */
export function sendRenewalPage(
  reply: FastifyReply,
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
