import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import {
  cacheKeys,
  command,
  curlEnvironment,
  errorCode,
  localHeaders,
  optionsFrom,
  proxyAddress,
  run,
  tcpProbe,
  writableProbe,
} from './environment-check.mjs';

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'mergeron-env-test-'));
  try {
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('validates options and never includes invalid URL secrets in errors', () => {
  assert.equal(
    optionsFrom(['--visual', '--json', '--timeout', '100']).visual,
    true,
  );
  assert.equal(optionsFrom(['--help']).help, true);
  for (const args of [
    ['--unknown'],
    ['--cwd'],
    ['--timeout', 'NaN'],
    ['--timeout', '99'],
    ['--timeout', '30001'],
    ['--url', 'https://user:secret@example.com'],
    ['--url', 'file:///secret'],
    ['--url', 'secret'],
  ]) {
    assert.throws(
      () => optionsFrom(args),
      (error) => !error.message.includes('secret'),
    );
  }
});

test('write probes remove their own files, preserve existing files and do not create workspaces', async () =>
  fixture(async (root) => {
    await writeFile(join(root, 'keep.txt'), 'original');
    await writableProbe(root);
    assert.deepEqual(await readdir(root), ['keep.txt']);
    await assert.rejects(writableProbe(join(root, 'missing')), {
      code: 'ENOENT',
    });
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'original');
  }));

test('headers must exist and match the running Node version', async () =>
  fixture(async (root) => {
    await mkdir(join(root, 'include/node'), { recursive: true });
    await writeFile(join(root, 'include/node/node.h'), '// headers');
    await writeFile(join(root, 'include/node/config.gypi'), '{}');
    await writeFile(
      join(root, 'include/node/node_version.h'),
      '#define NODE_MAJOR_VERSION 22\n#define NODE_MINOR_VERSION 23\n#define NODE_PATCH_VERSION 3\n',
    );
    assert.equal(await localHeaders(root, '22.23.3'), true);
    assert.equal(await localHeaders(root, '22.23.4'), false);
    assert.equal(await localHeaders(undefined), false);
  }));

test('proxy parsing drops credentials and supports lowercase and IPv6', () => {
  assert.deepEqual(
    proxyAddress({ https_proxy: 'http://user:secret@proxy:3128' }),
    { hostname: 'proxy', port: 3128 },
  );
  assert.deepEqual(proxyAddress({ HTTP_PROXY: 'https://[::1]' }), {
    hostname: '::1',
    port: 443,
  });
  assert.equal(proxyAddress({}), null);
  assert.throws(() => proxyAddress({ HTTPS_PROXY: 'socks5://proxy' }));
  assert.equal(errorCode({ code: 'secret-token' }), 'UNAVAILABLE');
});

test('uppercase HTTP_PROXY is honored by curl without overriding explicit lowercase settings', () => {
  const env = {
    HTTP_PROXY: 'http://user:secret@proxy:3128',
    NO_PROXY: 'localhost',
  };
  assert.deepEqual(curlEnvironment(env), {
    ...env,
    http_proxy: env.HTTP_PROXY,
    no_proxy: 'localhost',
  });
  assert.equal(env.http_proxy, undefined);
  assert.equal(
    curlEnvironment({ ...env, http_proxy: 'http://explicit:3128' }).http_proxy,
    'http://explicit:3128',
  );
});

