import type { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';

/** Guard Nest's HTML fallback before any missing hashed asset can become HTML. */
export function rejectMissingBuildAsset(
  url: string,
  reply: FastifyReply,
  payload: unknown,
): string | undefined {
  if (
    !/^\/assets\//.test(url.split('?')[0]) ||
    !String(reply.getHeader('content-type') ?? '').startsWith('text/html')
  )
    return;
  if (payload instanceof Readable) payload.destroy();
  reply.removeHeader('content-length');
  reply.code(404).type('application/json').header('Cache-Control', 'no-store');
  return JSON.stringify({
    statusCode: 404,
    message: 'Build asset not found. Reload the application.',
  });
}

/** @fastify/static and Nest's SPA fallback both pass a Fastify reply. */
export function setStaticHtmlSecurityHeaders(
  reply: Pick<FastifyReply, 'header'>,
  filePath: string,
): void {
  if (filePath.endsWith('sw.js')) reply.header('Cache-Control', 'no-store');
  if (!filePath.endsWith('.html')) return;
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Security-Policy', "frame-ancestors 'none'");
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
}
