import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import {
  configureLogRetention,
  createCodexAuditStream,
  DEFAULT_LOG_RETENTION,
  logStorageInventory,
  pruneLogArchives,
  validateLogRetention,
} from './log-retention';

describe('log storage and retention', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mergeron-log-retention-'));
  });
  afterEach(async () => {
    configureLogRetention(DEFAULT_LOG_RETENTION);
    await rm(root, { recursive: true, force: true });
  });
  it('groups numbered files, measures sizes and protects the active app file', async () => {
    await writeFile(join(root, 'app.2.log'), 'old');
    await writeFile(join(root, 'app.10.log'), 'active');
    await writeFile(join(root, 'codex-jsonrpc.jsonl'), 'rpc');
    await writeFile(join(root, 'unknown.txt'), 'other');
    await symlink(join(root, 'unknown.txt'), join(root, 'app.100.log'));
    const files = await logStorageInventory(root);
    expect(files).toHaveLength(4);
    expect(files.reduce((total, file) => total + file.bytes, 0)).toBe(17);
    expect(files.find((file) => file.name === 'app.10.log')).toMatchObject({
      active: true,
      family: 'application',
    });
    expect(files.find((file) => file.name === 'app.2.log')?.active).toBe(false);
  });
  it('removes only expired/excess archives, never active files or unknown names', async () => {
    for (const name of [
      'app.1.log',
      'app.2.log',
      'app.3.log',
      'app.4.log',
      'codex-jsonrpc.jsonl',
      'notes.log',
    ])
      await writeFile(join(root, name), name);
    const old = new Date(Date.now() - 40 * 86400000);
    await utimes(join(root, 'app.1.log'), old, old);
    await utimes(join(root, 'app.4.log'), old, old);
    const policy = {
      ...DEFAULT_LOG_RETENTION,
      application: { enabled: true, maxFiles: 1, maxAgeDays: 30 },
    };
    await pruneLogArchives(policy, root);
    const names = await readdir(root);
    expect(names).toContain('app.4.log');
    expect(names).not.toContain('app.1.log');
    expect(names.filter((name) => /^app\./.test(name))).toHaveLength(2);
    expect(names).toContain('codex-jsonrpc.jsonl');
    expect(names).toContain('notes.log');
  });
  it('does not delete anything when retention is disabled', async () => {
    await writeFile(join(root, 'app.1.log'), 'one');
    await writeFile(join(root, 'app.2.log'), 'two');
    await pruneLogArchives(
      {
        ...DEFAULT_LOG_RETENTION,
        application: { ...DEFAULT_LOG_RETENTION.application, enabled: false },
      },
      root,
    );
    expect(await readdir(root)).toHaveLength(2);
  });
  it('rotates the audit stream dynamically and preserves concurrent client entries', async () => {
    const first = createCodexAuditStream(root);
    const second = createCodexAuditStream(root);
    configureLogRetention({
      ...DEFAULT_LOG_RETENTION,
      codex: { enabled: true, maxFiles: 5, maxAgeDays: 30, maxFileMiB: 1 },
    });
    await writeFile(join(root, 'codex-jsonrpc.jsonl'), 'x'.repeat(1024 * 1024));
    first.end('first\n');
    second.end('second\n');
    await Promise.all([finished(first), finished(second)]);
    const files = await logStorageInventory(root);
    expect(files.filter((file) => file.family === 'codex')).toHaveLength(2);
    const active = await readFile(join(root, 'codex-jsonrpc.jsonl'), 'utf8');
    expect(active).toContain('first\n');
    expect(active).toContain('second\n');
    const archive = files.find((file) => !file.active)!;
    expect(archive.bytes).toBe(1024 * 1024);
    await pruneLogArchives(
      {
        ...DEFAULT_LOG_RETENTION,
        codex: { enabled: true, maxFiles: 1, maxAgeDays: 1, maxFileMiB: 1 },
      },
      root,
      Date.now() + 2 * 86400000,
    );
    expect(await readdir(root)).toEqual(['codex-jsonrpc.jsonl']);
  });
  it.each([
    null,
    {},
    {
      ...DEFAULT_LOG_RETENTION,
      codex: { ...DEFAULT_LOG_RETENTION.codex, maxFileMiB: 0 },
    },
    {
      ...DEFAULT_LOG_RETENTION,
      application: { enabled: true, maxFiles: -1, maxAgeDays: 1 },
    },
  ])('rejects malformed policy %j', (value) => {
    expect(() => validateLogRetention(value)).toThrow();
  });
});
