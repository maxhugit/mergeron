import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

export const gitDocumentLimit = 100 * 1024 * 1024;
export const largeGitDocument = 10 * 1024 * 1024;
export const gitDeliverablesIndex = '.mergeron-deliverables.json';
export async function readGitDeliverablesIndex(root: string) {
  const raw = await readGitFile(root, gitDeliverablesIndex, 2048);
  if (!raw) return null;
  try {
    const data = z
      .object({
        format: z.literal('mergeron-deliverables-index'),
        version: z.literal(1),
        directory: z.string().transform(relativeGitDirectory),
      })
      .strict()
      .parse(JSON.parse(raw.toString('utf8')));
    return { directory: data.directory, hash: digest(raw) };
  } catch {
    throw new BadRequestException('GIT_DELIVERABLES_INVALID_INDEX');
  }
}
const id = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/)
  .refine((s) => !Object.hasOwn(Object.prototype, s) && s !== 'prototype');
const hasControl = (s: string) =>
  Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const name = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) =>
      !/[\\/]/.test(s) &&
      !hasControl(s) &&
      Buffer.byteLength(s) <= 255 &&
      !s.startsWith('.') &&
      s !== 'livrable.json',
  );
const label = z.string().trim().min(1).max(80);
export const manifestSchema = z
  .object({
    format: z.literal('mergeron-deliverable'),
    version: z.literal(1),
    id,
    title: z.string().trim().min(1).max(160),
    description: z.string().max(20000),
    labels: z.array(label).max(50),
    documents: z
      .array(
        z.object({ id, path: name, labels: z.array(label).max(10) }).strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (
      new Set(m.documents.map((d) => d.id)).size !== m.documents.length ||
      new Set(m.documents.map((d) => d.path.toLocaleLowerCase())).size !==
        m.documents.length ||
      new Set(m.labels.map((l) => l.toLocaleLowerCase())).size !==
        m.labels.length ||
      m.documents.some((d) => d.labels.some((l) => !m.labels.includes(l)))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate identities, names or unknown labels',
      });
  });
export type GitDeliverableManifest = z.infer<typeof manifestSchema>;
export const digest = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

export function relativeGitDirectory(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    !value ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    value
      .split('/')
      .some((p) => !p || p.startsWith('.') || !/^[\p{L}\p{N}_ -]+$/u.test(p))
  )
    throw new BadRequestException('GIT_DELIVERABLES_INVALID_DIRECTORY');
  return value;
}

/** Every component is checked; a repository cannot redirect us via symlinks. */
export async function gitChild(
  root: string,
  relative: string,
  create = false,
): Promise<string> {
  const parts = relative.split('/');
  if (
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        p === '.git' ||
        p.includes('\\') ||
        hasControl(p),
    )
  )
    throw new BadRequestException('GIT_DELIVERABLES_UNSAFE_PATH');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let entry = await fs
      .lstat(current)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (!entry && create && i < parts.length - 1) {
      await fs.mkdir(current, { mode: 0o750 });
      entry = await fs.lstat(current);
    }
    if (
      entry?.isSymbolicLink() ||
      (entry && i < parts.length - 1 && !entry.isDirectory())
    )
      throw new BadRequestException('GIT_DELIVERABLES_UNSAFE_PATH');
  }
  return current;
}

export async function readGitFile(
  root: string,
  relative: string,
  limit = gitDocumentLimit,
): Promise<Buffer | null> {
  const target = await gitChild(root, relative);
  const handle = await fs
    .open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (!handle) return null;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit)
      throw new BadRequestException('GIT_DELIVERABLES_FILE_LIMIT');
    const data = await handle.readFile();
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      data.length > limit
    )
      throw new ConflictException('GIT_DELIVERABLES_CHANGED');
    return data;
  } finally {
    await handle.close();
  }
}

export async function writeGitFile(
  root: string,
  relative: string,
  content: Buffer,
  expected: string | null,
) {
  const target = await gitChild(root, relative, true);
  const current = await readGitFile(root, relative);
  if ((current ? digest(current) : null) !== expected)
    throw new ConflictException('GIT_DELIVERABLES_CHANGED');
  const temporary = target + '.mergeron-' + randomUUID();
  try {
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o640 });
    const latest = await readGitFile(root, relative);
    if ((latest ? digest(latest) : null) !== expected)
      throw new ConflictException('GIT_DELIVERABLES_CHANGED');
    await gitChild(root, relative);
    if (expected === null) {
      await fs.link(temporary, target); // exclusive: never replace an unrelated file
      await fs.unlink(temporary);
    } else await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Remove only the reviewed bytes, retaining an atomic, private recovery copy.
 * A late edit or branch change restores the moved file without replacing a new target.
 */
