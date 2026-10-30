import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get, Agent } from 'node:http';
import { configuration, backendEnvironment, repository } from './config.mjs';
import { initialize } from './initialize.mjs';

export function probe(port, path) {
  return new Promise((resolve, reject) => {
    const request = get(
      { hostname: '127.0.0.1', port, path, agent: new Agent(), timeout: 2000 },
      (response) => {
        response.resume();
        response.on('end', () =>
          response.statusCode === 200
            ? resolve()
            : reject(new Error(`HTTP ${response.statusCode}`)),
        );
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error('Preview readiness timeout')),
    );
    request.on('error', reject);
  });
}

export async function start(config = configuration()) {
  await initialize(config);
  const backend = spawn(
    process.execPath,
    [join(repository, 'scripts/preview/backend.cjs')],
    {
      cwd: config.dataDirectory,
      env: backendEnvironment(config),
      stdio: 'inherit',
    },
  );
  let vite;
  let stopping = false;
  let backendFailed = false;
  let backendExited = false;
  const onExit = new Promise((resolve) =>
    backend.once('close', () => {
      backendExited = true;
      resolve();
    }),
  );
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await vite?.close();
    if (!backendExited) {
      backend.kill('SIGTERM');
      const killTimer = setTimeout(() => backend.kill('SIGKILL'), 5000);
      killTimer.unref();
      await onExit;
      clearTimeout(killTimer);
    }
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  backend.once('error', () => {
    backendFailed = true;
    process.exitCode = 1;
    void stop();
  });
  backend.once('exit', () => {
    if (!stopping) {
      backendFailed = true;
      process.exitCode = 1;
      void stop();
    }
  });
  try {
    const deadline = Date.now() + 60000;
    while (true) {
      if (stopping || backendFailed)
        throw new Error('Preview backend exited before readiness');
      try {
        await probe(config.backendPort, '/api/auth/methods');
        break;
      } catch {
        if (Date.now() >= deadline)
          throw new Error(
            'Preview backend did not become ready within 60 seconds',
          );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const require = createRequire(join(repository, 'web/package.json'));
    const { createServer } = await import(
      pathToFileURL(require.resolve('vite')).href
    );
    const target = `http://127.0.0.1:${config.backendPort}`;
    vite = await createServer({
      root: join(repository, 'web'),
      mode: 'development',
      configFile: join(repository, 'web/vite.config.ts'),
      server: {
        host: config.host,
        port: config.frontendPort,
        strictPort: true,
        allowedHosts: config.allowedHosts,
        ...(config.publicUrl || config.httpsHmr
          ? {
              hmr: {
                protocol: 'wss',
                clientPort: Number(config.publicUrl?.port || 443),
              },
            }
          : {}),
        proxy: { '/api': { target }, '/socket.io': { target, ws: true } },
      },
    });
    if (stopping || backendFailed)
      throw new Error('Preview backend stopped while Vite initialized');
    await vite.listen();
    await probe(config.frontendPort, '/@vite/client');
    await probe(config.frontendPort, '/api/auth/methods');
    console.log(
      `Preview ready: Vite ${config.frontendPort}, Nest/Fastify ${config.backendPort}; HMR client and API proxy HTTP 200`,
    );
    return { stop, vite, config };
  } catch (error) {
    await vite?.close();
    await stop();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
