/** Administrator-only CLI lifecycle, isolated from the image and user configuration. */
import {
  ConflictException,
  Injectable,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { CatalogPathsService } from '../catalog/catalog-paths.service';
import { CatalogAdmissionService } from '../catalog/catalog-admission.service';
import { CatalogActivityService } from '../catalog/catalog-activity.service';
import { CodexProcessManager } from '../codex-process-manager.service';
import { writeAtomic } from '../catalog/catalog-files';
import { ManagerStatusService } from '../../settings/manager-status.service';
import {
  cliBinary,
  cliRoot,
  cliSelection,
  CLI_VERSION,
  isNewerVersion,
  type CliSelection,
  hasCustomCli,
  approveCli,
  verifyCliRelease,
} from './managed-cli';

const execute = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org/';
const RELEASE_API = 'https://api.github.com/repos/openai/codex/releases/tags/';

interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  prerelease?: unknown;
  draft?: unknown;
}

export interface CliReleaseSection {
  heading: string;
  items: string[];
}

export interface CliReleaseNote {
  version: string;
  publishedAt: string | null;
  url: string;
  sections: CliReleaseSection[];
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Keep release data inert: select headings and bullets, strip Markdown links, never render HTML. */
export function extractReleaseSections(body: string): CliReleaseSection[] {
  const sections: CliReleaseSection[] = [];
  let current: CliReleaseSection | null = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/)?.[1]?.trim();
    if (heading) {
      current = /^changelog$/i.test(heading) ? null : { heading, items: [] };
      if (current) sections.push(current);
      continue;
    }
    const item = line.match(/^[-*]\s+(.+)$/)?.[1]?.trim();
    if (!current || !item || current.items.length >= 6) continue;
    current.items.push(
      item
        .replace(/\[([^\]]+)\]\([^\s)]+\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .slice(0, 600),
    );
  }
  return sections.filter((section) => section.items.length > 0).slice(0, 5);
}

@Injectable()
export class CodexCliService {
  private latestCache?: { version: string; at: number };
  private releaseCache?: {
    fromVersion: string;
    toVersion: string;
    releases: CliReleaseNote[];
    at: number;
  };
  private checking?: Promise<string>;
  private busy = false;
  constructor(
    private readonly paths: CatalogPathsService,
    private readonly config: ConfigService,
    private readonly admission: CatalogAdmissionService,
    private readonly activity: CatalogActivityService,
    private readonly manager: CodexProcessManager,
    @Optional() private readonly hostManager?: ManagerStatusService,
  ) {}

  protected requiresValidatedRuntime(): boolean {
    return (
      existsSync('/usr/local/bin/mergeron-agent-environment') ||
      hasCustomCli(this.paths.home)
    );
  }

  private assertOfficialAllowed(): void {
    if (this.requiresValidatedRuntime())
      throw new ConflictException('codexOfficialUpdateBlocked');
  }

  private safeRollback(selection: CliSelection): boolean {
    if (!selection.protection)
      return (
        !this.requiresValidatedRuntime() &&
        (selection.previous !== null || this.hasLegacyCli())
      );
    const hash =
      selection.previous && selection.protection.approved[selection.previous];
    if (!hash || !selection.previous) return false;
    try {
      const target = verifyCliRelease(
        dirname(cliBinary(this.paths.home, selection.previous)),
        hash,
      );
      return (
        target.id === selection.previous &&
        selection.protection.capabilities.every((c) =>
          target.capabilities.includes(c),
        )
      );
    } catch {
      return false;
    }
  }

  protected canManageCli(): boolean {
    return (
      !this.config.get<string>('CODEX_BIN') &&
      process.platform === 'linux' &&
      ['x64', 'arm64'].includes(process.arch)
    );
  }

