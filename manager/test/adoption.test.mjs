import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ADOPTION_CONFIRMATION,
  confirmAdoption,
  evaluateAdoption,
  readAdoptionRecord,
} from '../src/adoption.mjs';

function inventory(overrides = {}) {
  return {
    schemaVersion: 1,
    stack: 'mergeron',
    environment: 'production',
    mode: 'observe',
    observedAt: '2026-10-24T09:00:00.000Z',
    dockerConnected: true,
    components: [
      {
        id: 'application',
        containerId: 'application-full-id',
        containerName: 'mergeron-ui',
        image: 'ghcr.io/maxhugit/mergeron:edge',
        imageRepositoryAllowed: true,
        adoption: 'adoptable',
        networks: ['mergeron-admin', 'mergeron-isolated'],
        missingNetworks: [],
        protectedMounts: [
          {
            target: '/home/codex',
            source: '/srv/mergeron/state/home',
            type: 'bind',
            writable: true,
          },
          {
            target: '/workspaces',
            source: '/srv/mergeron/state/workspace',
            type: 'bind',
            writable: true,
          },
        ],
      },
      {
        id: 'ingress',
        containerId: 'ingress-full-id',
        containerName: 'mergeron-ingress',
        image: 'nginx:stable',
        imageRepositoryAllowed: true,
        adoption: 'adoptable',
        networks: ['mergeron-isolated', 'mergeron-proxy'],
        missingNetworks: [],
        protectedMounts: [],
      },
      {
        id: 'egress',
        containerId: 'egress-full-id',
        containerName: 'mergeron-squid',
        image: 'ubuntu/squid:latest',
        imageRepositoryAllowed: true,
        adoption: 'adoptable',
        networks: ['mergeron-external', 'mergeron-isolated'],
        missingNetworks: [],
        protectedMounts: [],
      },
    ],
    dataSafety: {
      status: 'protected',
      blockers: [],
      protectedMounts: [],
    },
    ...overrides,
  };
}

function legacyRecord(value) {
  const snapshot = {
    schemaVersion: 1,
    stack: value.stack,
    components: [...value.components]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((component) => ({
        id: component.id,
        containerId: component.containerId,
        containerName: component.containerName,
        image: component.image,
        networks: [...component.networks].sort(),
        protectedMounts: [...component.protectedMounts]
          .sort((left, right) => left.target.localeCompare(right.target))
          .map((mount) => ({
            target: mount.target,
            source: mount.source,
            type: mount.type,
            writable: mount.writable,
          })),
      })),
  };
  return {
    ...snapshot,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex'),
    adoptedAt: '2026-10-24T08:00:00.000Z',
  };
}

test('marks one complete and protected installation as eligible', () => {
  const result = evaluateAdoption(inventory());
  assert.equal(result.adoption.state, 'eligible');
  assert.equal(result.adoption.canAdopt, true);
  assert.match(result.adoption.fingerprint, /^[a-f0-9]{64}$/);
});

test('does not offer adoption when all three components are already managed', async () => {
  const value = inventory();
  for (const component of value.components) component.adoption = 'managed';
  assert.equal(evaluateAdoption(value).adoption.canAdopt, false);
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-managed-adoption-'));
  const path = join(directory, 'adoption.json');
  try {
    await assert.rejects(
      confirmAdoption({
        inventory: value,
        confirmation: ADOPTION_CONFIRMATION,
        expectedFingerprint: evaluateAdoption(value).adoption.fingerprint,
        path,
      }),
      /adoptionBlocked/,
    );
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('still offers adoption for a legacy installation with a mix of managed and unmanaged components', () => {
  const value = inventory();
  value.components[1].adoption = 'managed';
  assert.equal(evaluateAdoption(value).adoption.canAdopt, true);
});

for (const schemaVersion of [1, 2])
  test(`optional managed browser extends only an unchanged adopted production stack (schema ${schemaVersion})`, () => {
    const original = inventory();
    const record = legacyRecord(original);
    if (schemaVersion === 2) {
      record.schemaVersion = 2;
      record.environment = 'production';
      record.fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            schemaVersion: 2,
            stack: record.stack,
            environment: record.environment,
            components: record.components,
          }),
        )
        .digest('hex');
    }
    const extension = {
      ...original,
      components: [
        ...original.components,
        {
          id: 'browser',
          containerId: 'browser-id',
          containerName: 'mergeron-browser',
          image: 'ghcr.io/maxhugit/mergeron-browser@sha256:' + 'a'.repeat(64),
          imageRepositoryAllowed: true,
          adoption: 'managed',
          networks: ['mergeron-browser-control', 'mergeron-browser-egress'],
          missingNetworks: [],
          protectedMounts: [],
        },
      ],
    };
    const originalRecord = JSON.stringify(record);
    assert.equal(evaluateAdoption(extension, record).adoption.state, 'adopted');
    assert.equal(JSON.stringify(record), originalRecord);
    for (const mutate of [
      (v) => {
        v.components[0].containerId = 'unexpected';
      },
      (v) => {
        v.components[0].networks.push('other');
      },
      (v) => {
        v.components[3].adoption = 'adoptable';
      },
      (v) => {
        v.components[3].networks.push('other');
      },
      (v) => {
        v.components[3].containerName = 'another-browser';
      },
      (v) => {
        v.components[3].imageRepositoryAllowed = false;
      },
      (v) => {
        v.components[3].missingNetworks.push('mergeron-browser-control');
      },
    ]) {
      const invalid = structuredClone(extension);
      mutate(invalid);
      assert.equal(evaluateAdoption(invalid, record).adoption.state, 'drifted');
    }
  });