test('successful base preflight uses offline commands outside the project, without URL or browser access', async () =>
  fixture(async (root) => {
    const env = Object.fromEntries(
      cacheKeys.map((key) => [key, join(root, key)]),
    );
    const calls = [];
    const report = await run(optionsFrom(['--cwd', root]), {
      env,
      command: async (tool, args, options) => {
        calls.push(tool);
        assert.deepEqual(args, ['--version']);
        assert.notEqual(options.cwd, root);
        assert.equal(options.env.COREPACK_ENABLE_NETWORK, '0');
        assert.equal(options.env.COREPACK_ENABLE_PROJECT_SPEC, '0');
        assert.equal(options.env.COREPACK_ENABLE_AUTO_PIN, '0');
        return '10.18.3';
      },
      lookup: () => assert.fail('No DNS requested'),
      browserProbe: () => assert.fail('No browser requested'),
    });
    assert.equal(report.success, true);
    assert.deepEqual(calls, ['npm', 'corepack', 'pnpm']);
    assert.equal(
      report.checks.find((c) => c.id === 'node.headers').status,
      'warning',
    );
    assert.equal(
      report.checks.find((c) => c.id === 'proxy.reachability').status,
      'skipped',
    );
    assert.deepEqual((await readdir(root)).sort(), [...cacheKeys].sort());
  }));

test('failures are distinct and redact proxy credentials, child logs and URL query tokens', async () =>
  fixture(async (root) => {
    const report = await run(
      optionsFrom([
        '--cwd',
        root,
        '--visual',
        '--url',
        'https://example.com/?token=secret',
      ]),
      {
        env: { HTTPS_PROXY: 'http://user:secret@proxy:3128' },
        writableProbe: async () => {
          throw Object.assign(new Error('secret'), { code: 'EROFS' });
        },
        command: async (tool) => {
          throw Object.assign(
            new Error(
              'secret stderr https://user:secret@example.com/?token=secret',
            ),
            { code: tool === 'curl' ? 60 : 'EACCES', stderr: 'secret' },
          );
        },
        lookup: async () => {
          throw Object.assign(new Error('secret'), { code: 'ENOTFOUND' });
        },
        tcpProbe: () => assert.fail('Do not connect after DNS failure'),
        loopbackProbe: async () => {
          throw Object.assign(new Error('secret'), { code: 'EPERM' });
        },
        browserProbe: async () => {
          throw new Error('secret chromium logs');
        },
      },
    );
    assert.equal(report.success, false);
    for (const [id, code] of [
      ['workspace.write', 'EROFS'],
      ['proxy.dns', 'ENOTFOUND'],
      ['visual.loopback', 'EPERM'],
      ['network.url', 'TLS_CERTIFICATE'],
    ])
      assert.equal(report.checks.find((c) => c.id === id).code, code);
    assert.doesNotMatch(JSON.stringify(report), /secret|user:|token=/);
  }));

test('proxy DNS timeout is bounded and no TCP probe follows it', async () =>
  fixture(async (root) => {
    const report = await run(optionsFrom(['--cwd', root, '--timeout', '100']), {
      env: { HTTPS_PROXY: 'http://proxy' },
      command: async () => '1.2.3',
      lookup: () => new Promise(() => {}),
      tcpProbe: () => assert.fail('No TCP after DNS timeout'),
    });
    assert.equal(
      report.checks.find((c) => c.id === 'proxy.dns').code,
      'ETIMEDOUT',
    );
  }));

test('proxy TCP and HTTP denials are not reported as success, TLS and proxy settings are unchanged', async () =>
  fixture(async (root) => {
    const env = {
      HTTPS_PROXY: 'http://user:secret@proxy:3128',
      NO_PROXY: 'localhost',
    };
    const report = await run(
      optionsFrom(['--cwd', root, '--url', 'https://example.com/']),
      {
        env,
        lookup: async (host) => {
          assert.equal(host, 'proxy');
          return {};
        },
        tcpProbe: async () => {
          throw Object.assign(new Error(), { code: 'ECONNREFUSED' });
        },
        command: async (tool, args, options) => {
          if (tool !== 'curl') return '1.2.3';
          assert.deepEqual(options.env, {
            ...env,
            https_proxy: env.HTTPS_PROXY,
            no_proxy: env.NO_PROXY,
          });
          assert.equal(args[0], '--disable'); // no user .curlrc disabling TLS
          assert.ok(
            !args.includes('--insecure') && !args.includes('--noproxy'),
          );
          return '403';
        },
      },
    );
    assert.equal(
      report.checks.find((c) => c.id === 'proxy.tcp').code,
      'ECONNREFUSED',
    );
    assert.equal(
      report.checks.find((c) => c.id === 'network.url').code,
      'HTTP_403',
    );
  }));