  /** Bounded subprocesses, no shell interpolation, and explicit use of the configured egress proxy. */
  protected async command(
    binary: string,
    args: string[],
    timeout = 20_000,
  ): Promise<string> {
    const { stdout } = await execute(binary, args, {
      timeout,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        npm_config_proxy: process.env.HTTP_PROXY ?? process.env.http_proxy,
        npm_config_https_proxy:
          process.env.HTTPS_PROXY ?? process.env.https_proxy,
      },
    });
    return stdout.trim();
  }
  private async version(binary = this.paths.binary): Promise<string> {
    const output = await this.command(binary, ['--version']);
    const version = output.match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+)$/)?.[1];
    if (!version) throw new Error('Cannot determine Codex CLI version');
    return version;
  }
  private async latest(force = false): Promise<string> {
    if (
      !force &&
      this.latestCache &&
      Date.now() - this.latestCache.at < 15 * 60_000
    )
      return this.latestCache.version;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const version: unknown = JSON.parse(
        await this.command(
          'npm',
          [
            'view',
            '@openai/codex@latest',
            'version',
            '--json',
            `--registry=${REGISTRY}`,
            `--@openai:registry=${REGISTRY}`,
          ],
          30_000,
        ),
      );
      if (typeof version !== 'string' || !CLI_VERSION.test(version))
        throw new Error('Invalid stable version from npm');
      this.latestCache = { version, at: Date.now() };
      return version;
    })();
    try {
      return await this.checking;
    } finally {
      this.checking = undefined;
    }
  }

  protected hasLegacyCli(): boolean {
    return existsSync(
      join(this.paths.home, '..', '.local', 'share', 'mise', 'shims', 'codex'),
    );
  }

  async releaseNotes(force = false) {
    const state = await this.status(force);
    const fromVersion = state.installedVersion;
    const toVersion = state.latestVersion;
    if (!fromVersion || !toVersion)
      return {
        fromVersion,
        toVersion,
        releases: [] as CliReleaseNote[],
        releaseError: 'Unable to determine the CLI release range',
      };
    if (!isNewerVersion(toVersion, fromVersion))
      return {
        fromVersion,
        toVersion,
        releases: [] as CliReleaseNote[],
        releaseError: null,
      };
    if (
      !force &&
      this.releaseCache?.fromVersion === fromVersion &&
      this.releaseCache.toVersion === toVersion &&
      Date.now() - this.releaseCache.at < 15 * 60_000
    )
      return {
        fromVersion,
        toVersion,
        releases: this.releaseCache.releases,
        releaseError: null,
      };
    try {
      const versions: unknown = JSON.parse(
        await this.command(
          'npm',
          [
            'view',
            '@openai/codex',
            'versions',
            '--json',
            `--registry=${REGISTRY}`,
            `--@openai:registry=${REGISTRY}`,
          ],
          30_000,
        ),
      );
      if (!Array.isArray(versions)) throw new Error('Invalid version list');
      const range = versions
        .filter(
          (version): version is string =>
            typeof version === 'string' &&
            CLI_VERSION.test(version) &&
            isNewerVersion(version, fromVersion) &&
            compareVersions(version, toVersion) <= 0,
        )
        .sort(compareVersions);
      if (range.length > 25)
        throw new Error('Release range is too large to display safely');
      const releases = await Promise.all(
        range.map(async (version): Promise<CliReleaseNote> => {
          const raw = await this.command(
            'curl',
            [
              '--silent',
              '--show-error',
              '--fail',
              '--location',
              '--max-time',
              '20',
              '--header',
              'Accept: application/vnd.github+json',
              '--header',
              'User-Agent: codex-webui',
              `${RELEASE_API}rust-v${version}`,
            ],
            25_000,
          );
          const release = JSON.parse(raw) as GithubRelease;
          if (
            release.tag_name !== `rust-v${version}` ||
            release.prerelease === true ||
            release.draft === true
          )
            throw new Error('Invalid stable release metadata');
          const officialUrl = `https://github.com/openai/codex/releases/tag/rust-v${version}`;
          return {
            version,
            publishedAt:
              typeof release.published_at === 'string'
                ? release.published_at
                : null,
            url:
              typeof release.html_url === 'string' &&
              release.html_url === officialUrl
                ? release.html_url
                : officialUrl,
            sections: extractReleaseSections(
              typeof release.body === 'string' ? release.body : '',
            ),
          };
        }),
      );
      this.releaseCache = {
        fromVersion,
        toVersion,
        releases,
        at: Date.now(),
      };
      return { fromVersion, toVersion, releases, releaseError: null };
    } catch {
      return {
        fromVersion,
        toVersion,
        releases: [] as CliReleaseNote[],
        releaseError: 'Unable to load official CLI release notes',
      };
    }
  }
  async status(force = false) {
    const updateBlocked = this.requiresValidatedRuntime();
    let installedVersion: string | null = null,
      latestVersion: string | null = null,
      installedError: string | null = null,
      checkError: string | null = null;
    try {
      installedVersion = await this.version();
    } catch {
      installedError = 'Unable to read the installed CLI version';
    }
    if (!updateBlocked) {
      try {
        latestVersion = await this.latest(force);
      } catch {
        checkError = 'Unable to check npm for updates';
      }
    }
    const selection = cliSelection(this.paths.home);
    const externalBinary = Boolean(this.config.get<string>('CODEX_BIN'));
    const installationState = externalBinary
      ? 'external'
      : selection.version
        ? 'managed'
        : installedVersion
          ? 'legacy'
          : 'missing';
    if (installationState === 'missing') installedError = null;
    let managedRelease: {
      id: string;
      upstreamVersion: string;
      manifestSha256: string;
      upstreamCommit: string;
      patchSha256: string;
    } | null = null;
    let managerError: string | null = null;
    if (this.hostManager) {
      try {
        const release = await this.hostManager.codexCli();
        if (
          typeof release.id !== 'string' ||
          !/^\d+\.\d+\.\d+-mergeron\.[1-9]\d{0,5}$/.test(release.id) ||
          !/^[a-f0-9]{64}$/.test(String(release.manifestSha256))
        )
          throw new Error('Invalid runtime identity');
        managedRelease = release as unknown as NonNullable<
          typeof managedRelease
        >;
      } catch {
        managerError = 'codexRuntimeManagerUnavailable';
      }
    }
    return {
      installedVersion,
      latestVersion,
      updateAvailable:
        installedVersion && latestVersion
          ? isNewerVersion(latestVersion, installedVersion)
          : false,
      checkedAt: this.latestCache
        ? new Date(this.latestCache.at).toISOString()
        : null,
      installedError,
      checkError,
      busy: this.busy,
      canManage: this.canManageCli(),
      canRollback:
        !externalBinary &&
        selection.version !== null &&
        this.safeRollback(selection),
      selectedVersion: selection.version,
      installationState,
      officialUpdateBlocked: updateBlocked,
      protection: selection.protection
        ? installedVersion
          ? 'verified'
          : 'invalid'
        : hasCustomCli(this.paths.home)
          ? 'legacy-custom'
          : 'unprotected',
      managedRelease,
      managerError,
    };
  }

  /** Manager stages a verified immutable release; admission/activation stay here. */
  async installManaged(input: {
    releaseId?: unknown;
    manifestSha256?: unknown;
    expectedSelection?: unknown;
  }) {
    if (!this.canManageCli() || !this.hostManager)
      throw new ConflictException('codexRuntimeManagerUnavailable');
    if (
      typeof input.releaseId !== 'string' ||
      !/^\d+\.\d+\.\d+-mergeron\.[1-9]\d{0,5}$/.test(input.releaseId) ||
      typeof input.manifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.manifestSha256)
    )
      throw new BadRequestException('Invalid managed CLI identity');
    if (this.busy)
      throw new ConflictException('A CLI update is already in progress');
    const before = cliSelection(this.paths.home);
    if (input.expectedSelection !== before.version)
      throw new ConflictException(
        'CLI version changed; refresh before continuing',
      );
    const release = this.admission.begin();
    this.busy = true;
    let switched = false;
    try {
      await this.requireIdle(true);
      const staged = await this.hostManager.installCodexCli(
        input.releaseId,
        input.manifestSha256,
      );
      if (
        staged.id !== input.releaseId ||
        staged.manifestSha256 !== input.manifestSha256 ||
        staged.installed !== true
      )
        throw new Error('codexRuntimePlanChanged');
      const next = approveCli(this.paths.home, {
        id: input.releaseId,
        manifestSha256: input.manifestSha256,
      });
      await this.requireIdle(true);
      if (
        JSON.stringify(cliSelection(this.paths.home)) !== JSON.stringify(before)
      )
        throw new ConflictException(
          'CLI version changed; refresh before continuing',
        );
      this.manager.suspendRetries();
      this.select(next);
      switched = true;
      await this.manager.restartControlled(release);
      return { success: true, releaseId: next.version };
    } catch (error) {
      if (switched) {
        this.select(before);
        await this.manager.restartControlled(release);
      }
      throw error;
    } finally {
      this.busy = false;
      release();
    }
  }

  /** First installation is allowed while the managed app-server is unavailable. */
  async installFirst(expectedTarget: unknown) {
    this.assertOfficialAllowed();
    if (typeof expectedTarget !== 'string' || !CLI_VERSION.test(expectedTarget))
      throw new BadRequestException('Invalid expected CLI version');
    if (!this.canManageCli())
      throw new ConflictException(
        'This CLI installation is managed externally',
      );
    if (this.busy)
      throw new ConflictException('A CLI update is already in progress');
    try {
      await this.version();
      throw new ConflictException('Codex CLI is already installed');
    } catch (error) {
      if (error instanceof ConflictException) throw error;
    }
    const target = await this.latest(true);
    if (target !== expectedTarget)
      throw new ConflictException(
        'Latest CLI version changed; refresh before continuing',
      );
    const before = cliSelection(this.paths.home);
    const release = this.admission.begin();
    this.busy = true;
    let switched = false;
    try {
      await this.requireIdle(true);
      await this.install(target);
      await this.requireIdle(true);
      await mkdir(cliRoot(this.paths.home), { recursive: true, mode: 0o700 });
      this.manager.suspendRetries();
      this.select({ version: target, previous: before.version });
      switched = true;
      await this.manager.restartControlled(release);
      return { success: true };
    } catch (error) {
      if (switched) this.select(before);
      throw error;
    } finally {
      this.busy = false;
      release();
    }
  }

  /** Download to a fresh directory; no mutation of the running executable or global npm prefix. */
  private async install(version: string): Promise<void> {
    const target = dirname(cliBinary(this.paths.home, version));
    if (existsSync(cliBinary(this.paths.home, version))) {
      if ((await this.version(cliBinary(this.paths.home, version))) !== version)
        throw new Error('Installed release version mismatch');
      return;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(dirname(target), '.download-'));
    try {
      await this.command(
        'npm',
        [
          'install',
          '--prefix',
          staging,
          `@openai/codex@${version}`,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          `--registry=${REGISTRY}`,
          `--@openai:registry=${REGISTRY}`,
        ],
        300_000,
      );
      const platformPackage = createRequire(
        join(staging, 'package.json'),
      ).resolve(`@openai/codex-linux-${process.arch}/package.json`);
      const triple =
        process.arch === 'arm64'
          ? 'aarch64-unknown-linux-musl'
          : 'x86_64-unknown-linux-musl';
      const native = [
        join(dirname(platformPackage), 'vendor', triple, 'bin', 'codex'),
        join(dirname(platformPackage), 'vendor', triple, 'codex', 'codex'),
      ].find((path) => existsSync(path));
      if (!native || (await this.version(native)) !== version)
        throw new Error('Downloaded CLI could not be verified');
      // Relative links remain valid after the staging directory is renamed.
      await symlink(
        relative(await realpath(staging), native),
        join(staging, 'codex'),
      );
      await mkdir(join(staging, 'helpers'), { mode: 0o700 });
      for (const tool of [
        'codex',
        'apply_patch',
        'applypatch',
        'codex-execve-wrapper',
        'codex-linux-sandbox',
      ]) {
        await symlink('../codex', join(staging, 'helpers', tool));
      }
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  private select(selection: CliSelection): void {
    writeAtomic(
      join(cliRoot(this.paths.home), 'selection.json'),
      JSON.stringify(selection),
    );
  }
  /** Compare-and-set plus the same admission and idle checks used by catalog activation. */
  async change(
    expectedVersion: unknown,
    rollback = false,
    expectedTarget?: unknown,
  ) {
    if (!rollback) this.assertOfficialAllowed();
    if (
      typeof expectedVersion !== 'string' ||
      !(rollback
        ? /^\d+\.\d+\.\d+(?:-mergeron\.[1-9]\d{0,5})?$/.test(expectedVersion)
        : CLI_VERSION.test(expectedVersion))
    )
      throw new BadRequestException('Invalid expected CLI version');
    if (!this.canManageCli())
      throw new ConflictException(
        'This CLI installation is managed externally',
      );
    if (this.busy)
      throw new ConflictException('A CLI update is already in progress');
    const before = cliSelection(this.paths.home);
    if (rollback && !this.safeRollback(before))
      throw new ConflictException('codexUnsafeRollbackBlocked');
    const release = this.admission.begin();
    this.busy = true;
    let switched = false;
    try {
      if (
        (rollback && before.version ? before.version : await this.version()) !==
        expectedVersion
      )
        throw new ConflictException(
          'CLI version changed; refresh before continuing',
        );
      await this.requireIdle(rollback);
      if (rollback && before.version === null)
        throw new ConflictException('No previous managed CLI version');
      const target = rollback ? before.previous : await this.latest(true);
      if (rollback && target === null && !this.hasLegacyCli())
        throw new ConflictException('No previous CLI installation');
      if (!rollback && expectedTarget !== target)
        throw new ConflictException(
          'Latest CLI version changed; refresh before continuing',
        );
      if (!rollback && (!target || !isNewerVersion(target, expectedVersion)))
        throw new ConflictException('No newer stable CLI version is available');
      if (target && !before.protection) await this.install(target);
      await this.requireIdle(rollback);
      await mkdir(cliRoot(this.paths.home), { recursive: true, mode: 0o700 });
      this.manager.suspendRetries();
      this.select({ ...before, version: target, previous: before.version });
      switched = true;
      await this.manager.restartControlled(release);
      return { success: true };
    } catch (error) {
      if (switched) {
        this.select(before);
        try {
          await this.manager.restartControlled(release);
        } catch {
          throw new ConflictException(
            'CLI activation failed. Previous selection was restored, but Codex could not restart; inspect server logs.',
          );
        }
      }
      throw error;
    } finally {
      this.busy = false;
      release();
    }
  }
  private async requireIdle(allowStopped = false): Promise<void> {
    if (allowStopped && this.manager.isStopped()) return;
    const blockers = await this.activity.inspect();
    if (!blockers.canApply)
      throw new ConflictException({
        message: 'Codex must be idle before a CLI update',
        blockers: blockers.blockers,
      });
  }
}
