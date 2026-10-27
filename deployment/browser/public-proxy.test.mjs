import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicAddress, resolvePublic } from './public-proxy.mjs';
test('rejects internal, reserved, multicast and mapped IPv6 addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.20.0.2',
    '192.168.1.1',
    '100.64.1.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '198.18.0.1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('93.184.216.34'), true);
});
test('rejects mixed public/private DNS and returns a pinned address', async () => {
  await assert.rejects(
    resolvePublic('test', async () => [
      { address: '93.184.216.34' },
      { address: '127.0.0.1' },
    ]),
  );
  assert.equal(
    await resolvePublic('test', async () => [{ address: '93.184.216.34' }]),
    '93.184.216.34',
  );
});
