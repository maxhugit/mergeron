import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tar from 'tar-stream';
import { previewSnapshot, previewSourceFingerprint } from './preview-snapshot';

const roots: string[] = [];
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'mergeron-preview-snapshot-')),
  );
  roots.push(root);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  return { root, source, destination: path.join(root, 'source.tar') };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function read(archive: string) {
  const result: {
    name: string;
    uid: number | undefined;
    mode: number | undefined;
    text: string;
  }[] = [];
  const extract = tar.extract();
  const done = new Promise<void>((resolve, reject) => {
    extract.on('finish', resolve);
    extract.on('error', reject);
  });
  extract.on('entry', (header, stream, next) => {
    let text = '';
    stream.on('data', (s: Buffer) => {
      text += s.toString();
    });
    stream.on('end', () => {
      result.push({
        name: header.name,
        uid: header.uid,
        mode: header.mode,
        text,
      });
      next();
    });
    stream.resume();
  });
  extract.end(await fs.readFile(archive));
  await done;
  return result;
}
describe('filtered preview sources', () => {
  it('captures dirty files and nested/empty directories, with non-root writable permissions', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.source, 'src'));
    await fs.mkdir(path.join(f.source, 'empty'));
    await fs.writeFile(
      path.join(f.source, 'src', 'index.html'),
      '<h1>Uncommitted edit</h1>',
    );
    const one = await previewSnapshot(f.source, f.destination);
    const entries = await read(f.destination);
    expect(entries.find((v) => v.name === 'src/index.html')?.text).toContain(
      'Uncommitted edit',
    );
    expect(entries.find((v) => v.name === 'src/')?.uid).toBe(11002);
    expect(entries.find((v) => v.name === 'empty/')).toBeDefined();
    for (const e of entries) {
      expect(e.uid).toBe(11002);
      expect([0o600, 0o700]).toContain(e.mode);
    }
    const two = await previewSnapshot(
      f.source,
      path.join(f.root, 'second.tar'),
    );
    expect(two.sha256).toBe(one.sha256);
  });
  it('does not copy Git internals, secrets, dependency caches or data files', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, 'index.py'), 'print("test")');
    for (const name of [
      '.env',
      '.env.local',
      '.npmrc',
      '.netrc',
      'key.pem',
      'data.sqlite3',
    ])
      await fs.writeFile(path.join(f.source, name), 'secret');
    for (const name of ['.git', '.mergeron-system', 'node_modules', 'dist']) {
      await fs.mkdir(path.join(f.source, name));
      await fs.writeFile(path.join(f.source, name, 'hidden'), 'secret');
    }
    await previewSnapshot(f.source, f.destination);
    expect(
      (await read(f.destination))
        .filter((v) => !['.', './'].includes(v.name))
        .map((v) => v.name),
    ).toEqual(['index.py']);
  });
  it('rejects symlinks, hardlinks and symlinked intermediate source directories', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, 'index'), 'x');
    await fs.writeFile(path.join(f.root, 'outside'), 'not accessible');
    await fs.symlink(path.join(f.root, 'outside'), path.join(f.source, 'link'));
    await expect(previewSnapshot(f.source, f.destination)).rejects.toThrow(
      'PREVIEW_SOURCE_SYMLINK',
    );
    await fs.unlink(path.join(f.source, 'link'));
    await fs.link(path.join(f.root, 'outside'), path.join(f.source, 'link'));
    await expect(previewSnapshot(f.source, f.destination)).rejects.toThrow(
      'PREVIEW_UNSAFE_SOURCE',
    );
    await fs.unlink(path.join(f.source, 'link'));
    await fs.symlink(f.source, path.join(f.root, 'alias'));
    await expect(
      previewSourceFingerprint(path.join(f.root, 'alias')),
    ).rejects.toThrow('PREVIEW_UNSAFE_SOURCE');
  });
  it('includes nested logs source modules but not output logs or their data', async () => {
    const f = await fixture();
    const code = [
      'src/logs/logs.module.ts',
      'src/logs/log-retention.ts',
      'packages/api/src/logs/tests/logger.test.ts',
    ];
    const excluded = [
      'logs/app.ts',
      'logs/app.log',
      'src/logs/runtime.log',
      'src/logs/requests.json',
      'src/logs/events.ndjson',
      'src/logs/archive.gz',
      'src/logs/private.key',
      'src/logs/store.sqlite',
      'src/logs/.env',
      'src/logs/credentials/token.ts',
      'src/logs/node_modules/index.ts',
    ];
    for (const file of [...code, ...excluded]) {
      await fs.mkdir(path.dirname(path.join(f.source, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(f.source, file), 'fixture');
    }
    await previewSnapshot(f.source, f.destination);
    const names = (await read(f.destination)).map((v) => v.name);
    for (const file of code) expect(names).toContain(file);
    for (const file of excluded) expect(names).not.toContain(file);
    const before = await previewSourceFingerprint(f.source);
    await fs.writeFile(path.join(f.source, code[0]), 'changed source');
    expect(await previewSourceFingerprint(f.source)).not.toBe(before);
    const sourceChanged = await previewSourceFingerprint(f.source);
    await fs.writeFile(
      path.join(f.source, 'src/logs/requests.json'),
      'changed data',
    );
    expect(await previewSourceFingerprint(f.source)).toBe(sourceChanged);
  });
  it('does not permit links through the nested logs source exception', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.source, 'src/logs'), { recursive: true });
    const outside = path.join(f.root, 'outside.ts');
    const link = path.join(f.source, 'src/logs/link.ts');
    await fs.writeFile(outside, 'not accessible');
    await fs.symlink(outside, link);
    await expect(previewSnapshot(f.source, f.destination)).rejects.toThrow(
      'PREVIEW_SOURCE_SYMLINK',
    );
    await fs.unlink(link);
    await fs.link(outside, link);
    await expect(previewSnapshot(f.source, f.destination)).rejects.toThrow(
      'PREVIEW_UNSAFE_SOURCE',
    );
  });
  it('detects changes and never overwrites an existing temporary export', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, 'index'), 'old');
    const before = await previewSourceFingerprint(f.source);
    await fs.writeFile(path.join(f.source, 'index'), 'new');
    expect(await previewSourceFingerprint(f.source)).not.toBe(before);
    await fs.writeFile(f.destination + '.tmp', 'keep');
    await expect(previewSnapshot(f.source, f.destination)).rejects.toThrow();
    expect(await fs.readFile(f.destination + '.tmp', 'utf8')).toBe('keep');
  });
  it('honours revoked authorization before reading source', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, 'index'), 'x');
    await expect(
      previewSnapshot(f.source, f.destination, () => {
        throw Error('revoked');
      }),
    ).rejects.toThrow('revoked');
    expect(await fs.readdir(f.root)).toEqual(['source']);
  });
});
