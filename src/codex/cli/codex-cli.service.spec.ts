/** No real downloads or processes: exercise installation, selection, admission and rollback boundaries. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CatalogPathsService } from '../catalog/catalog-paths.service';
import { CatalogAdmissionService } from '../catalog/catalog-admission.service';
import type { CatalogActivityService } from '../catalog/catalog-activity.service';
import type { CodexProcessManager } from '../codex-process-manager.service';
import { CodexCliService, extractReleaseSections } from './codex-cli.service';
import { cliSelection, isNewerVersion } from './managed-cli';
import testing from '../../../runtime/testing.cjs';

class TestCliService extends CodexCliService {
  requireValidated = false;
  calls: { binary: string; args: string[] }[] = [];
  failCheck = false;
  installed = true;
  legacy = true;
  protected override canManageCli(): boolean {
    return true;
  }
  protected override requiresValidatedRuntime(): boolean {
    return this.requireValidated || super.requiresValidatedRuntime();
  }
  protected override hasLegacyCli(): boolean {
    return this.legacy;
  }
  protected override async command(
    binary: string,
    args: string[],
  ): Promise<string> {
    await Promise.resolve();
    this.calls.push({ binary, args });
    if (binary === 'npm' && args[0] === 'view') {
      if (this.failCheck) throw new Error('Network unavailable');
      if (args.includes('versions')) return '["1.0.0","1.0.1","1.1.0"]';
      return '"1.1.0"';
    }
    if (binary === 'curl') {
      const version = args.at(-1)?.match(/rust-v(\d+\.\d+\.\d+)$/)?.[1];
      return JSON.stringify({
        tag_name: `rust-v${version}`,
        name: version,
        published_at: '2026-10-15T21:30:38Z',
        prerelease: false,
        draft: false,
        html_url: `https://github.com/openai/codex/releases/tag/rust-v${version}`,
        body: `## New Features\n\n- Added **feature** for ${version}.\n\n## Changelog\n\n- ignored`,
      });
    }
    if (binary === 'npm' && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1];
      const root = join(
        prefix,
        'node_modules',
        '@openai',
        `codex-linux-${process.arch}`,
      );
      const triple =
        process.arch === 'arm64'
          ? 'aarch64-unknown-linux-musl'
          : 'x86_64-unknown-linux-musl';
      const native = join(root, 'vendor', triple, 'bin', 'codex');
      mkdirSync(dirname(native), { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: `@openai/codex-linux-${process.arch}` }),
      );
      writeFileSync(native, 'mock native binary');
      return '';
    }
    if (!binary.includes('/releases/') && !this.installed)
      throw new Error('Codex CLI is not installed');
    return `codex-cli ${binary.includes('/releases/') ? '1.1.0' : '1.0.0'}`;
  }
}
let directory: string;
let paths: CatalogPathsService;
let service: TestCliService;
let admission: CatalogAdmissionService;
let activity: { inspect: ReturnType<typeof vi.fn> };
let manager: {
  isStopped: ReturnType<typeof vi.fn>;
  suspendRetries: ReturnType<typeof vi.fn>;
  restartControlled: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'codex-cli-test-'));
  const config = new ConfigService({
    CODEX_HOME: directory,
  });
  paths = new CatalogPathsService(config);
  admission = new CatalogAdmissionService();
  activity = {
    inspect: vi.fn().mockResolvedValue({ canApply: true, blockers: [] }),
  };
  manager = {
    isStopped: vi.fn(() => false),
    suspendRetries: vi.fn(),
    restartControlled: vi.fn((ready: () => void) => Promise.resolve(ready())),
  };
  service = new TestCliService(
    paths,
    config,
    admission,
    activity as unknown as CatalogActivityService,
    manager as unknown as CodexProcessManager,
  );
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('blocks official updates and first installs before npm or activation in a protected deployment', async () => {
  service.requireValidated = true;
  await expect(service.change('1.0.0', false, '1.1.0')).rejects.toThrow(
    'codexOfficialUpdateBlocked',
  );
  service.installed = false;
  await expect(service.installFirst('1.1.0')).rejects.toThrow(
    'codexOfficialUpdateBlocked',
  );
  expect(service.calls).toEqual([]);
  expect(manager.restartControlled).not.toHaveBeenCalled();
});

it('does not query npm when the validated Manager runtime is required', async () => {
  service.requireValidated = true;
  const status = await service.status();
  expect(status.officialUpdateBlocked).toBe(true);
  expect(status.latestVersion).toBeNull();
  expect(service.calls.some((call) => call.binary === 'npm')).toBe(false);
});

it('blocks unapproved legacy rollback before the protected runtime has been migrated', async () => {
  service.requireValidated = true;
  mkdirSync(join(directory, 'webui/cli'), { recursive: true });
  writeFileSync(
    join(directory, 'webui/cli/selection.json'),
    JSON.stringify({ version: '1.0.0', previous: '0.9.0' }),
  );
  await expect(service.change('1.0.0', true)).rejects.toThrow(
    'codexUnsafeRollbackBlocked',
  );
  expect(service.calls).toEqual([]);
  expect(manager.restartControlled).not.toHaveBeenCalled();
});

function managerFixture(revision = 1) {
  const pkg = testing.bundle(directory, revision);
  const host = {
    installCodexCli: vi.fn((id: string, hash: string) => {
      expect(id).toBe(pkg.data.id);
      expect(hash).toBe(pkg.data.manifestSha256);
      mkdirSync(join(directory, 'webui/cli/releases'), { recursive: true });
      cpSync(pkg.directory, join(directory, 'webui/cli/releases', id), {
        recursive: true,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      });
      return Promise.resolve({ ...pkg.data, installed: true });
    }),
  };
  const instance = new TestCliService(
    paths,
    new ConfigService({ CODEX_HOME: directory }),
    admission,
    activity as unknown as CatalogActivityService,
    manager as unknown as CodexProcessManager,
    host as unknown as import('../../settings/manager-status.service').ManagerStatusService,
  );
  return { pkg, host, instance };
}

it('activates a Manager package only after idle admission and verifies immutable bytes', async () => {
  const { pkg, host, instance } = managerFixture();
  await instance.installManaged({
    releaseId: pkg.data.id,
    manifestSha256: pkg.data.manifestSha256,
    expectedSelection: null,
  });
  expect(host.installCodexCli).toHaveBeenCalledOnce();
  expect(cliSelection(directory)).toMatchObject({
    version: pkg.data.id,
    protection: {
      capabilities: ['netlink-route-query-v1'],
      approved: { [pkg.data.id]: pkg.data.manifestSha256 },
    },
  });
  expect(paths.binary).toContain(pkg.data.id);
  expect(manager.restartControlled).toHaveBeenCalledOnce();
  await expect(instance.change('0.164.0', false, '1.1.0')).rejects.toThrow(
    'codexOfficialUpdateBlocked',
  );
  await expect(instance.change(pkg.data.id, true)).rejects.toThrow(
    'codexUnsafeRollbackBlocked',
  );
});

it('does not ask Manager to install while work is active or the selection is stale', async () => {
  const { pkg, host, instance } = managerFixture();
  await expect(
    instance.installManaged({
      releaseId: pkg.data.id,
      manifestSha256: pkg.data.manifestSha256,
      expectedSelection: '1.0.0',
    }),
  ).rejects.toThrow('CLI version changed');
  activity.inspect.mockResolvedValue({ canApply: false, blockers: [] });
  await expect(
    instance.installManaged({
      releaseId: pkg.data.id,
      manifestSha256: pkg.data.manifestSha256,
      expectedSelection: null,
    }),
  ).rejects.toThrow('Codex must be idle');
  expect(host.installCodexCli).not.toHaveBeenCalled();
});

it('restores the previous selection and restarts it after a failed custom activation', async () => {
  const { pkg, instance } = managerFixture();
  manager.restartControlled.mockRejectedValueOnce(new Error('bad candidate'));
  await expect(
    instance.installManaged({
      releaseId: pkg.data.id,
      manifestSha256: pkg.data.manifestSha256,
      expectedSelection: null,
    }),
  ).rejects.toThrow('bad candidate');
  expect(cliSelection(directory)).toEqual({ version: null, previous: null });
  expect(manager.restartControlled).toHaveBeenCalledTimes(2);
  expect(() => admission.enter('new work')()).not.toThrow();
});

it('preserves approvals on rollback to a previously validated variant', async () => {
  const first = managerFixture(1);
  await first.instance.installManaged({
    releaseId: first.pkg.data.id,
    manifestSha256: first.pkg.data.manifestSha256,
    expectedSelection: null,
  });
  const second = managerFixture(2);
  await second.instance.installManaged({
    releaseId: second.pkg.data.id,
    manifestSha256: second.pkg.data.manifestSha256,
    expectedSelection: first.pkg.data.id,
  });
  await second.instance.change(second.pkg.data.id, true);
  expect(cliSelection(directory).version).toBe(first.pkg.data.id);
  expect(
    Object.keys(cliSelection(directory).protection!.approved),
  ).toHaveLength(2);
});

it('compares stable versions numerically and rejects paths or prereleases', () => {
  expect(isNewerVersion('1.10.0', '1.9.9')).toBe(true);
  expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  expect(isNewerVersion('../../bin', '1.0.0')).toBe(false);
  expect(isNewerVersion('2.0.0-beta', '1.0.0')).toBe(false);
});
it('reports unavailable registry evidence without claiming the CLI is current', async () => {
  service.failCheck = true;
  expect(await service.status()).toMatchObject({
    installedVersion: '1.0.0',
    latestVersion: null,
    checkError: 'Unable to check npm for updates',
    updateAvailable: false,
  });
});
it('reports a fresh persistent home as ready for first installation', async () => {
  service.installed = false;
  service.legacy = false;
  await expect(service.status()).resolves.toMatchObject({
    installationState: 'missing',
    installedVersion: null,
    installedError: null,
    latestVersion: '1.1.0',
    canManage: true,
  });
});
it('lists every stable release in range and extracts only inert highlights', async () => {
  expect(
    extractReleaseSections(
      '## New Features\n- Use [`/config`](https://example.test) now.\n## Changelog\n- ignored',
    ),
  ).toEqual([{ heading: 'New Features', items: ['Use /config now.'] }]);
  await expect(service.releaseNotes()).resolves.toMatchObject({
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    releaseError: null,
    releases: [
      { version: '1.0.1', sections: [{ heading: 'New Features' }] },
      { version: '1.1.0', sections: [{ heading: 'New Features' }] },
    ],
  });
  expect(service.calls.filter((call) => call.binary === 'curl')).toHaveLength(
    2,
  );
});
it('refuses active work before downloading or restarting', async () => {
  activity.inspect.mockResolvedValue({
    canApply: false,
    blockers: [{ reason: 'Running turn' }],
  });
  await expect(service.change('1.0.0', false, '1.1.0')).rejects.toThrow(
    'Codex must be idle',
  );
  expect(service.calls.some((call) => call.binary === 'npm')).toBe(false);
  expect(manager.restartControlled).not.toHaveBeenCalled();
  expect(() => admission.enter('new work')()).not.toThrow();
});
it('rejects stale installed or target versions', async () => {
  await expect(service.change('0.9.0', false, '1.1.0')).rejects.toThrow(
    'CLI version changed',
  );
  await expect(service.change('1.0.0', false, '9.9.9')).rejects.toThrow(
    'Latest CLI version changed',
  );
  expect(service.calls.some((call) => call.args[0] === 'install')).toBe(false);
});
it('installs in persistent storage, uses matching helpers and can roll back to the legacy CLI', async () => {
  await service.change('1.0.0', false, '1.1.0');
  expect(cliSelection(directory)).toEqual({ version: '1.1.0', previous: null });
  expect(existsSync(paths.binary)).toBe(true);
  expect(paths.childPath).toContain('/releases/1.1.0/helpers');
  expect(
    readlinkSync(join(dirname(paths.binary), 'helpers', 'apply_patch')),
  ).toBe('../codex');
  expect(
    service.calls.find((call) => call.args[0] === 'install')?.args,
  ).toContain('--ignore-scripts');
  await service.change('1.1.0', true);
  expect(cliSelection(directory).version).toBeNull();
  expect(manager.restartControlled).toHaveBeenCalledTimes(2);
});
it('performs the first installation while the app-server is stopped', async () => {
  service.installed = false;
  service.legacy = false;
  manager.isStopped.mockReturnValue(true);
  await service.installFirst('1.1.0');
  expect(cliSelection(directory)).toEqual({
    version: '1.1.0',
    previous: null,
  });
  expect(existsSync(paths.binary)).toBe(true);
  expect(manager.restartControlled).toHaveBeenCalledOnce();
});
it('rejects a stale first-install target before downloading', async () => {
  service.installed = false;
  service.legacy = false;
  manager.isStopped.mockReturnValue(true);
  await expect(service.installFirst('1.0.1')).rejects.toThrow(
    'Latest CLI version changed',
  );
  expect(service.calls.some((call) => call.args[0] === 'install')).toBe(false);
});
it('restores the previous selection and restarts it after activation failure', async () => {
  manager.restartControlled.mockRejectedValueOnce(
    new Error('Initialize failed'),
  );
  await expect(service.change('1.0.0', false, '1.1.0')).rejects.toThrow(
    'Initialize failed',
  );
  expect(cliSelection(directory).version).toBeNull();
  expect(manager.restartControlled).toHaveBeenCalledTimes(2);
  expect(() => admission.enter('new work')()).not.toThrow();
});
it('rechecks idle after download and never switches a now-busy server', async () => {
  activity.inspect
    .mockResolvedValueOnce({ canApply: true, blockers: [] })
    .mockResolvedValueOnce({ canApply: false, blockers: [] });
  await expect(service.change('1.0.0', false, '1.1.0')).rejects.toThrow(
    'Codex must be idle',
  );
  expect(cliSelection(directory).version).toBeNull();
  expect(manager.restartControlled).not.toHaveBeenCalled();
});

it('allows recovery of a selected CLI when the managed app-server is fully stopped', async () => {
  await service.change('1.0.0', false, '1.1.0');
  manager.isStopped.mockReturnValue(true);
  activity.inspect.mockResolvedValue({ canApply: false, blockers: [] });
  await service.change('1.1.0', true);
  expect(cliSelection(directory).version).toBeNull();
});
