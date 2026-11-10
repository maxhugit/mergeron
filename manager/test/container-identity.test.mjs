import assert from 'node:assert/strict';
import test from 'node:test';
import { specification } from '../src/updater.mjs';
const old = {
  Id: 'a'.repeat(64),
  Config: {
    Image: 'approved@sha256:' + 'b'.repeat(64),
    Labels: { custom: 'retained' },
    Env: ['SECRET=private'],
  },
  HostConfig: {
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
  },
  NetworkSettings: { Networks: {} },
};
test('updates restore managed identity on an adopted legacy container without changing protections', () => {
  const spec = specification(
    old,
    old.Config.Image,
    { id: 'application' },
    'stack',
  );
  assert.deepEqual(spec.Labels, {
    custom: 'retained',
    'io.mergeron.managed': 'true',
    'io.mergeron.stack': 'stack',
    'io.mergeron.component': 'application',
  });
  assert.deepEqual(spec.HostConfig, old.HostConfig);
  assert.deepEqual(spec.Env, old.Config.Env);
  assert.deepEqual(old.Config.Labels, { custom: 'retained' });
  assert.deepEqual(
    specification(old, old.Config.Image, { id: 'application' }).Labels,
    old.Config.Labels,
  );
});
test('updates never relabel a container claiming a different stack', () => {
  assert.throws(
    () =>
      specification(
        {
          ...old,
          Config: { ...old.Config, Labels: { 'io.mergeron.stack': 'other' } },
        },
        old.Config.Image,
        { id: 'application' },
        'stack',
      ),
    /updateComponentIdentityChanged/,
  );
});
