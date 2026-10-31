/** Only metadata from the immutable image used by the container, never its
 * inherited container labels or the image currently pointed to by a tag. */
const revisionPattern = /^[a-f0-9]{40}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;

export function installedImageBuild(image, component) {
  const labels = image?.Config?.Labels ?? {};
  // Older browser images inherit Ubuntu's OCI version (e.g. 24.04).
  // Only an explicit Mergeron label identifies the browser product version.
  const version =
    labels['io.mergeron.version'] ??
    (component === 'browser'
      ? null
      : labels['org.opencontainers.image.version']);
  const revision = labels['org.opencontainers.image.revision'];
  const builtAt = labels['org.opencontainers.image.created'];
  const channel = labels['io.mergeron.channel'];
  const validVersion =
    typeof version === 'string' &&
    version.length <= 80 &&
    versionPattern.test(version);
  return {
    version: validVersion ? version : null,
    revision:
      typeof revision === 'string' && revisionPattern.test(revision)
        ? revision
        : null,
    builtAt:
      (component !== 'browser' || validVersion) &&
      typeof builtAt === 'string' &&
      builtAt.length <= 40 &&
      Number.isFinite(Date.parse(builtAt))
        ? new Date(builtAt).toISOString()
        : null,
    channel: ['edge', 'stable'].includes(channel) ? channel : 'unknown',
  };
}

export async function inspectInstalledBuild(docker, inspect, component) {
  if (!imageIdPattern.test(inspect.Image ?? '')) return null;
  try {
    const image = await docker.inspectImage(inspect.Image);
    if (image.Id !== inspect.Image) return null;
    return installedImageBuild(image, component);
  } catch {
    // Missing metadata must not turn a healthy installation into an outage.
    return null;
  }
}

/** Read-only self identification; the Manager is not a self-update target. */
export async function inspectManagerBuild(manifest, containers, docker) {
  const candidates = containers.filter((item) =>
    item.Names?.includes(`/${manifest.stack}-manager`),
  );
  if (candidates.length !== 1) return null;
  try {
    const inspect = await docker.inspectContainer(candidates[0].Id);
    const build = await inspectInstalledBuild(docker, inspect, 'manager');
    return build ? { build, imageId: inspect.Image } : null;
  } catch {
    return null;
  }
}
