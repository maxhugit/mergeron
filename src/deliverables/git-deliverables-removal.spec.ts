import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { digest, removeGitFile } from './git-deliverables-format';

describe('recoverable removal of reviewed Git deliverable bytes', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), 'git-removal-')),
    );
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, 'document.html'), 'reviewed');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const check = async () => {
    await Promise.resolve();
  };
  it('moves the reviewed file into private Git recovery and keeps a source record', async () => {
    const recovery = await removeGitFile(
      root,
      'document.html',
      digest('reviewed'),
      check,
    );
    await expect(fs.stat(path.join(root, 'document.html'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, recovery!), 'utf8')).toBe(
      'reviewed',
    );
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, recovery! + '.json'), 'utf8'),
      ),
    ).toMatchObject({
      source: 'document.html',
      reviewedSha256: digest('reviewed'),
    });
    expect(
      (await fs.stat(path.dirname(path.join(root, recovery!)))).mode & 0o077,
    ).toBe(0);
  });
  it('refuses unreviewed bytes before moving anything', async () => {
    await expect(
      removeGitFile(root, 'document.html', digest('other'), check),
    ).rejects.toThrow('GIT_DELIVERABLES_CHANGED');
    expect(await fs.readFile(path.join(root, 'document.html'), 'utf8')).toBe(
      'reviewed',
    );
  });
  it('rejects source symlinks and recovery directory symlinks', async () => {
    await fs.symlink('document.html', path.join(root, 'link.html'));
    await expect(
      removeGitFile(root, 'link.html', digest('reviewed'), check),
    ).rejects.toThrow('GIT_DELIVERABLES_UNSAFE_PATH');
    await fs.mkdir(path.join(root, 'outside'));
    await fs.symlink(
      path.join(root, 'outside'),
      path.join(root, '.git', 'mergeron-deliverable-recovery'),
    );
    await expect(
      removeGitFile(root, 'document.html', digest('reviewed'), check),
    ).rejects.toThrow('GIT_DELIVERABLES_UNSAFE_PATH');
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual([]);
  });
  it('restores late, unreviewed edits captured by the atomic move', async () => {
    const lateEdit = async () => {
      await fs.writeFile(path.join(root, 'document.html'), 'late work');
    };
    await expect(
      removeGitFile(root, 'document.html', digest('reviewed'), lateEdit),
    ).rejects.toThrow('GIT_DELIVERABLES_CHANGED');
    expect(await fs.readFile(path.join(root, 'document.html'), 'utf8')).toBe(
      'late work',
    );
  });
  it('keeps both files when the branch changes and another file takes the original path', async () => {
    let checks = 0;
    const context = async () => {
      if (++checks === 2) {
        await fs.writeFile(path.join(root, 'document.html'), 'new branch file');
        throw new Error('GIT_DELIVERABLES_BRANCH_CHANGED');
      }
    };
    await expect(
      removeGitFile(root, 'document.html', digest('reviewed'), context),
    ).rejects.toThrow('GIT_DELIVERABLES_DELETE_RECOVERY_REQUIRED');
    expect(await fs.readFile(path.join(root, 'document.html'), 'utf8')).toBe(
      'new branch file',
    );
    const recovery = path.join(root, '.git', 'mergeron-deliverable-recovery');
    const files = (await fs.readdir(recovery)).filter(
      (file) => !file.endsWith('.json'),
    );
    expect(files).toHaveLength(1);
    expect(await fs.readFile(path.join(recovery, files[0]), 'utf8')).toBe(
      'reviewed',
    );
  });
});