export async function removeGitFile(
  root: string,
  relative: string,
  expected: string,
  assertContext: () => Promise<void>,
): Promise<string | null> {
  const target = await gitChild(root, relative);
  const current = await readGitFile(root, relative);
  if (!current) return null;
  if (digest(current) !== expected)
    throw new ConflictException('GIT_DELIVERABLES_CHANGED');
  const git = path.join(root, '.git');
  const gitEntry = await fs.lstat(git);
  if (!gitEntry.isDirectory() || gitEntry.isSymbolicLink())
    throw new BadRequestException('GIT_DELIVERABLES_UNSAFE_PATH');
  const recovery = path.join(git, 'mergeron-deliverable-recovery');
  await fs
    .mkdir(recovery, { mode: 0o700 })
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
  const directory = await fs.lstat(recovery);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.mode & 0o077
  )
    throw new BadRequestException('GIT_DELIVERABLES_UNSAFE_PATH');
  const name = randomUUID();
  const backup = path.join(recovery, name);
  await fs.writeFile(
    backup + '.json',
    JSON.stringify({ source: relative, reviewedSha256: expected }),
    { flag: 'wx', mode: 0o600 },
  );
  let moved = false;
  try {
    await assertContext();
    await gitChild(root, relative);
    await fs.rename(target, backup);
    moved = true;
    const captured = await readGitFile(recovery, name);
    if (!captured || digest(captured) !== expected)
      throw new ConflictException('GIT_DELIVERABLES_CHANGED');
    await assertContext();
    return '.git/mergeron-deliverable-recovery/' + name;
  } catch (error) {
    if (moved) {
      try {
        await gitChild(root, relative);
        // Exclusive restoration: a newly created working file wins its path.
        await fs.link(backup, target);
        await fs.unlink(backup);
      } catch {
        throw new ConflictException(
          'GIT_DELIVERABLES_DELETE_RECOVERY_REQUIRED',
        );
      }
    }
    throw error;
  }
}

export async function discoverGitDeliverables(
  root: string,
  directory: string,
  adoptFolders = false,
) {
  const target = await gitChild(root, directory);
  const entries = await fs
    .readdir(target, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException): import('node:fs').Dirent[] => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  if (entries.length > 1000)
    throw new BadRequestException('GIT_DELIVERABLES_LIMIT');
  const results: {
    folder: string;
    manifest: GitDeliverableManifest;
    hash: string | null;
  }[] = [];
  const seen = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = `${directory}/${entry.name}`;
    const raw = await readGitFile(root, `${folder}/livrable.json`, 256 * 1024);
    if (!raw && adoptFolders) {
      const children = await fs.readdir(await gitChild(root, folder), {
        withFileTypes: true,
      });
      if (children.length > 500)
        throw new BadRequestException('GIT_DELIVERABLES_LIMIT');
      const files = children.filter(
        (c) => c.isFile() && !c.name.startsWith('.'),
      );
      if (!files.length) continue;
      const stableId = `git-${digest(folder).slice(0, 24)}`;
      const manifest = manifestSchema.parse({
        format: 'mergeron-deliverable',
        version: 1,
        id: stableId,
        title: entry.name,
        description: '',
        labels: [],
        documents: files.map((f) => ({
          id: `git-${digest(`${folder}/${f.name}`).slice(0, 24)}`,
          path: f.name,
          labels: [],
        })),
      });
      if (seen.has(manifest.id))
        throw new BadRequestException('GIT_DELIVERABLES_DUPLICATE_ID');
      seen.add(manifest.id);
      results.push({ folder, manifest, hash: null });
      if (results.length > 100)
        throw new BadRequestException('GIT_DELIVERABLES_LIMIT');
      continue;
    }
    if (!raw) continue;
    let manifest: GitDeliverableManifest;
    try {
      manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new BadRequestException('GIT_DELIVERABLES_INVALID_MANIFEST');
    }
    if (seen.has(manifest.id))
      throw new BadRequestException('GIT_DELIVERABLES_DUPLICATE_ID');
    seen.add(manifest.id);
    results.push({ folder, manifest, hash: digest(raw) });
    if (results.length > 100)
      throw new BadRequestException('GIT_DELIVERABLES_LIMIT');
  }
  return results;
}
