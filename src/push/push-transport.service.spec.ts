import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createECDH, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { DatabaseService } from '../database/database.service';
import {
  PushTransportService,
  publicPushAddress,
} from './push-transport.service';

vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: vi.fn(),
}));
let directory: string;
let keyPath: string;
const make = (values: Record<string, string> = {}) =>
  new PushTransportService(
    new ConfigService({
      MERGERON_PUBLIC_URL: 'https://mergeron.example.test',
      ...values,
    }),
    { databasePath: join(directory, 'app.sqlite') } as DatabaseService,
  );
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mergeron-push-transport-'));
  keyPath = join(directory, 'app.sqlite.push-vapid.json');
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('creates stable private VAPID keys per database/environment, never rotates invalid or public files', () => {
  const first = make();
  first.onModuleInit();
  expect(first.publicKey()).toMatch(/^[\w-]{87}$/);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  const saved = readFileSync(keyPath, 'utf8');
  const second = make();
  second.onModuleInit();
  expect(second.publicKey()).toBe(first.publicKey());
  chmodSync(keyPath, 0o644);
  const exposed = make();
  exposed.onModuleInit();
  expect(exposed.publicKey()).toBeNull();
  chmodSync(keyPath, 0o600);
  writeFileSync(keyPath, 'invalid');
  const corrupt = make();
  corrupt.onModuleInit();
  expect(corrupt.publicKey()).toBeNull();
  expect(readFileSync(keyPath, 'utf8')).toBe('invalid');
  expect(saved).toContain('privateKey');
});
it('refuses symlink key files without touching their targets and disables absent/local public contacts', () => {
  const target = join(directory, 'target');
  writeFileSync(target, 'untouched');
  symlinkSync(target, keyPath);
  const linked = make();
  linked.onModuleInit();
  expect(linked.publicKey()).toBeNull();
  expect(readFileSync(target, 'utf8')).toBe('untouched');
  for (const url of [
    '',
    'http://example.test',
    'https://localhost',
    'mailto:',
  ]) {
    const service = make({ MERGERON_PUBLIC_URL: url });
    service.onModuleInit();
    expect(service.publicKey()).toBeNull();
  }
});
it.each([
  '0.0.0.0',
  '10.0.0.1',
  '100.64.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '192.168.1.1',
  '192.0.2.1',
  '198.18.0.1',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '240.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
])('blocks private/reserved direct destination %s', (address) =>
  expect(publicPushAddress(address)).toBe(false),
);
it('encrypts the payload, authenticates with persisted VAPID, routes via the proxy and never follows provider redirects', async () => {
  const service = make({ HTTPS_PROXY: 'http://squid.example.test:3128' });
  service.onModuleInit();
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/push/device',
    p256dh: curve.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
  let code = 201;
  const end = vi.fn();
  vi.mocked(request).mockImplementation(((
    _url: unknown,
    options: Record<string, unknown>,
    callback: (response: EventEmitter & { statusCode: number }) => void,
  ) => {
    const outgoing = new EventEmitter();
    Object.assign(outgoing, {
      end: (body: Buffer) => {
        end(body);
        expect(body.toString()).not.toContain('private text');
        const response = Object.assign(new EventEmitter(), {
          statusCode: code,
        });
        callback(response);
        response.emit('data', Buffer.from('never log this'));
        response.emit('end');
      },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.agent?.constructor.name).toBe('HttpsProxyAgent');
    expect(options.headers).toMatchObject({
      TTL: 120,
      'Content-Encoding': 'aes128gcm',
    });
    return outgoing;
  }) as typeof request);
  await service.send(subscription, { text: 'private text' }, 120, 'topic');
  expect(end).toHaveBeenCalledOnce();
  code = 302;
  await expect(
    service.send(subscription, {}, 120, 'topic'),
  ).rejects.toMatchObject({ statusCode: 302 });
  expect(request).toHaveBeenCalledTimes(2);
});
