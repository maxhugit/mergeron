import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RegistryImageIdentityService } from './registry-image-identity.service';

const imageId = `sha256:${'a'.repeat(64)}`;
const encode = (value: unknown) => {
  const raw = JSON.stringify(value);
  return {
    value,
    raw,
    digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
  };
};
const platform = { os: 'linux', architecture: 'amd64' };
function fixture(entries?: unknown[]) {
  const manifest = encode({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: imageId },
  });
  const index = encode({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: entries ?? [
      {
        platform: { os: 'linux', architecture: 'arm64' },
        digest: `sha256:${'b'.repeat(64)}`,
      },
      { platform, digest: manifest.digest },
      {
        platform: { os: 'unknown', architecture: 'unknown' },
        digest: `sha256:${'c'.repeat(64)}`,
      },
    ],
  });
  class Registry extends RegistryImageIdentityService {
    requests: { url: string; token?: string }[] = [];
    fail = false;
    corrupt = false;
    protected override async fetchMetadata(url: string, token?: string) {
      await Promise.resolve();
      this.requests.push({ url, token });
      if (this.fail) throw new Error('secret registry response');
      if (
        url.startsWith('https://auth.docker.io/') ||
        url.startsWith('https://ghcr.io/token')
      )
        return encode({ token: 'anonymous-pull-token' });
      const result = url.endsWith(index.digest) ? index : manifest;
      return this.corrupt ? { ...result, raw: 'tampered' } : result;
    }
  }
  return { service: new Registry(), index, manifest };
}
describe('read-only platform image identity', () => {
  it('reads only verified config metadata, and never mistakes a vendor distribution for its software version', async () => {
    const config = encode({
      created: '2026-11-01T10:00:00Z',
      config: {
        Env: ['TOKEN=never-export'],
        Labels: {
          'org.opencontainers.image.version': '24.04',
          'io.mergeron.version': '0.6.0',
          'org.opencontainers.image.revision': 'b'.repeat(40),
          'io.mergeron.channel': 'edge',
        },
      },
    });
    class Metadata extends RegistryImageIdentityService {
      corrupt = false;
      override imageId() {
        return Promise.resolve(config.digest);
      }
      protected override fetchMetadata(url: string) {
        return Promise.resolve(
          url.includes('/token')
            ? encode({ token: 'public-token' })
            : this.corrupt
              ? { ...config, raw: 'tampered' }
              : config,
        );
      }
    }
    const service = new Metadata();
    expect(
      await service.imageBuild(
        'manager',
        'ghcr.io/maxhugit/mergeron-manager:edge',
        config.digest,
        platform,
      ),
    ).toMatchObject({ version: '0.6.0', channel: 'edge' });
    const vendor = new Metadata();
    const metadata = await vendor.imageBuild(
      'egress',
      'ubuntu/squid:latest',
      config.digest,
      platform,
    );
    expect(metadata.version).toBeNull();
    expect(JSON.stringify(metadata)).not.toContain('never-export');
    const corrupt = new Metadata();
    corrupt.corrupt = true;
    await expect(
      corrupt.imageBuild(
        'browser',
        'ghcr.io/maxhugit/mergeron-browser:edge',
        config.digest,
        platform,
      ),
    ).rejects.toThrow('Config integrity failure');
  });
  it('selects the actual amd64 image, ignores arm64 and attestations, and caches immutable metadata', async () => {
    const { service, index, manifest } = fixture();
    expect(
      await service.imageId('ingress', 'nginx:stable', index.digest, platform),
    ).toBe(imageId);
    expect(service.requests.map((r) => r.url)).toEqual([
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull',
      `https://registry-1.docker.io/v2/library/nginx/manifests/${index.digest}`,
      `https://registry-1.docker.io/v2/library/nginx/manifests/${manifest.digest}`,
    ]);
    await service.imageId('ingress', 'nginx:stable', index.digest, platform);
    expect(service.requests).toHaveLength(3);
  });
  it('deduplicates concurrent resolutions without downloading image layers or configs', async () => {
    const { service, index } = fixture();
    await Promise.all(
      [1, 2, 3].map(() =>
        service.imageId(
          'browser',
          'ghcr.io/maxhugit/mergeron-browser:edge',
          index.digest,
          platform,
        ),
      ),
    );
    expect(service.requests).toHaveLength(3);
    expect(
      service.requests.every((r) => r.url.startsWith('https://ghcr.io/')),
    ).toBe(true);
    expect(service.requests.some((r) => r.url.includes('/blobs/'))).toBe(false);
  });
  it('supports a platform-specific manifest without treating its digest as an image ID', async () => {
    const { service, manifest } = fixture();
    expect(
      await service.imageId(
        'egress',
        'ubuntu/squid:latest',
        manifest.digest,
        platform,
      ),
    ).toBe(imageId);
  });
  it.each([
    ['ingress', 'http://localhost:1234', imageId, platform],
    ['ingress', 'nginx:stable/../../other', imageId, platform],
    ['unknown', 'nginx:stable', imageId, platform],
    ['constructor', 'undefined:latest', imageId, platform],
    ['ingress', 'nginx:stable', 'https://private.invalid', platform],
    [
      'ingress',
      'nginx:stable',
      imageId,
      { os: 'linux', architecture: '../../other' },
    ],
  ] as const)(
    'refuses untrusted destinations and paths before any request (%s, %s)',
    async (id, ref, digest, p) => {
      const { service } = fixture();
      await expect(service.imageId(id, ref, digest, p)).rejects.toThrow(
        'platformIdentityUnavailable',
      );
      expect(service.requests).toHaveLength(0);
    },
  );
  it('rejects a tampered index or manifest rather than comparing unverified metadata', async () => {
    const { service, index } = fixture();
    service.corrupt = true;
    await expect(
      service.imageId('ingress', 'nginx:stable', index.digest, platform),
    ).rejects.toThrow('platformIdentityUnavailable');
  });
  it('does not choose arbitrarily between platform variants', async () => {
    const { service, index } = fixture([
      { platform: { ...platform, variant: 'v1' }, digest: imageId },
      { platform: { ...platform, variant: 'v2' }, digest: imageId },
    ]);
    await expect(
      service.imageId('ingress', 'nginx:stable', index.digest, platform),
    ).rejects.toThrow('platformIdentityUnavailable');
    expect(service.requests).toHaveLength(2);
  });
  it('does not cache or disclose registry errors', async () => {
    const { service, index } = fixture();
    service.fail = true;
    await expect(
      service.imageId('ingress', 'nginx:stable', index.digest, platform),
    ).rejects.toThrow(/^platformIdentityUnavailable$/);
    service.fail = false;
    expect(
      await service.imageId('ingress', 'nginx:stable', index.digest, platform),
    ).toBe(imageId);
  });
});
