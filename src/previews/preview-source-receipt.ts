import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { PreviewReceipt } from '../../runtime/preview-receipt.cjs';
const execute = promisify(execFile);
/** A read-only primitive: no repository hooks, shell, credentials or network. */
export async function previewGitCommit(
  root: string | null,
): Promise<string | null> {
  if (!root) return null;
  try {
    const { stdout } = await execute(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        'rev-parse',
        '--verify',
        'HEAD',
      ],
      {
        cwd: root,
        timeout: 5000,
        maxBuffer: 1024,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    const head = stdout.trim();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ? head : null;
  } catch {
    return null;
  }
}
export function sourceReceipt(
  archiveSha: string,
  sourceFingerprint: string,
  copyId: string | null,
  gitCommit: string | null,
): PreviewReceipt {
  return {
    schemaVersion: 1,
    generation: randomUUID(),
    archiveSha,
    sourceFingerprint,
    copyId,
    gitCommit,
    syncedAt: null,
  };
}
