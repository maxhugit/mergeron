import type { FastifyReply } from 'fastify';

/** @fastify/static and Nest's SPA fallback both pass a Fastify reply. */
export function setStaticHtmlSecurityHeaders(
  reply: Pick<FastifyReply, 'header'>,
  filePath: string,
): void {
  if (!filePath.endsWith('.html')) return;
  reply.header('Content-Security-Policy', "frame-ancestors 'none'");
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
}
