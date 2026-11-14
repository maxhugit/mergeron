import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { previewGitCommit, sourceReceipt } from './preview-source-receipt';
it('records the actual local commit without executing project code and leaves absent Git state unknown', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'preview-git-proof-'));
  try {
    expect(await previewGitCommit(root)).toBeNull();
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'first',
    ]);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    expect(await previewGitCommit(root)).toBe(head);
    const proof = sourceReceipt('a'.repeat(64), 'b'.repeat(64), 'copy', head);
    expect(proof).toMatchObject({
      copyId: 'copy',
      gitCommit: head,
      syncedAt: null,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
