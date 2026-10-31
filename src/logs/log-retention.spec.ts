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
  it('archives an existing oversized audit file intact, then expires it only by the configured age', async () => {
    const original = 'x'.repeat(2 * 1024 * 1024);
    await writeFile(join(root, 'codex-jsonrpc.jsonl'), original);
    const policy = {
      ...DEFAULT_LOG_RETENTION,
      codex: { enabled: true, maxFiles: 5, maxAgeDays: 5, maxFileMiB: 1 },
    };
    configureLogRetention(policy);
    const stream = createCodexAuditStream(root);
    stream.end('next entry\n');
    await finished(stream);
    const archive = (await logStorageInventory(root)).find(
      (file) => !file.active,
    )!;
    expect(archive.bytes).toBe(original.length);
    expect(await readFile(join(root, archive.name), 'utf8')).toBe(original);
    await pruneLogArchives(policy, root, archive.modifiedAt + 4 * 86400000);
    expect(await readdir(root)).toContain(archive.name);
    await pruneLogArchives(policy, root, archive.modifiedAt + 6 * 86400000);
    expect(await readdir(root)).toEqual(['codex-jsonrpc.jsonl']);
    expect(await readFile(join(root, 'codex-jsonrpc.jsonl'), 'utf8')).toBe(
      'next entry\n',
    );
  });
  it('bounds audit archives by count while preserving the active log', async () => {
    const names = [
      'codex-jsonrpc.1-11111111-1111-1111-1111-111111111111.jsonl',
      'codex-jsonrpc.2-22222222-2222-2222-2222-222222222222.jsonl',
      'codex-jsonrpc.3-33333333-3333-3333-3333-333333333333.jsonl',
    ];
    const now = Date.now();
    for (const [index, name] of names.entries()) {
      await writeFile(join(root, name), name);
      await utimes(
        join(root, name),
        new Date(now + index * 1000),
        new Date(now + index * 1000),
      );
    }
    await writeFile(join(root, 'codex-jsonrpc.jsonl'), 'active');
    await writeFile(join(root, 'unknown.jsonl'), 'protected');
    await pruneLogArchives(
      {
        ...DEFAULT_LOG_RETENTION,
        codex: { enabled: true, maxFiles: 1, maxAgeDays: 5, maxFileMiB: 1 },
      },
      root,
      now + 3000,
    );
    expect((await readdir(root)).sort()).toEqual(
      [names[2], 'codex-jsonrpc.jsonl', 'unknown.jsonl'].sort(),
    );
  });
});