test('real commands have output/time limits and TCP probes close their sockets', async () => {
  assert.equal(
    await command(process.execPath, ['--version'], { timeout: 1000 }),
    process.version,
  );
  await assert.rejects(
    command(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeout: 100,
    }),
  );
  const server = createServer((socket) => socket.end());
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    await tcpProbe(
      { hostname: '127.0.0.1', port: server.address().port },
      1000,
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('launcher gives each Core process private writable caches outside sources and preserves CLI argv', async () =>
  fixture(async (root) => {
    const launcher = resolve('scripts/mergeron-agent-environment.sh');
    const runLauncher = () =>
      spawnSync(
        'bash',
        [
          launcher,
          process.execPath,
          '-e',
          'console.log(JSON.stringify({env:process.env,args:process.argv.slice(1),pid:process.pid}))',
          '--',
          'argument with spaces',
          ';not-a-command',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TMPDIR: root,
            npm_config_cache: '/readonly/cache',
            npm_config_nodedir: '/explicit/headers',
          },
        },
      );
    const first = runLauncher();
    assert.equal(first.status, 0, first.stderr);
    const a = JSON.parse(first.stdout),
      b = JSON.parse(runLauncher().stdout);
    assert.equal(a.pid, first.pid); // exec preserves direct signal ownership.
    assert.deepEqual(a.args, ['argument with spaces', ';not-a-command']);
    assert.equal(a.env.npm_config_nodedir, '/explicit/headers');
    assert.notEqual(a.env.COREPACK_HOME, b.env.COREPACK_HOME);
    for (const key of cacheKeys) {
      assert.ok(a.env[key].startsWith(root + '/mergeron-agent-cache.'));
      await writableProbe(a.env[key]);
    }
    assert.equal((await stat(a.env.COREPACK_HOME)).mode & 0o077, 0);
  }));

test('the immutable pnpm seed is copied into the writable cache, never modified in place', async () =>
  fixture(async (root) => {
    const seed = join(root, 'seed');
    await mkdir(seed);
    await writeFile(join(seed, 'lastKnownGood.json'), '{"pnpm":"10.18.3"}');
    const script = (
      await readFile('scripts/mergeron-agent-environment.sh', 'utf8')
    ).replaceAll('/opt/mergeron-corepack', seed);
    const result = spawnSync(
      'bash',
      [
        '-s',
        '--',
        process.execPath,
        '-e',
        'console.log(process.env.COREPACK_HOME)',
      ],
      {
        input: script,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: root },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const copy = join(result.stdout.trim(), 'lastKnownGood.json');
    assert.equal(await readFile(copy, 'utf8'), '{"pnpm":"10.18.3"}');
    await writeFile(copy, 'changed');
    assert.equal(
      await readFile(join(seed, 'lastKnownGood.json'), 'utf8'),
      '{"pnpm":"10.18.3"}',
    );
  }));

test('image and CI ship the launcher, retained package-manager seed and executable preflight', async () => {
  const dockerfile = await readFile('Dockerfile', 'utf8');
  assert.match(dockerfile, /ENV COREPACK_HOME=\/opt\/mergeron-corepack/);
  assert.match(
    dockerfile,
    /COPY --from=toolchain-builder \/opt\/mergeron-corepack \/opt\/mergeron-corepack/,
  );
  for (const name of [
    'mergeron-agent-environment',
    'mergeron-environment-check',
  ])
    assert.match(
      dockerfile,
      new RegExp(`COPY scripts/${name}\\.sh /usr/local/bin/${name}`),
    );
  assert.match(
    await readFile('.github/workflows/quality.yml', 'utf8'),
    /node --test scripts\/environment-check.test.mjs/,
  );
});
