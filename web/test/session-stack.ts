/** Test-only loopback stack. Real HTTP/listener outages, synthetic identity, no external destinations. */
import http, {
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';

type Fault = 'backend' | 'auth' | 'proxy' | 'expired' | 'forbidden';
const listen = (server: Server, port = 0) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
const forward = (
  port: number,
  path: string,
  response: ServerResponse,
  done?: (status: number) => void,
) => {
  const request = http.get(
    { hostname: '127.0.0.1', port, path, agent: false },
    (upstream) => {
      if (done) {
        upstream.resume();
        done(upstream.statusCode ?? 503);
      } else {
        response.writeHead(upstream.statusCode ?? 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        upstream.pipe(response);
      }
    },
  );
  request.setTimeout(1000, () => request.destroy());
  request.on('error', () => {
    if (done) done(503);
    else if (!response.headersSent) {
      response.writeHead(502);
      response.end();
    }
  });
};

class SessionStack {
  mode: 'ok' | 'expired' | 'forbidden' = 'ok';
  mutations = 0;
  ports = { backend: 0, auth: 0, proxy: 0 };
  backend = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET') this.mutations++;
    response.end(
      JSON.stringify(
        request.url === '/api/auth/me'
          ? {
              active: true,
              kind: 'person',
              personId: 'SESSION_FIXTURE_PERSON',
              name: 'Synthetic identity',
              role: 'administrator',
            }
          : { maxIdleSubscriptions: 30 },
      ),
    );
  });
  auth = http.createServer((_request, response) => {
    response.writeHead(
      this.mode === 'expired' ? 401 : this.mode === 'forbidden' ? 403 : 204,
    );
    response.end();
  });
  proxy = http.createServer((request, response) => {
    forward(this.ports.auth, '/check', response, (status) => {
      if (status === 204) {
        if (request.method !== 'GET') {
          this.mutations++;
          response.end('{}');
        } else forward(this.ports.backend, request.url ?? '/', response);
      } else {
        response.writeHead(status === 401 ? 302 : status, {
          'Cache-Control': 'no-store',
          ...(status === 401
            ? { Location: '/outpost.goauthentik.io/start' }
            : {}),
        });
        response.end();
      }
    });
  });
  async start() {
    for (const name of ['backend', 'auth', 'proxy'] as const)
      this.ports[name] = await listen(this[name]);
  }
  async fault(fault: Fault) {
    if (fault === 'expired' || fault === 'forbidden') this.mode = fault;
    else await close(this[fault]);
  }
  async restore() {
    this.mode = 'ok';
    for (const name of ['backend', 'auth', 'proxy'] as const)
      if (!this[name].listening) await listen(this[name], this.ports[name]);
  }
  async dispose() {
    await Promise.all([
      close(this.proxy),
      close(this.auth),
      close(this.backend),
    ]);
  }
}

export function sessionStackFixtures() {
  // Vitest loads the inherited config separately for commands and its browser
  // server. Share only this test registry, not any application/session state.
  const registryKey = Symbol.for('mergeron.session-stack-fixtures');
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: Map<string, SessionStack> | undefined;
  };
  const fixtures = (registry[registryKey] ??= new Map<string, SessionStack>());
  return {
    async control(
      action: 'create' | 'restore' | 'dispose' | 'status' | Fault,
      id?: string,
    ) {
      if (action === 'create') {
        if (fixtures.size >= 8) throw Error('Session fixture limit exceeded');
        const next = randomUUID();
        const fixture = new SessionStack();
        fixtures.set(next, fixture);
        try {
          await fixture.start();
        } catch (error) {
          await fixture.dispose();
          fixtures.delete(next);
          throw error;
        }
        return { id: next, prefix: `/__session_stack/${next}`, mutations: 0 };
      }
      const fixture = fixtures.get(id ?? '');
      if (!fixture) throw Error('Unknown session fixture');
      if (action === 'restore') await fixture.restore();
      else if (action === 'dispose') {
        await fixture.dispose();
        fixtures.delete(id!);
        return {
          id,
          prefix: `/__session_stack/${id}`,
          mutations: fixture.mutations,
          listenersClosed:
            !fixture.backend.listening &&
            !fixture.auth.listening &&
            !fixture.proxy.listening,
        };
      } else if (action !== 'status') await fixture.fault(action);
      return {
        id,
        prefix: `/__session_stack/${id}`,
        mutations: fixture.mutations,
      };
    },
    middleware(
      request: IncomingMessage,
      response: ServerResponse,
      next: () => void,
    ) {
      if (!request.url?.startsWith('/__session_stack/')) return next();
      const match = /^\/__session_stack\/([0-9a-f-]{36})(\/api\/[^?]*)/.exec(
        request.url,
      );
      const fixture = match && fixtures.get(match[1]);
      if (!fixture || !match) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method !== 'GET') {
        fixture.mutations++;
        response.end('{}');
        return;
      }
      forward(fixture.ports.proxy, match[2], response);
    },
    async dispose() {
      await Promise.all(
        [...fixtures.values()].map((fixture) => fixture.dispose()),
      );
      fixtures.clear();
    },
  };
}
