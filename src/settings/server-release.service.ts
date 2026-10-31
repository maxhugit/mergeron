/** Read-only discovery of installed and published Mergeron versions. */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const RELEASES_API =
  'https://api.github.com/repos/maxhugit/mergeron/releases?per_page=100';
const RELEASE_TAG = /^v(0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_RELEASES = 25;

export interface MergeronBuildInfo {
  version: string | null;
  revision: string | null;
  builtAt: string | null;
  channel: 'edge' | 'stable' | 'unknown';
}

export interface MergeronReleaseSection {
  heading: string;
  items: string[];
}

export interface MergeronReleaseNote {
  version: string;
  publishedAt: string | null;
  url: string;
  sections: MergeronReleaseSection[];
}

export interface GithubRelease {
  tag_name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

interface ReleaseSnapshot {
  latestVersion: string;
  latestPublishedAt: string | null;
  latestUrl: string;
  releases: MergeronReleaseNote[];
  at: number;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/** Keep remote release text inert: only headings and bounded list items reach the UI. */
export function extractMergeronReleaseSections(
  body: string,
): MergeronReleaseSection[] {
  const sections: MergeronReleaseSection[] = [];
  let current: MergeronReleaseSection | null = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const heading = line.match(/^#{2,3}\s+(.+)$/)?.[1];
    if (heading) {
      const cleaned = cleanMarkdown(heading);
      current = /^what'?s changed$/i.test(cleaned)
        ? null
        : { heading: cleaned, items: [] };
      if (current) sections.push(current);
      continue;
    }
    const item = line.match(/^[-*]\s+(.+)$/)?.[1];
    if (!item) continue;
    if (!current) {
      current = { heading: 'Améliorations', items: [] };
      sections.push(current);
    }
    if (current.items.length < 12) current.items.push(cleanMarkdown(item));
  }
  return sections.filter((section) => section.items.some(Boolean)).slice(0, 8);
}

@Injectable()
export class ServerReleaseService {
  private cache?: ReleaseSnapshot;
  private checking?: Promise<ReleaseSnapshot>;

  constructor(private readonly config: ConfigService) {}

  private buildInfoPath(): string {
    return (
      this.config.get<string>('MERGERON_BUILD_INFO_FILE') ??
      '/app/build-info.json'
    );
  }

  async installedBuild(): Promise<MergeronBuildInfo> {
    let file: Partial<MergeronBuildInfo> = {};
    try {
      file = JSON.parse(
        await readFile(this.buildInfoPath(), 'utf8'),
      ) as Partial<MergeronBuildInfo>;
    } catch {
      // Development installs do not have the image-generated file.
    }
    const channel =
      file.channel ?? this.config.get<string>('MERGERON_RELEASE_CHANNEL');
    return {
      version:
        file.version ?? this.config.get<string>('MERGERON_VERSION') ?? null,
      revision:
        file.revision ?? this.config.get<string>('MERGERON_REVISION') ?? null,
      builtAt:
        file.builtAt ?? this.config.get<string>('MERGERON_BUILD_DATE') ?? null,
      channel: channel === 'edge' || channel === 'stable' ? channel : 'unknown',
    };
  }

  /** Fixed-host request through curl so the deployment's configured egress proxy is honored. */
  protected async fetchPublishedReleases(): Promise<GithubRelease[]> {
    const { stdout } = await execute(
      'curl',
      [
        '--disable',
        '--silent',
        '--show-error',
        '--fail',
        '--location',
        '--max-time',
        '20',
        '--header',
        'Accept: application/vnd.github+json',
        '--header',
        'User-Agent: mergeron',
        RELEASES_API,
      ],
      { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const value: unknown = JSON.parse(stdout);
    if (!Array.isArray(value)) throw new Error('Invalid GitHub response');
    return value as GithubRelease[];
  }

  private async published(force: boolean): Promise<ReleaseSnapshot> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS)
      return this.cache;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const releases = (await this.fetchPublishedReleases())
        .flatMap((release): MergeronReleaseNote[] => {
          const match =
            typeof release.tag_name === 'string'
              ? release.tag_name.match(RELEASE_TAG)
              : null;
          if (!match || release.draft === true || release.prerelease === true)
            return [];
          const version = match[1];
          const officialUrl = `https://github.com/maxhugit/mergeron/releases/tag/v${version}`;
          return [
            {
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
              sections: extractMergeronReleaseSections(
                typeof release.body === 'string' ? release.body : '',
              ),
            },
          ];
        })
        .sort((left, right) => compareVersions(left.version, right.version));
      const latest = releases.at(-1);
      if (!latest) throw new Error('No stable Mergeron release is available');
      const snapshot = {
        latestVersion: latest.version,
        latestPublishedAt: latest.publishedAt,
        latestUrl: latest.url,
        releases,
        at: Date.now(),
      };
      this.cache = snapshot;
      return snapshot;
    })();
    try {
      return await this.checking;
    } finally {
      this.checking = undefined;
    }
  }

  async status(force = false) {
    const installed = await this.installedBuild();
    const checkedAt = new Date().toISOString();
    try {
      const published = await this.published(force);
      const comparable = Boolean(
        installed.version && RELEASE_TAG.test(`v${installed.version}`),
      );
      const comparison = comparable
        ? compareVersions(published.latestVersion, installed.version!)
        : null;
      const updateAvailable = comparison !== null && comparison > 0;
      const versionStatus = !comparable
        ? 'unknown'
        : updateAvailable
          ? 'update_available'
          : installed.channel === 'edge'
            ? 'edge'
            : comparison === 0
              ? 'current'
              : 'ahead';
      const releases = updateAvailable
        ? published.releases.filter(
            (release) =>
              compareVersions(release.version, installed.version!) > 0 &&
              compareVersions(release.version, published.latestVersion) <= 0,
          )
        : [];
      if (releases.length > MAX_RELEASES)
        throw new Error('Release range is too large to display safely');
      return {
        installed,
        latestVersion: published.latestVersion,
        latestPublishedAt: published.latestPublishedAt,
        latestUrl: published.latestUrl,
        updateAvailable,
        versionStatus,
        releases,
        checkedAt,
        checkError: null,
      };
    } catch {
      return {
        installed,
        latestVersion: null,
        latestPublishedAt: null,
        latestUrl: null,
        updateAvailable: false,
        versionStatus: 'unknown',
        releases: [] as MergeronReleaseNote[],
        checkedAt,
        checkError: 'unableToCheckForMergeronUpdates',
      };
    }
  }
}
