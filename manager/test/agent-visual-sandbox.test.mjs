import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { agentVisualSandbox } from '../src/agent-visual-sandbox.mjs';

const options = {
  environment: 'development',
  component: 'application',
  labels: { 'io.mergeron.agent-visual-testing': '1' },
};
const rule = { names: ['clone', 'unshare', 'setns'], action: 'SCMP_ACT_ALLOW' };
const profile = { defaultAction: 'SCMP_ACT_ERRNO', syscalls: [rule] };
const host = () => ({
  ReadonlyRootfs: true,
  CapDrop: ['ALL'],
  CapAdd: [],
  SecurityOpt: ['no-new-privileges:true', `seccomp=${JSON.stringify(profile)}`],
  NetworkMode: 'bridge',
  Tmpfs: { '/tmp': 'rw,size=512m' },
});

test('DEV opt-in adds only namespace-local chroot without mutating rollback configuration', () => {
  const original = host();
  const migrated = agentVisualSandbox(original, options);
  assert.notEqual(migrated, original);
  assert.deepEqual(
    { ...migrated, SecurityOpt: original.SecurityOpt },
    original,
  );
  const updated = JSON.parse(migrated.SecurityOpt[1].slice(8));
  assert.deepEqual(updated.syscalls.slice(0, -1), profile.syscalls);
  assert.deepEqual(updated.syscalls.at(-1).names, ['chroot']);
  assert.equal(JSON.parse(original.SecurityOpt[1].slice(8)).syscalls.length, 1);
  assert.equal(agentVisualSandbox(migrated, options), migrated);
});

test('production, other components and old images remain strictly unchanged', () => {
  const original = host();
  for (const override of [
    { environment: 'production' },
    { component: 'browser' },
    { labels: {} },
  ]) {
    assert.equal(
      agentVisualSandbox(original, { ...options, ...override }),
      original,
    );
  }
});

test('rejects missing namespaces, explicit denial or relaxed isolation', () => {
  for (const override of [
    { Privileged: true },
    { ReadonlyRootfs: false },
    { CapAdd: ['SYS_ADMIN'] },
    { SecurityOpt: ['seccomp=unconfined'] },
  ]) {
    assert.throws(
      () => agentVisualSandbox({ ...host(), ...override }, options),
      /updateAgentSandbox/,
    );
  }
  for (const syscalls of [
    [],
    [rule, { names: ['chroot'], action: 'SCMP_ACT_ERRNO' }],
  ]) {
    const original = host();
    original.SecurityOpt[1] = `seccomp=${JSON.stringify({ ...profile, syscalls })}`;
    assert.throws(
      () => agentVisualSandbox(original, options),
      /updateAgentSandbox/,
    );
  }
});

test('checked-in deployment profile is already compatible and stays restricted', () => {
  const original = host();
  original.SecurityOpt[1] = `seccomp=${readFileSync(new URL('../../deployment/config/seccomp-bwrap.json', import.meta.url), 'utf8')}`;
  assert.equal(agentVisualSandbox(original, options), original);
  assert.equal(
    JSON.parse(original.SecurityOpt[1].slice(8)).defaultAction,
    'SCMP_ACT_ERRNO',
  );
});
