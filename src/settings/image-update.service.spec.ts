import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { arch } from 'node:os';
import {
  ImageUpdateService,
  type PublishedImage,
} from './image-update.service';
import { ServerReleaseService } from './server-release.service';
import { ManagerStatusService } from './manager-status.service';

const from = 'a'.repeat(40),
  to = 'b'.repeat(40);
const oldId = 'sha256:' + '1'.repeat(64),
  newId = 'sha256:' + '2'.repeat(64);
const image: PublishedImage = {
  digest: 'sha256:' + '3'.repeat(64),
  imageId: newId,
  revision: to,
  version: '0.1.0',
  builtAt: '2026-10-24T00:00:00Z',
};
const stable = {
  installed: {
    version: '0.1.0',
    revision: from,
    channel: 'stable',
    builtAt: null,
  },
  latestVersion: '0.1.0',
  latestUrl: 'https://github.com/maxhugit/mergeron/releases/tag/v0.1.0',
  latestPublishedAt: '2026-10-24T00:00:00Z',
  releases: [],
  checkError: null,
};

function fixture(environment = 'production', localId: string | null = oldId) {
  const releases = { status: vi.fn(() => Promise.resolve(stable)) };
  const manager = {
    status: vi.fn(() =>
      Promise.resolve({
        environment,
        components: [
          {
            id: 'application',
            imageId: localId,
            image: 'ghcr.io/maxhugit/mergeron:0.1.0',
          },
        ],
      }),
    ),
  };
  class Fixture extends ImageUpdateService {
    fetch = vi.fn(() => Promise.resolve(image));
    notes = vi.fn(() =>
      Promise.resolve({
        items: ['Corrige le canal de mise à jour.'],
        truncated: false,
      }),
    );
    protected override fetchImage(tag: 'edge' | 'latest') {
      void tag;
      return this.fetch();
    }
    protected override changes() {
      return this.notes();
    }
  }
  const service = new Fixture(
    releases as unknown as ServerReleaseService,
    manager as unknown as ManagerStatusService,
  );
  return { service, releases, manager };
}

describe('moving image tag discovery', () => {
  it('reports historical changes only for successful operations with exact recorded revisions', async () => {
    const { service } = fixture();
    const operation = {
      status: 'rolledBack',
      builds: {
        application: { from: { revision: from }, to: { revision: to } },
      },
    };
    expect(await service.operationChanges(operation)).toEqual({
      items: [],
      unavailable: true,
    });
    expect(service.notes).not.toHaveBeenCalled();
    expect(
      await service.operationChanges({ ...operation, status: 'succeeded' }),
    ).toMatchObject({
      unavailable: false,
      items: ['Corrige le canal de mise à jour.'],
    });
    expect(service.notes).toHaveBeenCalledTimes(1);
    expect(
      await service.operationChanges({
        status: 'succeeded',
        builds: {
          application: {
            from: { revision: 'https://private.invalid' },
            to: { revision: to },
          },
        },
      }),
    ).toEqual({ items: [], unavailable: true });
    expect(service.notes).toHaveBeenCalledTimes(1);
  });
  it.each(['production', 'development'])(
    'detects a new image without a version bump in %s',
    async (environment) => {
      const { service } = fixture(environment);
      const result = await service.status();
      expect(result).toMatchObject({
        targetImage: `ghcr.io/maxhugit/mergeron:${environment === 'development' ? 'edge' : 'latest'}`,
        updateAvailable: true,
        targetDigest: image.digest,
        latestRevision: to,
        checkError: null,
        releases: [
          { sections: [{ items: ['Corrige le canal de mise à jour.'] }] },
        ],
      });
    },
  );
  it('uses image identity rather than equal versions or stale container labels', async () => {
    const { service } = fixture('production', newId);
    expect(await service.status()).toMatchObject({
      updateAvailable: false,
      versionStatus: 'current',
    });
    expect(service.notes).not.toHaveBeenCalled();
  });
  it('never presents a newer GitHub release as an image that has not been published', async () => {
    const { service, releases } = fixture();
    releases.status.mockResolvedValue({ ...stable, latestVersion: '0.9.0' });
    expect(await service.status()).toMatchObject({
      latestVersion: image.version,
      latestRevision: image.revision,
      githubRelease: { version: '0.9.0' },
      installed: { version: '0.1.0', revision: from },
    });
  });
  it('keeps detection successful when change descriptions fail', async () => {
    const { service } = fixture();
    service.notes.mockRejectedValue(new Error('rate limited'));
    expect(await service.status()).toMatchObject({
      updateAvailable: true,
      checkError: null,
      changesError: true,
    });
  });
  it('reports unknown, never up to date, when registry discovery fails', async () => {
    const { service } = fixture();
    service.fetch.mockRejectedValue(new Error('offline'));
    expect(await service.status()).toMatchObject({
      updateAvailable: false,
      versionStatus: 'unknown',
      checkError: 'unableToCheckForMergeronUpdates',
      latestVersion: null,
      latestUrl: null,
      latestPublishedAt: null,
      githubRelease: { version: '0.1.0', url: stable.latestUrl },
    });
  });
  it('does not relabel the installed stable build as edge just because Dev tracks edge', async () => {
    const { service } = fixture('development');
    expect(await service.status()).toMatchObject({
      installed: { channel: 'stable', revision: from },
      targetChannel: 'edge',
      targetImage: 'ghcr.io/maxhugit/mergeron:edge',
    });
  });
  it('caches registry checks and supports an explicit refresh', async () => {
    const { service } = fixture();
    await Promise.all([service.status(), service.status()]);
    await service.status();
    expect(service.fetch).toHaveBeenCalledTimes(1);
    await service.status(true);
    expect(service.fetch).toHaveBeenCalledTimes(2);
  });
  it('falls back to revision comparison with an older Manager', async () => {
    const { service } = fixture('development', null);
    expect(await service.status()).toMatchObject({
      updateAvailable: true,
      targetImage: 'ghcr.io/maxhugit/mergeron:edge',
    });
  });
  it('marks truncated change descriptions', async () => {
    const { service } = fixture();
    service.notes.mockResolvedValue({ items: ['A change'], truncated: true });
    expect(await service.status()).toMatchObject({ changesTruncated: true });
  });
});