test('blocks adoption when a required network or protected mount is missing', () => {
  const value = inventory();
  value.components[1].missingNetworks = ['mergeron-proxy'];
  value.dataSafety.blockers = ['application:/workspaces:unprotected'];
  const result = evaluateAdoption(value);
  assert.equal(result.adoption.state, 'blocked');
  assert.deepEqual(result.adoption.blockers, [
    'application:/workspaces:unprotected',
    'ingress:mergeron-proxy:networkMissing',
  ]);
});

test('persists the exact verified inventory only after explicit confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-adoption-'));
  const path = join(directory, 'adoption.json');
  try {
    const current = evaluateAdoption(inventory());
    const adopted = await confirmAdoption({
      inventory: inventory(),
      existingRecord: null,
      confirmation: ADOPTION_CONFIRMATION,
      expectedFingerprint: current.adoption.fingerprint,
      path,
      now: new Date('2026-10-24T09:05:00.000Z'),
    });
    assert.equal(adopted.adoption.state, 'adopted');
    assert.equal(adopted.adoption.adoptedAt, '2026-10-24T09:05:00.000Z');
    const record = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.environment, 'production');
    assert.equal(record.fingerprint, current.adoption.fingerprint);
    assert.equal(
      record.components[0].protectedMounts[0].source,
      '/srv/mergeron/state/home',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps a schema 1 production adoption from PR #103 valid without rewriting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-adoption-'));
  const path = join(directory, 'adoption.json');
  try {
    const original = `${JSON.stringify(legacyRecord(inventory()), null, 2)}\n`;
    await writeFile(path, original, { mode: 0o600 });
    const record = await readAdoptionRecord(path);
    const adopted = evaluateAdoption(inventory(), record);
    assert.equal(adopted.adoption.state, 'adopted');
    assert.equal(adopted.adoption.adoptedAt, '2026-10-24T08:00:00.000Z');
    assert.equal(await readFile(path, 'utf8'), original);

    const development = inventory({
      stack: 'mergeron-dev',
      environment: 'development',
    });
    assert.equal(
      evaluateAdoption(development, record).adoption.state,
      'drifted',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses a stale preview and detects later drift without overwriting the record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mergeron-adoption-'));
  const path = join(directory, 'adoption.json');
  try {
    await assert.rejects(
      confirmAdoption({
        inventory: inventory(),
        existingRecord: null,
        confirmation: ADOPTION_CONFIRMATION,
        expectedFingerprint: 'stale',
        path,
      }),
      /adoptionInventoryChanged/,
    );
    const current = evaluateAdoption(inventory());
    await confirmAdoption({
      inventory: inventory(),
      existingRecord: null,
      confirmation: ADOPTION_CONFIRMATION,
      expectedFingerprint: current.adoption.fingerprint,
      path,
    });
    const record = await readAdoptionRecord(path);
    const changed = inventory();
    changed.components[0].image = 'ghcr.io/maxhugit/mergeron:other';
    const drifted = evaluateAdoption(changed, record);
    assert.equal(drifted.adoption.state, 'drifted');
    assert.ok(drifted.adoption.blockers.includes('adoptionRecordDrift'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
