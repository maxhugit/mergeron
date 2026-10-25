/** Fixed log families: never accept arbitrary paths or deletion patterns. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';

export const LOG_RETENTION_KEY = 'general.logRetention';
export const LOG_DIRECTORY = join(process.cwd(), 'logs');
export interface RetentionRule {
  enabled: boolean;
  maxAgeDays: number;
  maxFiles: number;
}
export interface LogRetentionPolicy {
  application: RetentionRule;
  codex: RetentionRule & { maxFileMiB: number };
}
export const DEFAULT_LOG_RETENTION: LogRetentionPolicy = {
  application: { enabled: true, maxAgeDays: 30, maxFiles: 5 },
  codex: { enabled: false, maxAgeDays: 30, maxFiles: 5, maxFileMiB: 50 },
};
export function validateLogRetention(value: unknown): LogRetentionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid retention policy');
  const policy = value as Record<string, unknown>;
  const rule = (value: unknown, codex = false) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid retention rule');
    const r = value as Record<string, unknown>;
    if (
      typeof r.enabled !== 'boolean' ||
      !Number.isInteger(r.maxAgeDays) ||
      Number(r.maxAgeDays) < 1 ||
      Number(r.maxAgeDays) > 3650 ||
      !Number.isInteger(r.maxFiles) ||
      Number(r.maxFiles) < 1 ||
      Number(r.maxFiles) > 1000
    )
      throw new Error('Invalid retention limits');
    if (
      codex &&
      (!Number.isInteger(r.maxFileMiB) ||
        Number(r.maxFileMiB) < 1 ||
        Number(r.maxFileMiB) > 1024)
    )
      throw new Error('Invalid rotation size');
    return {
      enabled: r.enabled,
      maxAgeDays: Number(r.maxAgeDays),
      maxFiles: Number(r.maxFiles),
      ...(codex ? { maxFileMiB: Number(r.maxFileMiB) } : {}),
    };
  };
  return {
    application: rule(policy.application),
    codex: rule(policy.codex, true) as LogRetentionPolicy['codex'],
  };
}
let currentPolicy = DEFAULT_LOG_RETENTION;
export function configureLogRetention(policy: LogRetentionPolicy) {
  currentPolicy = validateLogRetention(policy);
}
const auditQueues = new Map<string, Promise<void>>();

/** All clients serialize append/rotation for this path; no copy/truncate race. */
export function createCodexAuditStream(directory = LOG_DIRECTORY): Writable {
  const file = join(directory, 'codex-jsonrpc.jsonl');
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const task = (auditQueues.get(file) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await mkdir(directory, { recursive: true });
          let size = 0;
          try {
            const stat = await lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink())
              throw new Error('Unsafe audit log');
            size = stat.size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (
            currentPolicy.codex.enabled &&
            size &&
            size + chunk.length > currentPolicy.codex.maxFileMiB * 1024 * 1024
          ) {
            await rename(
              file,
              join(
                directory,
                `codex-jsonrpc.${Date.now()}-${randomUUID()}.jsonl`,
              ),
            );
          }
          await appendFile(file, chunk, {
            mode: 0o600,
            flag:
              constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_APPEND |
              constants.O_NOFOLLOW,
          });
        });
      auditQueues.set(file, task);
      void task.then(
        () => callback(),
        (error: Error) => callback(error),
      );
    },
  });
}

export interface LogStorageFile {
  name: string;
  bytes: number;
  modifiedAt: number;
  family: 'application' | 'codex' | 'other';
  active: boolean;
}
export async function logStorageInventory(
  directory = LOG_DIRECTORY,
): Promise<LogStorageFile[]> {
  const entries = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const files: LogStorageFile[] = [];
  for (const name of entries) {
    const stat = await lstat(join(directory, name)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const family = /^(?:app|app\.log|app\.\d+\.log)$/.test(name)
      ? 'application'
      : /^(?:codex-jsonrpc\.jsonl|codex-jsonrpc\.\d+-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.jsonl)$/.test(
            name,
          )
        ? 'codex'
        : 'other';
    files.push({
      name,
      bytes: stat.size,
      modifiedAt: stat.mtimeMs,
      family,
      active:
        name === 'codex-jsonrpc.jsonl' || name === 'app' || name === 'app.log',
    });
  }
  // Pino-roll chooses the highest numeric suffix, including across restarts.
  const app = files
    .filter((file) => /^app\.\d+\.log$/.test(file.name))
    .sort(
      (a, b) => Number(b.name.split('.')[1]) - Number(a.name.split('.')[1]),
    );
  if (app[0]) app[0].active = true;
  return files;
}

/** Delete closed archives only, never symlinks, unknown files or active logs. */
export async function pruneLogArchives(
  policy: LogRetentionPolicy,
  directory = LOG_DIRECTORY,
  now = Date.now(),
): Promise<void> {
  const files = await logStorageInventory(directory);
  for (const family of ['application', 'codex'] as const) {
    const rule = policy[family];
    if (!rule.enabled) continue;
    const archives = files
      .filter((file) => file.family === family && !file.active)
      .sort(
        (a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name),
      );
    for (const [index, file] of archives.entries()) {
      if (
        index < rule.maxFiles &&
        file.modifiedAt >= now - rule.maxAgeDays * 86400000
      )
        continue;
      const path = join(directory, file.name);
      const stat = await lstat(path).catch(() => null);
      if (
        stat?.isFile() &&
        !stat.isSymbolicLink() &&
        stat.mtimeMs === file.modifiedAt &&
        stat.size === file.bytes
      )
        await unlink(path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
    }
  }
}
