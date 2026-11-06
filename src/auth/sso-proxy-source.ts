/** Provider-neutral contract; retain the historical ingress marker during upgrades. */
export const isSsoProxySource = (value: unknown): boolean =>
  value === 'sso-proxy' || value === 'authentik';
