import { describe, expect, it } from 'vitest';
import { filteredTestNetworkAvailable } from './agent-test-profile';
const network = {
  enabled: true,
  managedAllowedDomainsOnly: true,
  allowUpstreamProxy: true,
  allowLocalBinding: false,
  dangerouslyAllowAllUnixSockets: false,
  dangerouslyAllowNonLoopbackProxy: false,
  domains: {
    localhost: 'allow',
    '127.0.0.1': 'allow',
    'registry.npmjs.org': 'allow',
  },
};
describe('filtered test network prerequisites', () => {
  it('requires observed enforced constraints, not mere proxy configuration', () => {
    expect(filteredTestNetworkAvailable({ requirements: { network } })).toBe(
      true,
    );
    for (const response of [
      null,
      {},
      { requirements: null },
      { requirements: {} },
      { HTTPS_PROXY: 'http://proxy' },
    ])
      expect(filteredTestNetworkAvailable(response)).toBe(false);
  });
  it.each([
    { enabled: false },
    { managedAllowedDomainsOnly: false },
    { allowLocalBinding: true },
    { dangerouslyAllowAllUnixSockets: true },
    { dangerouslyAllowNonLoopbackProxy: true },
    { allowUpstreamProxy: false },
    { domains: { '*': 'allow', localhost: 'allow', '127.0.0.1': 'allow' } },
    { domains: { ...network.domains, '192.168.100.218': 'allow' } },
    { domains: { ...network.domains, 'evil.invalid': 'allow' } },
    { unixSockets: { '/var/run/docker.sock': 'allow' } },
    { allowUnixSockets: ['/var/run/docker.sock'] },
  ])('refuses wider or unconfirmed constraints: %j', (patch) => {
    expect(
      filteredTestNetworkAvailable({
        requirements: { network: { ...network, ...patch } },
      }),
    ).toBe(false);
  });
});
