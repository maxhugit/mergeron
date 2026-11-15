/** Optional Next.js development server for observable HMR; no production or standalone mode. */
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import state from './preview-next-state.cjs';
export async function startNextPreview({
  directory = process.cwd(),
  port = Number(process.env.PORT ?? 3000),
  hostname = '0.0.0.0',
} = {}) {
  if (process.env.NODE_ENV !== 'development')
    throw Error('PREVIEW_NEXT_REQUIRES_DEVELOPMENT');
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error('PREVIEW_NEXT_INVALID_PORT');
  const scratch = await mkdtemp(path.join(tmpdir(), 'mergeron-next-'));
  const statusPath = path.join(scratch, 'status.json');
  process.env.MERGERON_NEXT_DIAGNOSTICS_STATE_PATH = statusPath;
  const require = createRequire(path.join(directory, 'package.json'));
  const next = require('next');
  const sockets = new Map();
  let handler = (_req, res) => {
    res.writeHead(503);
    res.end();
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://preview.invalid');
    if (url.pathname !== '/__mergeron_hmr/status') return handler(req, res);
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end();
    }
    const status = state.readJson(statusPath);
    const socket = sockets.get(url.searchParams.get('probe'));
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(
      JSON.stringify({
        generation: state.UUID.test(status?.generation)
          ? status.generation
          : null,
        watching: status?.watching === true,
        phase:
          status?.phase === 'error'
            ? 'error'
            : status?.phase === 'updating'
              ? 'updating'
              : 'idle',
        hash:
          typeof status?.hash === 'string' &&
          /^[a-f0-9]{16,64}$/.test(status.hash)
            ? status.hash
            : null,
        viaPreview: socket?.viaPreview === true && !socket.socket.destroyed,
      }),
    );
  });
  const application = next({
    dev: true,
    dir: directory,
    hostname,
    port,
    httpServer: server,
    webpack: true,
  });
  await application.prepare();
  handler = application.getRequestHandler();
  server.prependListener('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://preview.invalid');
    const nonce = url.searchParams.get('mergeronProbe');
    if (
      !/\/_next\/(?:webpack-hmr|hmr)$/.test(url.pathname) ||
      !state.UUID.test(nonce) ||
      sockets.size >= 128
    )
      return;
    sockets.set(nonce, {
      socket,
      viaPreview: Boolean(req.headers['x-mergeron-preview-transport']),
    });
    socket.once('close', () => {
      if (sockets.get(nonce)?.socket === socket) sockets.delete(nonce);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolve);
  });
  return {
    port: server.address().port,
    async close() {
      for (const { socket } of sockets.values()) socket.destroy();
      await application.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = await startNextPreview();
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      const timer = setTimeout(() => process.exit(1), 5000);
      timer.unref();
      void server.close().then(() => process.exit(0));
    });
}
