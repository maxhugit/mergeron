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
