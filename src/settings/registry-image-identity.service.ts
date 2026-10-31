/** Fixed public registries, immutable metadata only. Never pulls image layers. */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const indexTypes = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const manifestTypes = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const sources: Record<
  string,
  { repository: string; host: string; scope: string; auth: string }
> = {
  application: {
    repository: 'ghcr.io/maxhugit/mergeron',
    host: 'ghcr.io',
    scope: 'maxhugit/mergeron',
    auth: 'https://ghcr.io/token?service=ghcr.io',
  },
  browser: {
    repository: 'ghcr.io/maxhugit/mergeron-browser',
    host: 'ghcr.io',
    scope: 'maxhugit/mergeron-browser',
    auth: 'https://ghcr.io/token?service=ghcr.io',
  },
  ingress: {
    repository: 'nginx',
    host: 'registry-1.docker.io',
    scope: 'library/nginx',
    auth: 'https://auth.docker.io/token?service=registry.docker.io',
  },
  egress: {
    repository: 'ubuntu/squid',
    host: 'registry-1.docker.io',
    scope: 'ubuntu/squid',
    auth: 'https://auth.docker.io/token?service=registry.docker.io',
  },
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export interface ImagePlatform {
  os: string;
  architecture: string;
  variant?: string;
}

@Injectable()
export class RegistryImageIdentityService {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();

  protected async fetchMetadata(
    url: string,
    token?: string,
  ): Promise<{ raw: string; value: unknown }> {
    // No redirects, custom URL, registry credentials, insecure TLS or shell.
    // curl honors the application's existing filtered HTTPS proxy.
    const { stdout: raw } = await execute(
      'curl',
      [
        '--disable',
        '--silent',
        '--show-error',
        '--fail',
        '--proto',
        '=https',
        '--max-time',
        '8',
        '--header',
        'User-Agent: mergeron',
        '--header',
        'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
        ...(token ? ['--header', `Authorization: Bearer ${token}`] : []),
        url,
      ],
      { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return { raw, value: JSON.parse(raw) as unknown };
  }

  async imageId(
    id: string,
    reference: string,
    digest: string,
    platform: ImagePlatform,
  ): Promise<string> {
    const source = Object.hasOwn(sources, id) ? sources[id] : undefined;
    const prefix = source?.repository + ':';
    if (
      !source ||
      typeof reference !== 'string' ||
      !reference.startsWith(prefix) ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(
        reference.slice(prefix.length),
      ) ||
      !digestPattern.test(digest) ||
      platform?.os !== 'linux' ||
      !/^[a-z0-9_]{1,32}$/.test(platform.architecture ?? '') ||
      (platform.variant !== undefined &&
        !/^[a-zA-Z0-9_.-]{1,32}$/.test(platform.variant))
    )
      throw new Error('platformIdentityUnavailable');
    const key = `${id}:${digest}:${platform.os}/${platform.architecture}/${platform.variant ?? ''}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.resolve(source, digest, platform).then((value) => {
        if (this.cache.size >= 64) this.cache.clear();
        this.cache.set(key, value);
        return value;
      });
      this.pending.set(key, pending);
    }
    try {
      return await pending;
    } catch {
      throw new Error('platformIdentityUnavailable');
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }

  private async resolve(
    source: (typeof sources)[string],
    digest: string,
    platform: ImagePlatform,
  ) {
    const auth = await this.fetchMetadata(
      `${source.auth}&scope=repository:${source.scope}:pull`,
    );
    const token = object(auth.value).token;
    if (
      typeof token !== 'string' ||
      !token ||
      token.length > 16384 ||
      /[\r\n]/.test(token)
    )
      throw new Error('Invalid registry token');
    const read = async (selected: string) => {
      if (!digestPattern.test(selected)) throw new Error('Invalid digest');
      const result = await this.fetchMetadata(
        `https://${source.host}/v2/${source.scope}/manifests/${selected}`,
        token,
      );
      if (
        `sha256:${createHash('sha256').update(result.raw).digest('hex')}` !==
        selected
      )
        throw new Error('Manifest integrity failure');
      return object(result.value);
    };
    let manifest = await read(digest);
    if (manifest.schemaVersion !== 2) throw new Error('Unsupported schema');
    if (Array.isArray(manifest.manifests)) {
      if (!indexTypes.has(String(manifest.mediaType)))
        throw new Error('Unsupported index');
      const matches = manifest.manifests.map(object).filter((entry) => {
        const p = object(entry.platform);
        return (
          p.os === platform.os &&
          p.architecture === platform.architecture &&
          (p.variant ?? '') === (platform.variant ?? '')
        );
      });
      // Ambiguous variants and attestations must not select an arbitrary image.
      if (matches.length !== 1 || typeof matches[0].digest !== 'string')
        throw new Error('Unsupported platform');
      manifest = await read(matches[0].digest);
    }
    if (
      manifest.schemaVersion !== 2 ||
      !manifestTypes.has(String(manifest.mediaType))
    )
      throw new Error('Unsupported image manifest');
    const imageId = object(manifest.config).digest;
    if (!digestPattern.test(typeof imageId === 'string' ? imageId : ''))
      throw new Error('Invalid image identity');
    return imageId as string;
  }
}
