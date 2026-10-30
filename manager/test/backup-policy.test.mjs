import assert from 'node:assert/strict';
import test from 'node:test';
import {
  environmentBackupPolicy,
  recordedBackupPolicy,
  backupEntries,
  excludesBackupDirectory,
  DEV_NO_BACKUP,
  PRODUCTION_ESSENTIAL,
  LEGACY_FULL,
} from '../src/backup-policy.mjs';

test('environment policy is mandatory and cannot disable production backup', () => {
  assert.equal(
    environmentBackupPolicy({
      environment: 'development',
      stack: 'mergeron-dev',
    }),
    DEV_NO_BACKUP,
  );
  assert.equal(
    environmentBackupPolicy({ environment: 'production', stack: 'mergeron' }),
    PRODUCTION_ESSENTIAL,
  );
  assert.deepEqual(backupEntries(DEV_NO_BACKUP), []);
  assert.ok(backupEntries(PRODUCTION_ESSENTIAL).includes('workspace'));
  assert.ok(!backupEntries(PRODUCTION_ESSENTIAL).includes('logs'));
  for (const manifest of [
    {},
    { environment: 'development', stack: 'mergeron' },
  ])
    assert.throws(() => environmentBackupPolicy(manifest), /PolicyInvalid/);
});

test('historical records retain full recovery and unknown policies fail closed', () => {
  assert.equal(recordedBackupPolicy({}), LEGACY_FULL);
  assert.ok(backupEntries(LEGACY_FULL).includes('logs'));
  for (const backupPolicy of [null, 'none', 'future-v2', {}, true])
    assert.throws(
      () => recordedBackupPolicy({ backupPolicy }),
      /PolicyInvalid/,
    );
  assert.throws(
    () =>
      recordedBackupPolicy({
        backupPolicy: DEV_NO_BACKUP,
        environment: 'production',
      }),
    /PolicyInvalid/,
  );
  assert.throws(
    () =>
      recordedBackupPolicy({
        backupPolicy: PRODUCTION_ESSENTIAL,
        environment: 'development',
      }),
    /PolicyInvalid/,
  );
});

test('essential selection preserves documents, historical versions, drafts and unclassified work', () => {
  for (const relative of [
    'workspace/project/documents/node_modules',
    'workspace/project/livrables/__pycache__',
    'workspace/.mergeron-system/project/history/node_modules',
    'workspace/.mergeron-agent-drafts/project/node_modules',
    'workspace/project/sources/repo/.git',
    'workspace/project/sources/repo/dist',
    'workspace/project/sources/repo/build',
    'workspace/project/.mergeron/history/node_modules',
    'workspace/project/.webui/history/__pycache__',
    'workspace/project/.agent-document-drafts/node_modules',
    'home/.codex/sessions',
  ])
    assert.equal(
      excludesBackupDirectory(PRODUCTION_ESSENTIAL, relative),
      false,
      relative,
    );
  for (const relative of [
    'home/.cache',
    'home/.npm',
    'home/.local/share/pnpm/store',
    'workspace/project/sources/repo/node_modules',
    'workspace/project/sources/repo/.build-cache',
    'workspace/project/sources/repo/__pycache__',
    'workspace/.mergeron-system/project/previews',
  ]) {
    assert.equal(
      excludesBackupDirectory(PRODUCTION_ESSENTIAL, relative),
      true,
      relative,
    );
    assert.equal(
      excludesBackupDirectory(LEGACY_FULL, relative),
      false,
      relative,
    );
  }
});
