import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const monitorDigest = (value) =>
  createHash('sha256').update(value).digest('hex');
export async function writeMonitorFile(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = join(directory, `${name}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o644 });
  await rename(temporary, join(directory, name));
}
export async function grantMonitor(directory, now = Date.now()) {
  const token = randomBytes(32).toString('hex');
  let grants = [];
  try {
    grants = JSON.parse(await readFile(join(directory, 'access.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  grants = grants.filter((item) => item.expiresAt > now).slice(-7);
  const expiresAt = now + 6 * 3600000;
  grants.push({ hash: monitorDigest(token), expiresAt });
  await writeMonitorFile(directory, 'access.json', grants);
  return { token, expiresAt };
}
/** Deliberate allowlist: never publish actor, Docker specs, paths, errors or backup details. */
export async function publishMonitor(directory, operation) {
  const safeWord = (value) =>
    typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)
      ? value
      : 'unknown';
  await writeMonitorFile(directory, 'state.json', {
    observedAt: new Date().toISOString(),
    operation: {
      id: operation.id,
      phase: safeWord(operation.phase),
      status: safeWord(operation.status),
      startedAt: operation.startedAt,
      events: (operation.events ?? [])
        .slice(-200)
        .map((event) => ({
          at: event.at,
          phase: safeWord(event.phase),
          status: safeWord(event.status),
        })),
    },
  });
}
