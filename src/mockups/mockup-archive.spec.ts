import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mockupArchive } from './mockup-archive';
import { ZipArchiveAdapter } from '../archive/adapters/zip-archive.adapter';

it('produces an archive readable by the production archive adapter with UTF-8 HTML and a manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mockup-zip-'));
  try {
    const path = join(directory, 'maquette.zip');
    const html =
      '<h1>Équipe — été</h1><style>body{color:green}</style><script>const demo=true</script>';
    await writeFile(
      path,
      mockupArchive({ html, reference: { id: 'revision-source', number: 1 } }),
    );
    const adapter = new ZipArchiveAdapter();
    expect((await adapter.list(path)).map((e) => e.path)).toEqual([
      'index.html',
      'mergeron-mockup.json',
    ]);
    const stream = await adapter.openEntryStream(path, 'index.html');
    let contents = '';
    for await (const chunk of stream) contents += String(chunk);
    expect(contents).toBe(html);
    await expect(adapter.openEntryStream(path, '../outside')).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
