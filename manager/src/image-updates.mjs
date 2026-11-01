/** Registry discovery only: never pull, replace or start a container here. */
import { installedImageBuild } from './installed-build.mjs';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const repository = (reference) =>
  String(reference)
    .split('@')[0]
    .replace(/:[^/:]+$/, '');
const sources = {
  application: 'ghcr.io/maxhugit/mergeron',
  ingress: 'nginx',
  egress: 'ubuntu/squid',
  browser: 'ghcr.io/maxhugit/mergeron-browser',
  manager: 'ghcr.io/maxhugit/mergeron-manager',
};
const notes = {
  application: 'https://github.com/maxhugit/mergeron/releases',
  ingress: 'https://nginx.org/en/CHANGES',
  egress: 'https://hub.docker.com/r/ubuntu/squid',
  browser:
    'https://github.com/maxhugit/mergeron/commits/main/deployment/browser',
};

export class ImageUpdates {
  constructor({ docker, manifest, configuration, inventory, now = Date.now }) {
    Object.assign(this, { docker, manifest, configuration, inventory, now });
    this.cache = null;
    this.pending = null;
  }

  async status(force = false) {
    if (!force && this.cache && this.now() - this.cache.at < 300_000)
      return this.cache.value;
    if (this.pending) return this.pending;
    this.pending = this.discover();
    try {
      const value = await this.pending;
      this.cache = { at: this.now(), value };
      return value;
    } finally {
      this.pending = null;
    }
  }

  async discover() {
    const inventory = await this.inventory();
    const components = await Promise.all(
      [
        ...this.manifest.components,
        ...(inventory.manager
          ? [
              {
                id: 'manager',
                displayName: 'Manager',
                allowedImageRepositories: [sources.manager],
              },
            ]
          : []),
      ].map(async (component) => {
        let current = inventory.components.find(
          (item) => item.id === component.id,
        );
        if (component.id === 'manager') {
          const matches = (
            (await this.docker.listContainers?.().catch(() => [])) ?? []
          ).filter((item) =>
            item.Names?.includes(`/${this.manifest.stack}-manager`),
          );
          current =
            matches.length === 1
              ? { containerId: matches[0].Id, adoption: 'managed' }
              : null;
        }
        const result = {
          id: component.id,
          displayName: component.displayName,
          installedImage: current?.image ?? null,
          installedDigest: null,
          installedImageId: null,
          installedBuild: null,
          platform: null,
          platformCheckRequired: false,
          targetImage: null,
          targetDigest: null,
          updateAvailable: false,
          versionStatus: 'unknown',
          notesUrl: notes[component.id] ?? null,
          notesAvailable: false,
          migrationAvailable: false,
          checkError: null,
        };
        try {
          if (!current?.containerId || current.adoption !== 'managed')
            throw new Error('notManaged');
          const inspect = await this.docker.inspectContainer(
            current.containerId,
          );
          const local = await this.docker.inspectImage(inspect.Image);
          if (local.Id === inspect.Image)
            result.installedBuild =
              current?.build ?? installedImageBuild(local, component.id);
          result.installedImage =
            inspect.Config?.Image ?? result.installedImage;
          result.installedImageId = digestPattern.test(
            local.Id ?? inspect.Image,
          )
            ? (local.Id ?? inspect.Image)
            : null;
          result.platform = {
            os: local.Os,
            architecture: local.Architecture,
            ...(local.Variant ? { variant: local.Variant } : {}),
          };
          const expected = sources[component.id];
          // Custom registries and arbitrary labels must not turn discovery into an SSRF proxy.
          if (
            !expected ||
            !component.allowedImageRepositories.includes(expected)
          )
            throw new Error('unsupportedSource');
          const defaultTag = ['application', 'browser', 'manager'].includes(
            component.id,
          )
            ? this.manifest.environment === 'development'
              ? 'edge'
              : 'latest'
            : component.id === 'ingress'
              ? 'stable'
              : 'latest';
          const configured = this.configuration.images[component.id];
          const moving = inspect.Config?.Image;
          const movingAllowed = !['application', 'browser'].includes(
            component.id,
          );
          const source =
            movingAllowed &&
            typeof moving === 'string' &&
            !moving.includes('@') &&
            repository(moving) === expected
              ? moving
              : typeof configured === 'string' &&
                  !configured.includes('@') &&
                  repository(configured) === expected
                ? configured
                : `${expected}:${defaultTag}`;
          if (
            !new RegExp(
              `^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$`,
            ).test(source)
          )
            throw new Error('unsupportedSource');
          result.targetImage = source;
          const remote = await this.docker.inspectDistribution(source);
          const digest = remote?.Descriptor?.digest;
          if (!digestPattern.test(digest ?? ''))
            throw new Error('invalidRegistryDigest');
          if (
            !Array.isArray(remote.Platforms) ||
            !remote.Platforms.some(
              (platform) =>
                platform.os === local.Os &&
                platform.architecture === local.Architecture &&
                (!local.Variant || platform.variant === local.Variant),
            )
          )
            throw new Error('unsupportedPlatform');
          result.targetDigest = digest;
          const canonical =
            expected === 'nginx'
              ? 'docker.io/library/nginx'
              : expected === 'ubuntu/squid'
                ? 'docker.io/ubuntu/squid'
                : expected;
          const installed = (local.RepoDigests ?? []).find((item) =>
            [expected, canonical].includes(item.split('@')[0]),
          );
          result.installedDigest = installed?.split('@')[1] ?? null;
          if (!digestPattern.test(result.installedDigest ?? '')) {
            // A known local DEV browser build can explicitly adopt a published image.
            // Never claim it is older: without a registry digest that comparison is impossible.
            result.migrationAvailable =
              component.id === 'browser' &&
              this.manifest.environment === 'development' &&
              (local.RepoTags ?? []).some(
                (tag) => repository(tag) === `${this.manifest.stack}-browser`,
              );
            throw new Error('installedDigestUnavailable');
          }
          // An OCI index can change only attestations or another platform.
          // The network-isolated Manager cannot resolve its child manifest:
          // the application bridge verifies metadata for this exact platform.
          // Until that evidence exists, never call an index change an upgrade.
          result.platformCheckRequired = result.installedDigest !== digest;
          result.versionStatus = result.platformCheckRequired
            ? 'unknown'
            : 'current';
          result.checkError = result.platformCheckRequired
            ? 'platformIdentityUnavailable'
            : null;
        } catch (error) {
          // Do not return registry responses, credentials or arbitrary Docker diagnostics.
          result.checkError = [
            'notManaged',
            'unsupportedSource',
            'installedDigestUnavailable',
          ].includes(error.message)
            ? error.message
            : 'registryUnavailable';
        }
        return result;
      }),
    );
    return { checkedAt: new Date(this.now()).toISOString(), components };
  }
}
