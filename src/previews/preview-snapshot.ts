/** The project is never imported/executed while exporting its source. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const helper = path.resolve(__dirname, '../../runtime/preview-snapshot.py');
function capture(source: string, check: boolean, authorize: () => void) {
  authorize();
  const child = spawn(
    'python3',
    ['-I', helper, source, ...(check ? ['--check'] : [])],
    {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let error = '';
  child.stderr.on('data', (chunk: Buffer) => {
    error = (error + chunk.toString()).slice(-1024);
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  const lease = setInterval(() => {
    try {
      authorize();
    } catch {
      child.kill('SIGKILL');
    }
  }, 100);
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(lease);
      if (code === 0) {
        try {
          authorize();
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error('PREVIEW_ACCESS_DENIED'));
        }
      } else
        reject(
          new Error(
            /^PREVIEW_[A-Z_]+$/.test(error.trim())
              ? error.trim()
              : 'PREVIEW_SOURCE_CHANGED',
          ),
        );
    });
  });
  void done.catch(() => {});
  return { child, done };
}
export async function previewSourceFingerprint(
  source: string,
  authorize: () => void = () => {},
) {
  const { child, done } = capture(source, true, authorize);
  let text = '';
  for await (const chunk of child.stdout) {
    text += String(chunk);
    if (text.length > 1024) {
      child.kill('SIGKILL');
      throw new Error('PREVIEW_SOURCE_LIMIT');
    }
  }
  await done;
  const value = JSON.parse(text) as { fingerprint: string };
  if (!/^[a-f0-9]{64}$/.test(value.fingerprint))
    throw new Error('PREVIEW_UNSAFE_SOURCE');
  return value.fingerprint;
}
export async function previewSnapshot(
  source: string,
  destination: string,
  authorize: () => void = () => {},
) {
  const { child, done } = capture(source, false, authorize);
  const tmp = destination + '.tmp',
    hash = createHash('sha256');
  let bytes = 0,
    created = false;
  const output = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
  output.once('open', () => {
    created = true;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    hash.update(chunk);
    if (bytes > 64 * 1024 ** 2) child.kill('SIGKILL');
  });
  try {
    await Promise.all([pipeline(child.stdout, output), done]);
    if (bytes > 64 * 1024 ** 2) throw new Error('PREVIEW_SOURCE_LIMIT');
    const fd = await fs.open(tmp, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    authorize();
    await fs.rename(tmp, destination);
    return { sha256: hash.digest('hex'), bytes };
  } catch (error) {
    child.kill('SIGKILL');
    output.destroy();
    await done.catch(() => {});
    if (created) await fs.rm(tmp, { force: true });
    throw error;
  }
}
