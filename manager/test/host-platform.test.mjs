import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hostLabels,
  readHostIntegration,
  readAppdataRoot,
} from '../src/integrations/host-platform.mjs';

test('generic installations do not emit host UI metadata', () => {
  assert.equal(readHostIntegration({}), 'none');
  assert.deepEqual(
    hostLabels({ id: 'application' }, { hostIntegration: 'none' }),
    {},
  );
  assert.throws(
    () => readHostIntegration({ MERGERON_HOST_INTEGRATION: 'unexpected' }),
    /invalid/,
  );
});

test('the explicit host adapter retains native UI links without affecting generic installs', () => {
  const configuration = {
    hostIntegration: 'unraid',
    publicUrl: 'https://example.test',
    iconUrl: 'https://example.test/icon.png',
  };
  const labels = hostLabels({ id: 'application' }, configuration);
  assert.equal(labels['net.unraid.docker.webui'], configuration.publicUrl);
  assert.equal(labels['net.unraid.docker.shell'], '/bin/bash');
  assert.equal(
    hostLabels({ id: 'ingress' }, configuration)['net.unraid.docker.shell'],
    '/bin/sh',
  );
  assert.equal(
    readAppdataRoot({ MERGERON_UNRAID_APPDATA_ROOT: '/legacy' }, '/state'),
    '/legacy',
  );
  assert.equal(
    readAppdataRoot(
      {
        MERGERON_UNRAID_APPDATA_ROOT: '/legacy',
        MERGERON_APPDATA_ROOT: '/new',
      },
      '/state',
    ),
    '/new',
  );
});
