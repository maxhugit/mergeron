import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const monitorDigest = (value) =>
  createHash('sha256').update(value).digest('hex');
export async function writeMonitorFile(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = join(
    directory,
    `${name}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, JSON.stringify(value), { mode: 0o644 });
  await rename(temporary, join(directory, name));
}
const grantQueues = new Map();
export async function grantMonitor(directory, now = Date.now()) {
  const previous = grantQueues.get(directory) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => createGrant(directory, now));
  grantQueues.set(directory, task);
  try {
    return await task;
  } finally {
    if (grantQueues.get(directory) === task) grantQueues.delete(directory);
  }
}
async function createGrant(directory, now) {
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
  if (operation.managerPending && operation.status === 'succeeded')
    operation = { ...operation, phase: 'managerPending', status: 'running' };
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
      events: (operation.events ?? []).slice(-200).map((event) => ({
        at: event.at,
        phase: safeWord(event.phase),
        status: safeWord(event.status),
      })),
    },
  });
}
