// Fixture-only private IPC. Not copied into the Manager image or exposed over HTTP.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = process.env.MERGERON_LOAD_CODE_ROOT;
assert.ok(['/opt/mergeron-manager', '/fixture/manager'].includes(root));
assert.ok(process.send);
await import(pathToFileURL(`${root}/src/server.mjs`).href);
const { createBackupArchive, extractBackupArchive } = await import(
  pathToFileURL(`${root}/src/backup-archive.mjs`).href
);
process.once('message', async (request) => {
  if (
    request?.action !== 'compress' ||
    !/^[a-f0-9]{64}$/.test(request.dataSha ?? '')
  )
    process.exit(2);
  try {
    const descriptor = await createBackupArchive({
      root: '/fixture/archive-input',
      path: '/fixture/synthetic-backup.tar.gz',
      roots: ['home'],
      policy: 'full-v1',
    });
    await extractBackupArchive({
      path: '/fixture/synthetic-backup.tar.gz',
      destination: '/fixture/archive-restored',
      descriptor,
      roots: ['home'],
    });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(
      '/fixture/archive-restored/home/database',
    ))
      hash.update(chunk);
    assert.equal(hash.digest('hex'), request.dataSha);
    process.send({ ok: true, bytes: descriptor.bytes, restored: true });
  } catch {
    process.send({ ok: false });
  }
});
