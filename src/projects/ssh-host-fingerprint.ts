import { createHash, createHmac } from 'node:crypto';
import { ConflictException } from '@nestjs/common';

/** curl 7.80+ accepts a SHA-256 pin; --knownhosts requires newer system curl. */
export function sshHostFingerprint(
  knownHosts: string,
  host: string,
  port: string,
) {
  const target = !port || port === '22' ? host : `[${host}]:${port}`;
  const matches = (selector: string) => {
    if (selector.startsWith('|1|')) {
      const [, , salt, digest] = selector.split('|');
      return Boolean(
        salt &&
        digest &&
        createHmac('sha1', Buffer.from(salt, 'base64'))
          .update(target)
          .digest('base64') === digest,
      );
    }
    // Exact host keys only for file operations; hashed ssh-keyscan entries also work.
    return selector.toLowerCase() === target.toLowerCase();
  };
  for (const line of knownHosts.split(/\r?\n/)) {
    const [selectors, type, key] = line.trim().split(/\s+/);
    if (
      !selectors ||
      selectors.startsWith('#') ||
      selectors.startsWith('@') ||
      !key ||
      !/^(ssh-|ecdsa-)/.test(type)
    )
      continue;
    const hosts = selectors.split(',');
    if (hosts.some((h) => h.startsWith('!') && matches(h.slice(1)))) continue;
    if (hosts.some(matches) && /^[A-Za-z0-9+/]+={0,2}$/.test(key))
      return createHash('sha256')
        .update(Buffer.from(key, 'base64'))
        .digest('base64');
  }
  throw new ConflictException('PROJECT_CONNECTION_SSH_AUTH_REQUIRED');
}
