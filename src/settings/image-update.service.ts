/** Read-only discovery of moving image tags; checking never pulls or installs images. */
import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch } from 'node:os';
import { promisify } from 'node:util';
import { ManagerStatusService } from './manager-status.service';
import {
  ServerReleaseService,
  type MergeronReleaseNote,
} from './server-release.service';

const execute = promisify(execFile);
const repository = 'ghcr.io/maxhugit/mergeron';
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const ttl = 5 * 60_000;
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface PublishedImage {
  digest: string;
  imageId: string;
  version: string | null;
  revision: string | null;
  builtAt: string | null;
}

@Injectable()
export class ImageUpdateService {
  private cache = new Map<string, { at: number; value: PublishedImage }>();
  private checking = new Map<string, Promise<PublishedImage>>();
  private changeCache = new Map<
    string,
    { items: string[]; truncated: boolean }
  >();
  private installedChangeCache = new Map<string, string>();

  /** Exact installed revision, independent of moving tags or newer releases. */
  async installedChanges() {
    const installed = await this.releases.installedBuild();
    const revision = installed.revision;
    if (!revision || !revisionPattern.test(revision))
      return {
        revision,
        items: [],
        url: null,
        checkError: 'installedChangesUnavailable',
      };
    const url = `https://github.com/maxhugit/mergeron/commit/${revision}`;
    try {
      let title = this.installedChangeCache.get(revision);
      if (!title) {
        const response = await this.fetchJson(
          `https://api.github.com/repos/maxhugit/mergeron/commits/${revision}`,
        );
        const value = object(response.value);
        if (value.sha !== revision) throw new Error('Commit identity mismatch');
        const message = object(value.commit).message;
        if (typeof message !== 'string') throw new Error('Commit unavailable');
        const lines = message
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        title = (
          /^Merge pull request /.test(lines[0] ?? '') ? lines[1] : lines[0]
        )
          ?.replace(/\p{Cc}/gu, ' ')
          .slice(0, 600);
        if (!title) throw new Error('Commit unavailable');
        if (this.installedChangeCache.size >= 20)
          this.installedChangeCache.clear();
        this.installedChangeCache.set(revision, title);
      }
      return { revision, items: [title], url, checkError: null };
    } catch {
      return {
        revision,
        items: [],
        url,
        checkError: 'installedChangesUnavailable',
      };
    }
  }

  constructor(
    private readonly releases: ServerReleaseService,
    private readonly manager: ManagerStatusService,
  ) {}

