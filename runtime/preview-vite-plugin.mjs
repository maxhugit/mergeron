/** Optional application integration. Copy into a Vite project; no runtime dependency. */
import {
  openSync,
  readFileSync,
  fstatSync,
  closeSync,
  watch,
  constants,
} from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Serialized into a Vite module, never executed in the Manager or backend.
function browserDiagnostics(hot, statusPath) {
  if (!hot) return;
  const pending = new Map();
  let connected = true;
  hot.on('vite:ws:connect', () => {
    connected = true;
  });
  hot.on('vite:ws:disconnect', () => {
    connected = false;
  });
  let updates = 0,
    phase = 'idle',
    appliedAt = null;
  hot.on('mergeron-preview:ack', (data) => {
    const done = pending.get(data?.id);
    if (done) {
      pending.delete(data.id);
      done(data);
    }
  });
  const probe = () =>
    new Promise((resolve) => {
      if (!connected) return resolve(null);
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, 1800);
      pending.set(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      try {
        Promise.resolve(hot.send('mergeron-preview:probe', { id })).catch(
          () => {
            clearTimeout(timer);
            pending.delete(id);
            resolve(null);
          },
        );
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    });
  hot.on('vite:beforeUpdate', () => {
    phase = 'updating';
  });
  hot.on('vite:error', () => {
    phase = 'error';
  });
  hot.on('vite:beforeFullReload', () => {
    phase = 'reloading';
  });
  hot.on('vite:afterUpdate', () => {
    phase = 'applied';
    updates++;
    appliedAt = Date.now();
  });
  let busy = false;
  const onMessage = async (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== parent ||
      parent === window ||
      event.data?.type !== 'mergeron-preview:inspect' ||
      typeof event.data.id !== 'string' ||
      event.data.id.length > 64 ||
      busy
    )
      return;
    busy = true;
    try {
      const [server, socket] = await Promise.all([
        fetch(statusPath, {
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          signal: AbortSignal.timeout(2000),
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        probe(),
      ]);
      parent.postMessage(
        {
          type: 'mergeron-preview:observation',
          id: event.data.id,
          observation: {
            adapter: 'vite',
            detectedGeneration: server?.generation ?? null,
            watching: server?.watching === true,
            socketGeneration: socket?.generation ?? null,
            websocket: socket
              ? socket.viaPreview
                ? 'connected'
                : 'bypassed'
              : 'unavailable',
            phase,
            updates,
            appliedAt,
          },
        },
        location.origin,
      );
    } finally {
      busy = false;
    }
  };
  addEventListener('message', onMessage);
  hot.dispose(() => {
    removeEventListener('message', onMessage);
    for (const done of pending.values()) done(null);
    pending.clear();
  });
}

export function mergeronPreview({
  receiptPath = process.env.MERGERON_PREVIEW_RECEIPT_PATH,
} = {}) {
  if (!receiptPath) return false;
  const receiptFile = resolve(receiptPath);
  let generation = null,
    watching = false,
    base = '/',
    watcher;
  const viaPreview = new WeakMap();
  function readReceipt() {
    let fd;
    try {
      fd = openSync(receiptFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 16384) throw Error();
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      generation =
        value.schemaVersion === 1 && UUID.test(value.generation)
          ? value.generation
          : null;
    } catch {
      generation = null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return {
    name: 'mergeron-preview-diagnostics',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      readReceipt();
      // Watch the directory: the Manager replaces the receipt atomically.
      // Request handlers read only this observation, never stamp the latest file.
      try {
        watcher = watch(
          dirname(receiptFile),
          { persistent: false },
          (_event, name) => {
            if (name?.toString() === basename(receiptFile)) readReceipt();
          },
        );
        watching = true;
        watcher.on('error', () => {
          watching = false;
          generation = null;
        });
      } catch {
        watching = false;
      }
      const connection = (socket, request) => {
        viaPreview.set(
          socket,
          Boolean(request.headers['x-mergeron-preview-transport']),
        );
      };
      const probe = (data, client) => {
        if (!data || typeof data.id !== 'string' || data.id.length > 64) return;
        client.send('mergeron-preview:ack', {
          id: data.id,
          generation,
          viaPreview: viaPreview.get(client.socket) === true,
        });
      };
      server.ws.on('connection', connection);
      server.ws.on('mergeron-preview:probe', probe);
      server.middlewares.use((req, res, next) => {
        if (req.url !== base + '__mergeron_hmr/status') return next();
        if (req.method !== 'GET') {
          res.statusCode = 405;
          return res.end();
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        res.end(JSON.stringify({ schemaVersion: 1, generation, watching }));
      });
      server.httpServer?.once('close', () => {
        watcher?.close();
        server.ws.off('connection', connection);
        server.ws.off('mergeron-preview:probe', probe);
      });
    },
    resolveId(id) {
      if (id.endsWith('/@mergeron-preview-diagnostics.js'))
        return '\0mergeron-preview-diagnostics';
    },
    load(id) {
      if (id === '\0mergeron-preview-diagnostics')
        return `(${browserDiagnostics.toString()})(import.meta.hot, ${JSON.stringify(base + '__mergeron_hmr/status')});`;
    },
    transform(code, id) {
      // Plain CSS only. CSS modules, preprocessors and inline styles are not
      // asserted as compiled by this small adapter.
      if (
        !generation ||
        !/\.css(?:\?|$)/.test(id) ||
        /\.module\.css(?:\?|$)/.test(id)
      )
        return;
      return {
        code: code + `\n:root{--mergeron-preview-generation:"${generation}"}\n`,
        map: null,
      };
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          ...(generation
            ? [
                {
                  tag: 'meta',
                  attrs: {
                    name: 'mergeron-preview-generation',
                    content: generation,
                  },
                  injectTo: 'head-prepend',
                },
              ]
            : []),
          {
            tag: 'script',
            attrs: {
              type: 'module',
              src: base + '@mergeron-preview-diagnostics.js',
            },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}
