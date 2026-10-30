/** Explicit, additive migration for an existing managed Squid configuration. */
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const domains = ['fcm.googleapis.com', '.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];
export function withPushEgress(source) {
  // Never insert grants into a permissive or unrecognized configuration.
  const lines = source.split(/\r?\n/);
  for (const rule of ['http_access deny !Safe_ports', 'http_access deny CONNECT !SSL_ports', 'http_access deny private_ipv4', 'http_access deny private_ipv6', 'http_access allow allowed_domains', 'http_access deny all']) {
    if (lines.filter((line) => line.trim() === rule).length !== 1) throw new Error('Unrecognized managed Squid configuration');
  }
  const permit = lines.indexOf(lines.find((line) => line.trim() === 'http_access allow allowed_domains'));
  if (lines.some((line, index) => index < permit && /^\s*http_access\s+allow\b/.test(line))) throw new Error('Unexpected early allow rule');
  for (const rule of ['http_access deny private_ipv4', 'http_access deny private_ipv6']) if (lines.findIndex((line) => line.trim() === rule) > permit) throw new Error('Private-network deny must precede grants');
  const missing = domains.filter((domain) => !lines.some((line) => line.trim() === `acl allowed_domains dstdomain ${domain}`));
  if (!missing.length) return source;
  lines.splice(permit, 0, ...missing.map((domain) => `acl allowed_domains dstdomain ${domain}`));
  return lines.join('\n');
}

export async function configurePushEgress(path, apply = false) {
  if (!isAbsolute(path)) throw new Error('An absolute configuration path is required');
  const original = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let info; let source;
  try {
    info = await original.stat(); if (!info.isFile()) throw new Error('Configuration must be a regular file');
    source = await original.readFile('utf8');
  } finally { await original.close(); }
  const next = withPushEgress(source);
  if (next === source || !apply) return { changed: false, needed: next !== source };
  const suffix = randomUUID();
  const backupPath = `${path}.before-web-push-${suffix}`;
  const stagedPath = `${path}.web-push-${suffix}`;
  const backup = await open(backupPath, 'wx', 0o600);
  try { await backup.writeFile(source); await backup.sync(); } finally { await backup.close(); }
  try {
    const staged = await open(stagedPath, 'wx', 0o600);
    try { await staged.writeFile(next); await staged.chown(info.uid, info.gid); await staged.chmod(info.mode & 0o777); await staged.sync(); }
    finally { await staged.close(); }
    // Refuse concurrent edits rather than replacing an administrator's work.
    const check = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (await check.readFile('utf8') !== source) throw new Error('Configuration changed during migration'); }
    finally { await check.close(); }
    await rename(stagedPath, path);
    return { changed: true, backupPath };
  } finally { await unlink(stagedPath).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [, , path, option] = process.argv;
    if (!path || (option && option !== '--apply')) throw new Error('Usage: node enable-push-egress.mjs /absolute/path/squid.conf [--apply]');
    console.log(JSON.stringify(await configurePushEgress(path, option === '--apply')));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
