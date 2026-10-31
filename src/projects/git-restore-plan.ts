import { BadRequestException, ConflictException } from '@nestjs/common';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { WorkspaceGitService } from './workspace-git.service';

type Snapshot = Awaited<ReturnType<WorkspaceGitService['snapshot']>>;
type Record = { path: string; mode: string; data: Buffer; digest: string };
const unsafe = () => new ConflictException('GIT_RESTORE_UNSAFE');
const names = (text: string) => text.split('\0').filter(Boolean);

/** Reject filesystem indirection before asking Git to replace any path. */
async function safeFile(cwd: string, name: string) {
  const parts = name.split('/');
  if (
    !name ||
    name.length > 2048 ||
    /[\0\\:]/.test(name) ||
    path.isAbsolute(name) ||
    parts.some(
      (part) =>
        !part || part === '.' || part === '..' || part.toLowerCase() === '.git',
    )
  )
    throw unsafe();
  let target = cwd;
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1
        ? !stat.isDirectory()
        : !stat.isFile() || stat.nlink !== 1)
    )
      throw unsafe();
    if (index === parts.length - 1) return stat;
  }
  return null;
}

export async function planGitRestore(
  git: WorkspaceGitService,
  cwd: string,
  state: Snapshot,
  revision: string,
  selected?: string[],
) {
  const remote = selected === undefined;
  if (
    (
      await git.git(cwd, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'])
    ).trim() !== `refs/heads/${state.branch}` ||
    (
      await git.git(
        cwd,
        ['symbolic-ref', '--quiet', `refs/heads/${state.branch}`],
        {},
        15000,
        [0, 1],
      )
    ).trim()
  )
    throw unsafe();
  const parseTree = (text: string) =>
    new Map(
      names(text).map((entry) => {
        const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
        if (!match) throw unsafe(); // No gitlinks/submodules or special entries.
        return [match[3], match[1]];
      }),
    );
  const head = parseTree(
    await git.git(cwd, ['ls-tree', '-r', '-z', state.head]),
  );
  const target = remote
    ? parseTree(await git.git(cwd, ['ls-tree', '-r', '-z', revision]))
    : head;
  const index = new Map(
    names(await git.git(cwd, ['ls-files', '--stage', '-z'])).map((entry) => {
      const match = /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
      if (!match) throw unsafe();
      return [match[3], match[1]];
    }),
  );
  const changed = state.changes.filter((change) => change.status !== '??');
  if (
    selected &&
    (!selected.length ||
      selected.length > 100 ||
      new Set(selected).size !== selected.length ||
      selected.some((name) => !changed.some((change) => change.path === name)))
  )
    throw new BadRequestException('GIT_FILES_REQUIRED');
  const paths = remote
    ? [...new Set([...head.keys(), ...index.keys(), ...target.keys()])]
    : [
        ...new Set(
          selected.flatMap((name) => {
            const change = changed.find((item) => item.path === name)!;
            return [
              name,
              ...(change.originalPath ? [change.originalPath] : []),
            ];
          }),
        ),
      ];
  if (paths.length > 10000 || changed.length > 100) throw unsafe();
  const scope = new Set(paths);
  for (const [name, mode] of [...head, ...index, ...target])
    if (scope.has(name) && !['100644', '100755'].includes(mode)) throw unsafe();
  for (const entry of names(await git.git(cwd, ['ls-files', '-v', '-z'])))
    if (
      scope.has(entry.slice(2)) &&
      (entry[0] === 'S' || entry[0] !== entry[0].toUpperCase())
    )
      throw unsafe();
  for (const name of paths) await safeFile(cwd, name);
  const untracked = names(
    await git.git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  );
  const ignored = names(
    await git.git(cwd, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ]),
  ).map((name) => name.replace(/\/$/, ''));
  if (
    (remote
      ? [...target.keys()]
      : paths.filter((name) => target.has(name))
    ).some((name) =>
      [...untracked, ...ignored].some(
        (other) =>
          name === other ||
          name.startsWith(other + '/') ||
          other.startsWith(name + '/'),
      ),
    )
  )
    throw new ConflictException('GIT_RESTORE_COLLISION');
  // Freeze raw working bytes for both the review and the recovery branch. Git
  // filters, EOL conversion and repository programs cannot alter this backup.
  const records: Record[] = [];
  let total = 0;
  const changedPaths = [
    ...new Set(
      changed.flatMap((change) => [
        change.path,
        ...(change.originalPath ? [change.originalPath] : []),
      ]),
    ),
  ].sort();
  for (const name of changedPaths) {
    const stat = await safeFile(cwd, name);
    let data = Buffer.alloc(0),
      mode = '0';
    if (stat) {
      if (stat.size > 8 * 1024 * 1024 || total + stat.size > 16 * 1024 * 1024)
        throw unsafe();
      const file = await open(
        path.join(cwd, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const fresh = await file.stat();
        if (
          !fresh.isFile() ||
          fresh.nlink !== 1 ||
          fresh.size !== stat.size ||
          fresh.ino !== stat.ino
        )
          throw unsafe();
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const result = await file.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length !== stat.size) throw new ConflictException('GIT_STALE');
        data = Buffer.from(buffer.subarray(0, length));
        mode = stat.mode & 0o111 ? '100755' : '100644';
        total += data.length;
      } finally {
        await file.close();
      }
    }
    records.push({
      path: name,
      mode,
      data,
      digest: createHash('sha256').update(data).digest('hex'),
    });
  }
  const affected = remote
    ? [
        ...new Set([
          ...names(
            await git.git(cwd, [
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--no-renames',
              '--name-only',
              '-z',
              state.head,
              revision,
              '--',
            ]),
          ),
          ...changedPaths,
        ]),
      ].sort()
    : paths;
  const reviewFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        fingerprint: state.fingerprint,
        revision,
        paths,
        records: records.map(({ path, mode, digest }) => ({
          path,
          mode,
          digest,
        })),
        untracked: remote ? [...untracked, ...ignored].sort() : [],
      }),
    )
    .digest('hex');
  return {
    records,
    paths,
    reviewFingerprint,
    affected,
    preservedUntracked: untracked.length,
    localCommits: remote
      ? Number(
          (
            await git.git(cwd, [
              'rev-list',
              '--count',
              `${revision}..${state.head}`,
            ])
          ).trim(),
        )
      : 0,
  };
}