describe('registry metadata verification', () => {
  const encode = (value: unknown) => {
    const raw = JSON.stringify(value);
    return {
      value,
      raw,
      digest: 'sha256:' + createHash('sha256').update(raw).digest('hex'),
    };
  };
  it('selects the running platform from a multi-platform index and checks hashes without pulling layers', async () => {
    const config = encode({
      config: {
        Labels: {
          'org.opencontainers.image.revision': to,
          'org.opencontainers.image.version': '0.1.0',
        },
      },
      created: '2026-10-24T00:00:00Z',
    });
    const manifest = encode({ config: { digest: config.digest } });
    const index = encode({
      manifests: [
        {
          platform: {
            os: 'linux',
            architecture: arch() === 'x64' ? 'amd64' : arch(),
          },
          digest: manifest.digest,
        },
      ],
    });
    const responses = [
      encode({ token: 'public-token' }),
      index,
      manifest,
      config,
    ];
    class Registry extends ImageUpdateService {
      requests: string[] = [];
      protected override fetchJson(url: string) {
        this.requests.push(url);
        return Promise.resolve(responses.shift()!);
      }
      read() {
        return this.fetchImage('edge');
      }
    }
    const service = new Registry(
      {} as ServerReleaseService,
      {} as ManagerStatusService,
    );
    expect(await service.read()).toMatchObject({
      imageId: config.digest,
      digest: index.digest,
      revision: to,
    });
    expect(service.requests).toHaveLength(4);
    expect(
      service.requests.every((url) => url.startsWith('https://ghcr.io/')),
    ).toBe(true);
  });
  it('rejects a malformed remote digest before using it in a URL', async () => {
    const responses = [
      encode({ token: 'public-token' }),
      encode({ config: { digest: 'https://private.invalid/secret' } }),
    ];
    class Registry extends ImageUpdateService {
      protected override fetchJson() {
        return Promise.resolve(responses.shift()!);
      }
      read() {
        return this.fetchImage('latest');
      }
    }
    await expect(
      new Registry(
        {} as ServerReleaseService,
        {} as ManagerStatusService,
      ).read(),
    ).rejects.toThrow('Image identity unavailable');
  });
});

