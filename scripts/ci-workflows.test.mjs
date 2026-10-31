import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const quality = read('.github/workflows/quality.yml');
const publish = read('.github/workflows/docker-publish.yml');
const job = (workflow, name) => {
  const match = workflow.match(
    new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`,
      'm',
    ),
  );
  assert.ok(match, `Missing job ${name}`);
  return match[1];
};

test('stacked PRs receive the full validation without a main-only trigger filter', () => {
  assert.match(quality, /^  pull_request:\s*\n  workflow_dispatch:/m);
  assert.match(quality, /^          src\/agent-monitors$/m);
  assert.match(quality, /^          src\/database\/migration-order.spec.ts$/m);
});

test('monitor management receives real Chromium and WebKit interface coverage', () => {
  assert.match(
    quality,
    /^          src\/components\/projects\/project-agent-monitors.browser.tsx$/m,
  );
});

test('session recovery keeps browser outage coverage and the isolated real ingress test', () => {
  assert.ok(quality.includes('src/routes/authenticated-layout.browser.tsx'));
  assert.ok(quality.includes('src/lib/platform-session.browser.tsx'));
  assert.ok(
    read('scripts/smoke-test-ingress.sh').includes(
      'python3 scripts/test-session-ingress.py',
    ),
  );
  const fixture = read('scripts/test-session-ingress.py');
  for (const safeguard of [
    '"--network", "none"',
    '"--read-only"',
    '"--cap-drop", "ALL"',
    '"--user", "101:101"',
  ])
    assert.ok(fixture.includes(safeguard));
  assert.ok(fixture.includes('for part in backend auth front; do'));
  assert.doesNotMatch(
    fixture,
    /--privileged|--publish|docker\.sock|docker system prune/,
  );
});

test('reviewed Git replacement receives responsive browser coverage without bypassing checks', () => {
  assert.match(
    quality,
    /name: Test reviewed Git restoration in Chromium and WebKit\n        if: matrix.part == 'frontend'/,
  );
  for (const file of [
    'git-restore-dialog',
    'workspace-git-panel',
    'git-complete-workflow',
  ]) {
    assert.ok(quality.includes(`src/components/chat/${file}.browser.tsx`));
  }
  assert.match(
    quality,
    /^          src\/projects\/workspace-git.service.spec.ts$/m,
  );
  assert.match(quality, /^          src\/internal-mcp$/m);
});

test('mobile viewport geometry is checked in both engines without replacing the other browser suites', () => {
  assert.match(
    quality,
    /name: Test mobile viewport layout in Chromium and WebKit\n        if: matrix.part == 'frontend'/,
  );
  assert.ok(quality.includes('src/lib/mobile-viewport.browser.tsx'));
  assert.ok(
    quality.includes('src/components/chat/compact-composer.browser.tsx'),
  );
  assert.ok(
    quality.includes('name: Test session recovery in Chromium and WebKit'),
  );
  assert.ok(
    quality.includes('name: Test retained agent views in Chromium and WebKit'),
  );
});

test('all independent image checks run concurrently, including UI/docs-only PRs', () => {
  for (const name of ['image', 'manager-image', 'browser-image']) {
    const block = job(quality, name);
    assert.doesNotMatch(block, /^    needs:/m);
    assert.match(
      block,
      /github\.event_name == 'pull_request' \|\| inputs\.validate_image == true/,
    );
    assert.match(
      block,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
    assert.doesNotMatch(block, /continue-on-error:|paths-ignore:|paths:/);
  }
  assert.doesNotMatch(quality, /paths-ignore:|paths:/);
});

test('required gate rejects every missing, failed or cancelled security job', () => {
  const gate = job(quality, 'quality');
  assert.match(
    gate,
    /needs: \[checks, image, manager-image, browser-image, cli-runtime\]/,
  );
  assert.match(gate, /if: always\(\)/);
  assert.match(gate, /EXPECT_IMAGES:.*github\.event_name == 'pull_request'/);
  const script = gate.split('        run: |\n')[1].replace(/^          /gm, '');
  const baseline = {
    SOURCE_RESULT: 'success',
    IMAGE_RESULT: 'success',
    MANAGER_RESULT: 'success',
    BROWSER_RESULT: 'success',
    CLI_RESULT: 'success',
    EXPECT_IMAGES: 'true',
  };
  const run = (overrides) =>
    spawnSync('bash', ['-e', '-c', script], {
      env: { ...process.env, ...baseline, ...overrides },
    }).status;
  assert.equal(run({}), 0);
  for (const variable of [
    'SOURCE_RESULT',
    'IMAGE_RESULT',
    'MANAGER_RESULT',
    'BROWSER_RESULT',
    'CLI_RESULT',
  ]) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.notEqual(
        run({ [variable]: result }),
        0,
        `${variable}=${result} must fail`,
      );
    }
  }
  assert.equal(
    run({
      EXPECT_IMAGES: 'false',
      IMAGE_RESULT: 'skipped',
      MANAGER_RESULT: 'skipped',
      BROWSER_RESULT: 'skipped',
      CLI_RESULT: 'skipped',
    }),
    0,
  );
  assert.notEqual(run({ EXPECT_IMAGES: 'false' }), 0);
});

test('all previous app integration/security controls remain mandatory', () => {
  const app = job(quality, 'image');
  for (const name of [
    'Test real SSH and Git transfers against an isolated server',
    'Start the production image and wait for its health check',
    'Verify protected document execution on Linux',
    'Build the isolated native MCP test runtime',
    'Verify project MCP policy on an existing native conversation',
    'Scan production image dependencies',
    'Verify header package and native compilation',
    'Apply reviewed header applicability statements',
    'Verify absent system implementations and retained client features',
    'Require no HIGH or CRITICAL Node.js dependencies',
    'Require no HIGH or CRITICAL GitHub CLI dependencies',
    'Verify patched libxml2 and real Office conversions',
    'Verify corrected OpenSSH sources and retain raw scan findings',
    'Validate both ingress authentication templates',
  ])
    assert.ok(app.includes(`- name: ${name}\n`), name);
  assert.match(app, /ignore-unfixed: false/);
  assert.match(app, /if: always\(\)[\s\S]*trivy-quality-report/);
});

test("image scanning releases only this job's completed build resources", () => {
  const app = job(quality, 'image');
  const cleanupName = 'Release completed build fixtures before image scanning';
  const cleanup = app
    .split(`      - name: ${cleanupName}\n`)[1]
    ?.split('      - name:')[0];
  assert.ok(cleanup);
  assert.ok(app.includes('id: app-builder'));
  assert.match(
    cleanup,
    /BUILDER_NAME: \$\{\{ steps\.app-builder\.outputs\.name \}\}/,
  );
  assert.ok(
    app.indexOf(cleanupName) > app.indexOf('Verify filtered test profile'),
  );
  assert.ok(
    app.indexOf(cleanupName) <
      app.indexOf('Scan production image dependencies'),
  );
  assert.doesNotMatch(
    cleanup,
    /docker (?:system|image|volume) prune|--volumes/,
  );
  const script = cleanup
    .split('        run: |\n')[1]
    .replace(/^          /gm, '');
  const run = (builder) =>
    spawnSync(
      'bash',
      [
        '-e',
        '-c',
        `
    docker() { printf '%s\\n' "docker $*"; }
    df() { :; }
    ${script}
  `,
      ],
      {
        env: {
          ...process.env,
          BUILDER_NAME: builder,
          MCP_IMAGE: 'mergeron:project-mcp-fixture',
        },
        encoding: 'utf8',
      },
    );
  const result = run('builder-this-job');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'docker system df',
    'docker image rm mergeron:project-mcp-fixture webui-ssh-fixture',
    'docker buildx prune --builder builder-this-job --all --force',
  ]);
  const missing = run('');
  assert.notEqual(missing.status, 0);
  assert.doesNotMatch(missing.stdout, /buildx prune/);
});

test('Manager and browser keep strict scans, smoke tests and reports', () => {
  for (const [name, component] of [
    ['manager-image', 'manager'],
    ['browser-image', 'browser'],
  ]) {
    const block = job(quality, name);
    assert.match(block, /severity: HIGH,CRITICAL/);
    assert.match(block, /ignore-unfixed: false/);
    assert.match(block, /exit-code: '1'/);
    assert.match(block, /version: v0\.76\.1/);
    assert.ok(block.includes(`trivy-${component}-results.json`));
    assert.match(block, /if: always\(\)/);
  }
  const manager = job(quality, 'manager-image');
  for (const script of ['secrets', 'backup', 'browser'])
    assert.ok(manager.includes(`smoke-test-manager-${script}.sh`));
  const smoke = read('scripts/smoke-test-browser-image.sh');
  assert.match(smoke, /--network none/);
  assert.match(smoke, /chromium\.launch/);
  assert.match(smoke, /Build package manager retained/);
  assert.match(smoke, /page\.setContent/);
});

test('Manager restart and load checks remain required before PR gates and image promotion', () => {
  for (const workflow of [quality, publish]) {
    assert.ok(
      workflow.includes(
        'bash scripts/smoke-test-manager-performance.sh "$IMAGE_REF"',
      ),
    );
    assert.ok(
      workflow.includes(
        'bash scripts/smoke-test-manager-restart.sh "$IMAGE_REF"',
      ),
    );
  }
  for (const script of ['performance', 'restart']) {
    const source = read(`scripts/smoke-test-manager-${script}.sh`);
    for (const safeguard of [
      '--network none',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges:true',
      '--memory 512m',
      '--cpus 0.25',
      '--pids-limit 64',
    ])
      assert.ok(source.includes(safeguard), safeguard);
    assert.doesNotMatch(
      source,
      /\/var\/run\/docker\.sock|docker (?:system|volume|image) prune|--privileged/,
    );
  }
});

test('cache writes are component/scoped, never PR writes to trusted main/legacy', () => {
  assert.match(quality, /format\('pr-\{0\}', github\.event\.number\)/);
  for (const workflow of [quality, publish]) {
    assert.doesNotMatch(workflow, /github\.head_ref/);
    assert.match(
      workflow,
      /github\.ref == 'refs\/heads\/main' && 'main' \|\| github\.sha/,
    );
    const writes = workflow
      .split('\n')
      .filter((line) => line.includes('cache-to:'));
    assert.equal(writes.length, 3);
    for (const component of ['app', 'manager', 'browser']) {
      assert.ok(
        writes.some((line) =>
          line.includes(`:buildcache-${component}-` + '${{ env.CACHE_SCOPE }}'),
        ),
      );
      assert.ok(workflow.includes(`:buildcache-${component}-main`));
    }
    for (const line of writes) assert.match(line, /mode=max,compression=zstd/);
  }
});

test('every Docker build explicitly uses the same platform, including SSH fixture', () => {
  for (const workflow of [quality, publish]) {
    const builds = workflow
      .split(/      - (?:name:|uses:)/)
      .filter((block) => block.includes('docker/build-push-action@'));
    for (const block of builds) assert.match(block, /platforms: linux\/amd64/);
    assert.match(
      workflow,
      /docker buildx build --platform linux\/amd64 --file Dockerfile --target ssh-test-server/,
    );
  }
});

test('browser preparation is parallel but moving tags remain gated by quality', () => {
  const build = job(publish, 'browser-build');
  const promote = job(publish, 'browser-publish');
  assert.doesNotMatch(build, /^    needs:/m);
  assert.match(build, /candidate-\$\{\{ github\.sha \}\}/);
  assert.match(build, /ignore-unfixed: false/);
  assert.match(build, /smoke-test-browser-image\.sh/);
  assert.doesNotMatch(build, /imagetools create/);
  assert.match(promote, /needs: \[quality, browser-build\]/);
  assert.match(promote, /needs\.browser-build\.outputs\.digest/);
  assert.match(promote, /imagetools create/);
  assert.match(publish, /cancel-in-progress: false/);
  assert.match(
    job(publish, 'promote'),
    /needs: \[quality, build, manager-build, cli-runtime\]/,
  );
  assert.match(job(publish, 'promote'), /scripts\/promote-image-pair\.sh/);
});

test('CLI installation and actual sandbox validation gate both PRs and promotion by immutable image digests', () => {
  const cli = job(quality, 'cli-runtime');
  assert.match(cli, /needs: \[image, manager-image\]/);
  assert.match(cli, /needs\.image\.outputs\.digest/);
  assert.match(cli, /needs\.manager-image\.outputs\.digest/);
  const publishCli = job(publish, 'cli-runtime');
  assert.match(publishCli, /needs: \[build, manager-build\]/);
  assert.match(publishCli, /needs\.build\.outputs\.digest/);
  assert.match(publishCli, /needs\.manager-build\.outputs\.digest/);
  for (const block of [cli, publishCli]) {
    assert.match(block, /smoke-test-managed-cli\.sh/);
    assert.doesNotMatch(block, /continue-on-error:/);
  }
});

test('CLI fixture establishes ownership before chmod with CHOWN only', () => {
  const smoke = read('scripts/smoke-test-managed-cli.sh');
  const initializer = smoke.slice(
    smoke.indexOf('docker run --rm'),
    smoke.indexOf('docker run -d'),
  );
  assert.match(initializer, /--cap-drop ALL --cap-add CHOWN/);
  assert.match(initializer, /--read-only/);
  assert.match(initializer, /--network none/);
  assert.match(initializer, /--security-opt no-new-privileges:true/);
  assert.doesNotMatch(
    initializer,
    /--privileged|--cap-add (?:ALL|FOWNER|DAC_OVERRIDE)/,
  );
  const source = initializer.match(/-e '([^']+)'/)[1];
  for (const runnerUid of [1001, 0]) {
    const owners = new Map(
      ['home', 'workspace', 'run', 'state'].map((p) => [
        '/fixture/' + p,
        [runnerUid, runnerUid],
      ]),
    );
    const modes = new Map();
    const fs = {
      chownSync: (path, uid, gid) => {
        assert.ok(owners.has(path));
        owners.set(path, [uid, gid]);
      },
      chmodSync: (path, mode) => {
        // Root with all capabilities dropped cannot chmod another UID's inode.
        assert.equal(
          owners.get(path)?.[0],
          0,
          `chmod without ownership: ${path}`,
        );
        modes.set(path, mode);
      },
    };
    runInNewContext(source, {
      require: (name) => {
        assert.equal(name, 'node:fs');
        return fs;
      },
    });
    assert.deepEqual(owners.get('/fixture/home'), [11002, 11002]);
    assert.deepEqual(owners.get('/fixture/workspace'), [11002, 11002]);
    assert.deepEqual(owners.get('/fixture/run'), [0, 11002]);
    assert.deepEqual(owners.get('/fixture/state'), [0, 0]);
    assert.equal(modes.get('/fixture/run'), 0o750);
    assert.equal(modes.get('/fixture/state'), 0o700);
  }
});

test('trusted fixture exports only approved evidence readable by a different runner UID', () => {
  const probe = read('scripts/smoke-test-document-isolation.cjs');
  const start = probe.indexOf("  if (process.argv[3] === '--netlink-route'");
  const end = probe.indexOf('\n} finally {', start);
  assert.ok(start > 0 && end > start);
  const exporter = probe.slice(start, end);
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    const { runInNewContext } = require('node:vm');
    const fixture = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mergeron-evidence-test-'));
    try {
      process.umask(0o077);
      const workspace = path.join(fixture, 'workspace');
      const source = path.join(workspace, 'artifacts/native-backend-visual');
      const output = path.join(fixture, 'output');
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(output);
      const png = Buffer.from('89504e470d0a1a0a', 'hex');
      fs.writeFileSync(path.join(source, 'desktop.png'), png);
      fs.writeFileSync(path.join(source, 'mobile.png'), png);
      fs.writeFileSync(path.join(source, 'report.json'), '{}');
      fs.writeFileSync(path.join(source, 'private-state'), 'must-not-export');
      const context = {
        fs, path, assert, workspace, console: { log() {} },
        process: { argv: ['', '', '', '--netlink-route'], env: { MERGERON_NETLINK_EVIDENCE: output } },
      };
      runInNewContext(${JSON.stringify(exporter)}, context);
      assert.deepEqual(fs.readdirSync(output).sort(), ['desktop.png', 'mobile.png', 'report.json']);
      for (const name of fs.readdirSync(output)) {
        assert.equal(fs.statSync(path.join(output, name)).mode & 0o777, 0o644);
        assert.deepEqual(fs.readFileSync(path.join(output, name)), fs.readFileSync(path.join(source, name)));
      }
      assert.equal(fs.statSync(path.join(source, 'private-state')).mode & 0o777, 0o600);
      assert.equal(process.umask(), 0o077);
      assert.throws(() => runInNewContext(${JSON.stringify(exporter)}, context), { code: 'EEXIST' });
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const smoke = read('scripts/smoke-test-document-isolation.sh');
  assert.match(smoke, /test -z "\$\(find "\$MERGERON_NETLINK_EVIDENCE"/);
  assert.match(smoke, /--cap-drop ALL/);
  assert.doesNotMatch(smoke, /--privileged|--cap-add/);
});

test('browser identity does not invalidate dependencies and cleanup', () => {
  const dockerfile = read('deployment/browser/Dockerfile');
  assert.ok(
    dockerfile.indexOf('ARG MERGERON_REVISION') >
      dockerfile.indexOf('COPY public-proxy.mjs server.mjs'),
  );
  assert.match(dockerfile, /apt-get purge --yes gstreamer1\.0-plugins-bad/);
  assert.match(dockerfile, /apt-get update/);
  assert.match(
    dockerfile,
    /apt-get install --yes --no-install-recommends --only-upgrade libbrotli1/,
  );
  assert.match(
    dockerfile,
    /dpkg --compare-versions.*libbrotli1.*ge '1\.1\.0-2ubuntu0\.1'/,
  );
  assert.match(dockerfile, /USER pwuser/);
  for (const workflow of [
    read('.github/workflows/quality.yml'),
    read('.github/workflows/docker-publish.yml'),
  ]) {
    const browser = workflow.slice(workflow.indexOf('  browser-'));
    assert.match(browser, /Resolve browser build identity/);
    for (const argument of [
      'MERGERON_REVISION',
      'MERGERON_VERSION',
      'MERGERON_BUILD_DATE',
      'MERGERON_RELEASE_CHANNEL',
    ]) {
      assert.match(browser, new RegExp(`${argument}=\\$\\{\\{`));
    }
  }
  assert.match(dockerfile, /io\.mergeron\.version="\$\{MERGERON_VERSION\}"/);
  assert.match(
    read('scripts/smoke-test-browser-image.sh'),
    /Browser product version missing/,
  );
  const managerContext = read('Dockerfile.manager.dockerignore');
  assert.match(managerContext, /^\*\*$/m);
  for (const path of [
    'manager/package.json',
    'manager/stack-manifest.json',
    'manager/src/**',
    'deployment/config/seccomp-bwrap.json',
    'deployment/config/nginx.conf.template',
    'deployment/config/nginx.native.conf.template',
    'deployment/config/squid.conf',
  ]) {
    assert.ok(managerContext.includes(`!${path}\n`), path);
  }
});
