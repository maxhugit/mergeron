import { createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { sshHostFingerprint } from './ssh-host-fingerprint';

it('pins only a key for the selected host and port', () => {
  const key = Buffer.from('public-host-key').toString('base64');
  const fingerprint = createHash('sha256')
    .update('public-host-key')
    .digest('base64');
  expect(
    sshHostFingerprint(
      `other.test ssh-ed25519 ZGVtbw==\n[host.test]:2222 ssh-ed25519 ${key}`,
      'host.test',
      '2222',
    ),
  ).toBe(fingerprint);
  expect(() =>
    sshHostFingerprint(`other.test ssh-ed25519 ${key}`, 'host.test', '22'),
  ).toThrow('SSH_AUTH_REQUIRED');
  expect(() =>
    sshHostFingerprint(
      `@revoked host.test ssh-ed25519 ${key}`,
      'host.test',
      '22',
    ),
  ).toThrow('SSH_AUTH_REQUIRED');
});
it('supports hashed known_hosts entries without inheriting unrelated host keys', () => {
  const salt = Buffer.from('example-salt'),
    target = 'host.test';
  const digest = createHmac('sha1', salt).update(target).digest('base64');
  const line = `|1|${salt.toString('base64')}|${digest} ssh-ed25519 ZGVtbw==`;
  expect(sshHostFingerprint(line, target, '22')).toBe(
    createHash('sha256').update('demo').digest('base64'),
  );
  expect(() => sshHostFingerprint(line, 'other.test', '22')).toThrow(
    'SSH_AUTH_REQUIRED',
  );
});