  /** URLs are constructed locally; credentials/URLs from remote payloads are never executed. */
  protected async fetchJson(
    url: string,
    token?: string,
  ): Promise<{ value: unknown; raw: string }> {
    const { stdout } = await execute(
      'curl',
      [
        '--disable',
        '--silent',
        '--show-error',
        '--fail',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--max-redirs',
        '3',
        '--max-time',
        '15',
        '--header',
        'User-Agent: mergeron',
        '--header',
        'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.github+json',
        ...(token ? ['--header', `Authorization: Bearer ${token}`] : []),
        url,
      ],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const value: unknown = JSON.parse(stdout);
    return { value, raw: stdout };
  }

  protected imageArchitecture(): string {
    return arch() === 'x64' ? 'amd64' : arch();
  }

  protected async fetchImage(tag: 'edge' | 'latest'): Promise<PublishedImage> {
    const auth = await this.fetchJson(
      'https://ghcr.io/token?service=ghcr.io&scope=repository:maxhugit/mergeron:pull',
    );
    const token = object(auth.value).token;
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token))
      throw new Error('Invalid registry token');
    const base = 'https://ghcr.io/v2/maxhugit/mergeron';
    const top = await this.fetchJson(`${base}/manifests/${tag}`, token);
    const digest = `sha256:${createHash('sha256').update(top.raw).digest('hex')}`;
    let manifest = object(top.value);
    if (Array.isArray(manifest.manifests)) {
      const architecture = this.imageArchitecture();
      const candidates: unknown[] = manifest.manifests;
      const platform = candidates
        .map(object)
        .find(
          (item) =>
            object(item.platform).os === 'linux' &&
            object(item.platform).architecture === architecture,
        );
      const platformDigest = platform?.digest;
      if (
        typeof platformDigest !== 'string' ||
        !digestPattern.test(platformDigest)
      )
        throw new Error('Image platform unavailable');
      const selected = await this.fetchJson(
        `${base}/manifests/${platformDigest}`,
        token,
      );
      if (
        `sha256:${createHash('sha256').update(selected.raw).digest('hex')}` !==
        platformDigest
      )
        throw new Error('Manifest integrity failure');
      manifest = object(selected.value);
    }
    const imageId = object(manifest.config).digest;
    if (typeof imageId !== 'string' || !digestPattern.test(imageId))
      throw new Error('Image identity unavailable');
    const config = await this.fetchJson(`${base}/blobs/${imageId}`, token);
    if (
      `sha256:${createHash('sha256').update(config.raw).digest('hex')}` !==
      imageId
    )
      throw new Error('Image integrity failure');
    const configValue = object(config.value);
    const labels = object(object(configValue.config).Labels);
    const revision: unknown = labels['org.opencontainers.image.revision'];
    const version: unknown = labels['org.opencontainers.image.version'];
    const builtAt = configValue.created;
    return {
      digest,
      imageId,
      revision:
        typeof revision === 'string' && revisionPattern.test(revision)
          ? revision
          : null,
      version: typeof version === 'string' ? version.slice(0, 80) : null,
      builtAt:
        typeof builtAt === 'string' && Number.isFinite(Date.parse(builtAt))
          ? builtAt
          : null,
    };
  }

  private async published(tag: 'edge' | 'latest', force: boolean) {
    const cached = this.cache.get(tag);
    if (!force && cached && Date.now() - cached.at < ttl) return cached.value;
    let checking = this.checking.get(tag);
    if (!checking) {
      checking = this.fetchImage(tag).then((value) => {
        this.cache.set(tag, { value, at: Date.now() });
        return value;
      });
      this.checking.set(tag, checking);
    }
    try {
      return await checking;
    } finally {
      this.checking.delete(tag);
    }
  }

  protected async changes(from: string, to: string) {
    const key = `${from}...${to}`;
    const cached = this.changeCache.get(key);
    if (cached) return cached;
    const response = await this.fetchJson(
      `https://api.github.com/repos/maxhugit/mergeron/compare/${from}...${to}?per_page=100`,
    );
    const value = object(response.value);
    if (!Array.isArray(value.commits)) throw new Error('Invalid comparison');
    const commits: unknown[] = value.commits;
    const result = {
      items: commits.slice(0, 100).flatMap((item): string[] => {
        const message = object(object(item).commit).message;
        if (typeof message !== 'string') return [];
        const lines = message.split('\n').filter((line: string) => line.trim());
        const title = /^Merge pull request /.test(lines[0] ?? '')
          ? lines[1]
          : lines[0];
        return typeof title === 'string'
          ? [title.replace(/\p{Cc}/gu, ' ').slice(0, 600)]
          : [];
      }),
      truncated:
        typeof value.total_commits === 'number' && value.total_commits > 100,
    };
    if (this.changeCache.size >= 20) this.changeCache.clear();
    this.changeCache.set(key, result);
    return result;
  }

  async status(force = false) {
    const [stable, manager] = await Promise.all([
      this.releases.status(force),
      this.manager.status(),
    ]);
    const inventory = manager as {
      environment?: string;
      components?: { id: string; image?: string; imageId?: string }[];
    };
    const application = inventory.components?.find(
      (component) => component.id === 'application',
    );
    const tag =
      application?.image === `${repository}:latest`
        ? 'latest'
        : application?.image === `${repository}:edge` ||
            inventory.environment === 'development' ||
            (!inventory.environment && stable.installed.channel === 'edge')
          ? 'edge'
          : 'latest';
    const targetImage = `${repository}:${tag}`;
    const base = {
      ...stable,
      // GitHub release metadata is not evidence of a deployable registry image.
      githubRelease: {
        version: stable.latestVersion,
        url: stable.latestUrl,
        publishedAt: stable.latestPublishedAt,
      },
      installed: stable.installed,
      targetChannel: tag === 'edge' ? ('edge' as const) : ('stable' as const),
      latestVersion: null as string | null,
      latestUrl: null as string | null,
      latestPublishedAt: null as string | null,
      targetImage,
      targetDigest: null as string | null,
      latestRevision: null as string | null,
      changesError: false,
      changesTruncated: false,
    };
    try {
      const image = await this.published(tag, force);
      const localDigest = application?.image?.split('@')[1];
      const imageIdentity =
        application?.imageId && digestPattern.test(application.imageId)
          ? application.imageId
          : undefined;
      const comparable = Boolean(
        imageIdentity ||
        (localDigest && digestPattern.test(localDigest)) ||
        (stable.installed.revision &&
          revisionPattern.test(stable.installed.revision) &&
          image.revision),
      );
      const changed = imageIdentity
        ? imageIdentity !== image.imageId
        : localDigest && digestPattern.test(localDigest)
          ? localDigest !== image.digest
          : stable.installed.revision !== image.revision;
      const updateAvailable = comparable && changed;
      let releases: MergeronReleaseNote[] =
        tag === 'latest' && updateAvailable
          ? stable.releases.filter((release) => {
              if (!image.version || !/^\d+\.\d+\.\d+$/.test(image.version))
                return false;
              const a = release.version.split('.').map(Number),
                b = image.version.split('.').map(Number);
              return (a.map((n, i) => n - b[i]).find((n) => n !== 0) ?? 0) <= 0;
            })
          : [];
      const compare =
        stable.installed.revision &&
        image.revision &&
        revisionPattern.test(stable.installed.revision)
          ? `https://github.com/maxhugit/mergeron/compare/${stable.installed.revision}...${image.revision}`
          : null;
      let changesError = false,
        changesTruncated = false;
      if (updateAvailable && !releases.length) {
        if (compare && stable.installed.revision !== image.revision) {
          try {
            const changes = await this.changes(
              stable.installed.revision!,
              image.revision!,
            );
            releases = [
              {
                version: `${tag} · ${image.revision!.slice(0, 7)}`,
                publishedAt: image.builtAt,
                url: compare,
                sections: changes.items.length
                  ? [{ heading: 'Commits', items: changes.items }]
                  : [],
              },
            ];
            changesTruncated = changes.truncated;
            changesError = changes.items.length === 0;
          } catch {
            changesError = true;
          }
        } else changesError = true;
      }
      return {
        ...base,
        latestVersion: image.version,
        latestRevision: image.revision,
        latestPublishedAt: image.builtAt,
        latestUrl:
          compare ??
          (image.revision
            ? `https://github.com/maxhugit/mergeron/commit/${image.revision}`
            : null),
        targetDigest: image.digest,
        updateAvailable,
        versionStatus: comparable
          ? updateAvailable
            ? 'update_available'
            : 'current'
          : 'unknown',
        releases,
        changesError,
        changesTruncated,
        checkedAt: new Date(
          this.cache.get(tag)?.at ?? Date.now(),
        ).toISOString(),
        checkError: null,
      };
    } catch {
      return {
        ...base,
        updateAvailable: false,
        versionStatus: 'unknown',
        releases: [],
        checkError: 'unableToCheckForMergeronUpdates',
        checkedAt: new Date().toISOString(),
      };
    }
  }
}
