/** Synthetic SSO on two loopback origins. No accounts, external network, or real sessions. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { FastifyReply } from 'fastify';
import { sendRenewalPage } from '../../src/auth/session-renewal-page';

export function createSilentRenewalFixture() {
  const origins = new Set<string>();
  const provider = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = url.searchParams.get('returnOrigin') ?? '';
    const request = url.searchParams.get('request') ?? '';
    if (!origins.has(origin) || !/^[a-f0-9]{32}$/.test(request)) {
      res.writeHead(400);
      res.end();
      return;
    }
    if (url.searchParams.get('scenario') === 'blocked') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "frame-ancestors 'none'",
      });
      res.end('<!doctype html><title>Interactive sign-in</title>');
      return;
    }
    const back = new URL('/__silent_renewal/complete', origin);
    back.searchParams.set('request', request);
    back.searchParams.set(
      'scenario',
      url.searchParams.get('scenario') ?? 'interactive',
    );
    res.writeHead(302, { Location: back.href, 'Cache-Control': 'no-store' });
    res.end();
  });
  let portPromise: Promise<number> | undefined;
  const port = () =>
    (portPromise ??= new Promise<number>((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', () =>
        resolve((provider.address() as { port: number }).port),
      );
    }));
  return {
    dispose: () =>
      new Promise<void>((resolve) => {
        provider.close(() => resolve());
        provider.closeAllConnections();
      }),
    async middleware(
      req: IncomingMessage,
      res: ServerResponse,
      next: () => void,
    ) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/__silent_renewal/')) return next();
      const request = url.searchParams.get('request') ?? '';
      if (!/^[a-f0-9]{32}$/.test(request)) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/__silent_renewal/start') {
        const scenario = req.headers.cookie?.includes(
          'silent_renewal_fixture=interactive',
        )
          ? 'interactive'
          : req.headers.cookie?.includes('silent_renewal_fixture=blocked')
            ? 'blocked'
            : 'complete';
        origins.add(url.origin);
        const provider = new URL(`http://127.0.0.1:${await port()}/authorize`);
        provider.searchParams.set('request', request);
        provider.searchParams.set('returnOrigin', url.origin);
        provider.searchParams.set('scenario', scenario);
        res.writeHead(302, { Location: provider.href });
        res.end();
        return;
      }
      const status =
        url.searchParams.get('scenario') === 'complete'
          ? 'complete'
          : 'interactive';
      const reply = {
        header(name: string, value: string) {
          res.setHeader(name, value);
          return reply;
        },
        type(value: string) {
          res.setHeader('Content-Type', value);
          return reply;
        },
        send(value: string) {
          res.end(value);
        },
      };
      sendRenewalPage(reply as unknown as FastifyReply, request, status);
    },
  };
}
