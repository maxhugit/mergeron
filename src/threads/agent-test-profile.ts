/** Fail closed: a proxy environment variable is NOT evidence of enforcement.
 * The profile is advertised only when the running Core reports managed rules.
 * Older Core versions that omit network requirements are explicitly unsupported.
 */
const allowed = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'registry.npmjs.org',
  'nodejs.org',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
]);
export function filteredTestNetworkAvailable(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const requirements = (response as { requirements?: unknown }).requirements;
  if (!requirements || typeof requirements !== 'object') return false;
  const network = (requirements as { network?: unknown }).network;
  if (!network || typeof network !== 'object') return false;
  const rules = network as Record<string, unknown>;
  if (
    rules.enabled !== true ||
    rules.managedAllowedDomainsOnly !== true ||
    rules.allowUpstreamProxy !== true ||
    rules.allowLocalBinding !== false ||
    rules.dangerouslyAllowAllUnixSockets !== false ||
    rules.dangerouslyAllowNonLoopbackProxy !== false
  )
    return false;
  if (
    !rules.domains ||
    typeof rules.domains !== 'object' ||
    Array.isArray(rules.domains)
  )
    return false;
  const domains = rules.domains as Record<string, unknown>;
  return (
    domains.localhost === 'allow' &&
    domains['127.0.0.1'] === 'allow' &&
    Object.entries(domains).every(
      ([host, permission]) =>
        permission === 'deny' || (permission === 'allow' && allowed.has(host)),
    ) &&
    (!rules.unixSockets ||
      (typeof rules.unixSockets === 'object' &&
        !Array.isArray(rules.unixSockets) &&
        Object.values(rules.unixSockets).every((value) => value === 'deny'))) &&
    (!rules.allowUnixSockets ||
      (Array.isArray(rules.allowUnixSockets) &&
        rules.allowUnixSockets.length === 0))
  );
}
