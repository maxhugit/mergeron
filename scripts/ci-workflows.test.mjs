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

test('browser identity does not invalidate dependencies and cleanup', () => {
  const dockerfile = read('deployment/browser/Dockerfile');
  assert.ok(
    dockerfile.indexOf('ARG MERGERON_REVISION') >
      dockerfile.indexOf('COPY public-proxy.mjs server.mjs'),
  );
  assert.match(dockerfile, /apt-get purge --yes gstreamer1\.0-plugins-bad/);
  assert.match(dockerfile, /USER pwuser/);
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
