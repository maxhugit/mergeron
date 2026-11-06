import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { probeManagerReadiness } from '../src/health-probe.mjs';
function client(body, statusCode = 200) {
  return {
    request(options, callback) {
      assert.equal(options.path, '/v1/status');
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () =>
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = statusCode;
          response.setEncoding = () => {};
          response.resume = () => {};
          callback(response);
          response.emit('data', JSON.stringify(body));
          response.emit('end');
        });
      return request;
    },
  };
}
const healthy = {
  stack: 'mergeron-dev',
  dockerConnected: true,
  adoption: { state: 'adopted' },
  dataSafety: { status: 'protected' },
  capabilities: { independentMonitor: true, managerReplacement: true },
};
test('requires a functional Manager with the expected stack, adoption and update capabilities', async () => {
  assert.equal(
    (
      await probeManagerReadiness({
        socketPath: '/unused',
        stack: 'mergeron-dev',
        client: client(healthy),
      })
    ).healthy,
    true,
  );
  for (const state of [
    { ...healthy, stack: 'mergeron' },
    { ...healthy, dockerConnected: false },
    { ...healthy, adoption: { state: 'drifted' } },
    { ...healthy, dataSafety: { status: 'blocked' } },
    { ...healthy, capabilities: { independentMonitor: true } },
  ])
    assert.equal(
      (
        await probeManagerReadiness({
          socketPath: '/unused',
          stack: 'mergeron-dev',
          client: client(state),
        })
      ).healthy,
      false,
    );
  assert.equal(
    (
      await probeManagerReadiness({
        socketPath: '/unused',
        stack: 'mergeron-dev',
        client: client(healthy, 503),
      })
    ).healthy,
    false,
  );
});

test('accepts an already managed stack without a record but rejects unmanaged, incomplete or drifted inventories', async () => {
  const recordless = {
    ...healthy,
    adoption: { state: 'eligible', canAdopt: false, blockers: [] },
    components: ['application', 'ingress', 'egress'].map((id) => ({
      id,
      containerId: id + '-container',
      adoption: 'managed',
      imageRepositoryAllowed: true,
      missingNetworks: [],
    })),
  };
  const probe = (status) =>
    probeManagerReadiness({
      socketPath: '/unused',
      stack: 'mergeron-dev',
      client: client(status),
    });
  assert.equal((await probe(recordless)).healthy, true);
  for (const state of [
    { ...recordless, adoption: { ...recordless.adoption, canAdopt: true } },
    { ...recordless, adoption: { ...recordless.adoption, state: 'drifted' } },
    {
      ...recordless,
      adoption: { ...recordless.adoption, blockers: ['adoptionRecordDrift'] },
    },
    { ...recordless, components: recordless.components.slice(1) },
    {
      ...recordless,
      components: recordless.components.map((c) =>
        c.id === 'application' ? { ...c, adoption: 'unmanaged' } : c,
      ),
    },
    {
      ...recordless,
      components: recordless.components.map((c) =>
        c.id === 'application' ? { ...c, imageRepositoryAllowed: false } : c,
      ),
    },
    {
      ...recordless,
      components: recordless.components.map((c) =>
        c.id === 'application'
          ? { ...c, missingNetworks: ['private-network'] }
          : c,
      ),
    },
  ])
    assert.equal((await probe(state)).healthy, false);
});