/** A normal local branch keeps the old HEAD, index parent and exact working tree
 * reachable across GC and container updates. Never a stash that clears files. */
export async function backupGitRestore(
  git: WorkspaceGitService,
  cwd: string,
  state: Snapshot,
  records: Record[],
  assertFresh: () => Promise<void>,
) {
  const branch = `mergeron-backup/${Date.now()}-${randomUUID().slice(0, 8)}`;
  let revision = state.head;
  const folder = await mkdtemp(path.join(tmpdir(), 'mergeron-restore-backup-'));
  try {
    if (records.length) {
      const index = path.join(folder, 'index');
      await writeFile(index, await readFile(path.join(cwd, '.git/index')), {
        mode: 0o600,
      });
      const env = {
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: 'Mergeron recovery',
        GIT_AUTHOR_EMAIL: 'recovery@mergeron.invalid',
        GIT_COMMITTER_NAME: 'Mergeron recovery',
        GIT_COMMITTER_EMAIL: 'recovery@mergeron.invalid',
      };
      const indexTree = (await git.git(cwd, ['write-tree'], env)).trim();
      const indexCommit = (
        await git.git(
          cwd,
          [
            '-c',
            'commit.gpgsign=false',
            'commit-tree',
            indexTree,
            '-p',
            state.head,
          ],
          env,
          15000,
          [0],
          Buffer.from('Mergeron recovery: prepared files\n'),
        )
      ).trim();
      let entries = '';
      for (const record of records) {
        const sha =
          record.mode === '0'
            ? '0'.repeat(state.head.length)
            : (
                await git.git(
                  cwd,
                  ['hash-object', '-w', '--no-filters', '--stdin'],
                  {},
                  15000,
                  [0],
                  record.data,
                )
              ).trim();
        entries += `${record.mode} ${sha}\t${record.path}\0`;
      }
      await git.git(
        cwd,
        ['update-index', '-z', '--index-info'],
        env,
        15000,
        [0],
        Buffer.from(entries),
      );
      const tree = (await git.git(cwd, ['write-tree'], env)).trim();
      revision = (
        await git.git(
          cwd,
          [
            '-c',
            'commit.gpgsign=false',
            'commit-tree',
            tree,
            '-p',
            state.head,
            '-p',
            indexCommit,
          ],
          env,
          15000,
          [0],
          Buffer.from('Mergeron recovery: working files before restore\n'),
        )
      ).trim();
    }
    await assertFresh();
    await git.git(
      cwd,
      ['update-ref', '--stdin'],
      {},
      15000,
      [0],
      Buffer.from(
        `verify refs/heads/${state.branch} ${state.head}\ncreate refs/heads/${branch} ${revision}\n`,
      ),
    );
    return { branch, revision };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