it('extracts bounded commit descriptions and caches immutable comparisons', async () => {
  class Notes extends ImageUpdateService {
    requests = 0;
    protected override fetchJson() {
      this.requests++;
      return Promise.resolve({
        value: {
          total_commits: 120,
          commits: [
            {
              commit: {
                message:
                  'Merge pull request #111 from fix/channel\n\nCorrect production update targets',
              },
            },
            {
              commit: {
                message: 'fix: clarify updates\nMore technical detail',
              },
            },
            { commit: { message: 42 } },
          ],
        },
        raw: '',
      });
    }
    read() {
      return this.changes(from, to);
    }
  }
  const service = new Notes(
    {} as ServerReleaseService,
    {} as ManagerStatusService,
  );
  expect(await service.read()).toEqual({
    items: ['Correct production update targets', 'fix: clarify updates'],
    truncated: true,
  });
  await service.read();
  expect(service.requests).toBe(1);
});

it.skipIf(process.env.MERGERON_REGISTRY_SMOKE !== '1')(
  'reads the real published edge and latest metadata without installing anything',
  async () => {
    class Registry extends ImageUpdateService {
      // The published Mergeron image targets amd64, even when this smoke test runs on macOS ARM.
      protected override imageArchitecture() {
        return 'amd64';
      }
      read(tag: 'edge' | 'latest') {
        return this.fetchImage(tag);
      }
    }
    const service = new Registry(
      {} as ServerReleaseService,
      {} as ManagerStatusService,
    );
    for (const tag of ['edge', 'latest'] as const) {
      const published = await service.read(tag);
      expect(published.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(published.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(published.revision).toMatch(/^[a-f0-9]{40}$/);
    }
  },
  90_000,
);

describe('installed image changes', () => {
  function installedFixture() {
    const installedBuild = vi.fn().mockResolvedValue({ revision: from });
    class Installed extends ImageUpdateService {
      reads: string[] = [];
      fail = false;
      wrongRevision = false;
      protected override fetchJson(url: string) {
        this.reads.push(url);
        if (this.fail)
          return Promise.reject(new Error('private GitHub response'));
        return Promise.resolve({
          raw: '',
          value: {
            sha: this.wrongRevision ? to : url.split('/').at(-1),
            commit: {
              message:
                'Merge pull request #123 from fix/issue\n\nCorrige la détection.',
            },
          },
        });
      }
    }
    return {
      installedBuild,
      service: new Installed(
        { installedBuild } as unknown as ServerReleaseService,
        {} as ManagerStatusService,
      ),
    };
  }
  it('keeps exact installed changes available even after the update is complete, with immutable caching', async () => {
    const { service, installedBuild } = installedFixture();
    expect(await service.installedChanges()).toEqual({
      revision: from,
      items: ['Corrige la détection.'],
      url: `https://github.com/maxhugit/mergeron/commit/${from}`,
      checkError: null,
    });
    await service.installedChanges();
    expect(service.reads).toHaveLength(1);
    installedBuild.mockResolvedValue({ revision: to });
    expect(await service.installedChanges()).toMatchObject({
      revision: to,
      items: ['Corrige la détection.'],
    });
    expect(service.reads.at(-1)).toBe(
      `https://api.github.com/repos/maxhugit/mergeron/commits/${to}`,
    );
  });
  it('keeps the installed history link when descriptions are unavailable, without exposing errors', async () => {
    const { service } = installedFixture();
    service.fail = true;
    expect(await service.installedChanges()).toEqual({
      revision: from,
      items: [],
      url: `https://github.com/maxhugit/mergeron/commit/${from}`,
      checkError: 'installedChangesUnavailable',
    });
  });
  it('does not display descriptions belonging to a different revision', async () => {
    const { service } = installedFixture();
    service.wrongRevision = true;
    expect(await service.installedChanges()).toMatchObject({
      items: [],
      checkError: 'installedChangesUnavailable',
    });
  });
  it('never constructs a URL from an unknown or invalid installed revision', async () => {
    const { service, installedBuild } = installedFixture();
    installedBuild.mockResolvedValue({ revision: 'https://private.invalid' });
    expect(await service.installedChanges()).toMatchObject({
      url: null,
      items: [],
    });
    expect(service.reads).toHaveLength(0);
  });
});
