import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { projects } from '../database/schema';
import { accessContext } from '../auth/access-context';
import type { IdentityService } from '../auth/identity.service';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { ProjectRemoteToolsService } from './project-remote-tools.service';

const processMock = vi.hoisted(() => ({
  spawn:
    vi.fn<
      (
        program: string,
        args: string[],
        options: SpawnOptionsWithoutStdio,
      ) => ChildProcessWithoutNullStreams
    >(),
}));
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }));
let database: TestDatabase,
  resources: WorkspaceResourcesService,
  service: ProjectRemoteToolsService;
const check = vi.fn();
const identity = {
  kind: 'person' as const,
  personId: 'admin',
  name: 'Admin',
  role: 'administrator' as const,
  active: true,
};
const run = <T>(action: () => T) =>
  accessContext.run(
    {
      identity,
      identities: {
        requireAdministrator: vi.fn(),
        requireProject: vi.fn(),
      } as unknown as IdentityService,
    },
    action,
  );
let output = 'up 10 days',
  beforeReply: () => void;
beforeEach(() => {
  database = createTestDatabase();
  database.db
    .insert(projects)
    .values({
      id: 'p',
      name: 'Project',
      workspacePath: '/workspace/p',
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  resources = new WorkspaceResourcesService(
    database.db,
    new ConfigService({ WEBUI_CONNECTION_SECRET_KEY: 'test-key' }),
  );
  service = new ProjectRemoteToolsService(database.db, resources);
  check.mockReset();
  output = 'up 10 days';
  beforeReply = () => {};
  processMock.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    setImmediate(() => {
      beforeReply();
      child.stdout.emit('data', Buffer.from(output));
      child.emit('close', 0);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
});
afterEach(() => database.sqlite.close());
function connection(type = 'ssh', extra: Record<string, unknown> = {}) {
  return resources.create('p', {
    name: 'Server',
    type,
    address: type + '://host.example.test',
    rootPath: '/srv/project',
    accessMode: 'read_write',
    connectionOnly: true,
    agentEnabled: true,
    secret: {
      username: 'admin',
      privateKey: 'demo-private-key',
      knownHosts: 'host.example.test ssh-ed25519 DEMO',
    },
    ...extra,
  });
}
const request = (
  connectionId: string,
  extra: Record<string, unknown> = {},
) => ({
  connectionId,
  requestId: 'diagnose-01',
  userRequest: 'Inspect the test server',
  operation: 'ssh_command',
  command: 'uptime',
  ...extra,
});
it('uses only the configured SSH host, private key and pinned host fingerprints, then cleans temporary secrets', async () => {
  const c = connection();
  let directory = '';
  beforeReply = () => {
    const [program, args, options] = processMock.spawn.mock.calls[0];
    expect(program).toBe('ssh');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('IdentityAgent=none');
    expect(args).toContain('ForwardAgent=no');
    expect(args).toContain('host.example.test');
    expect(args).toContain('uptime');
    const key = args[args.indexOf('-i') + 1];
    directory = key.slice(0, -4);
    expect(readFileSync(key, 'utf8')).toBe('demo-private-key');
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(args)).not.toContain('demo-private-key');
    expect(options.env).not.toHaveProperty('HOME');
  };
  const result = await run(() =>
    service.execute('p', 'thread', request(c.id), check),
  );
  expect(result).toMatchObject({
    output: 'up 10 days',
    exitCode: 0,
    untrustedContent: true,
  });
  expect(existsSync(directory)).toBe(false);
  expect(check).toHaveBeenCalled();
});
it('does not repeat a completed operation and rejects conflicting reuse of its request id', async () => {
  const c = connection();
  const result = await run(() =>
    service.execute('p', 'thread', request(c.id), check),
  );
  expect(
    await run(() => service.execute('p', 'thread', request(c.id), check)),
  ).toEqual(result);
  expect(processMock.spawn).toHaveBeenCalledTimes(1);
  await expect(
    run(() =>
      service.execute(
        'p',
        'thread',
        request(c.id, { command: 'whoami' }),
        check,
      ),
    ),
  ).rejects.toThrow('REQUEST_CONFLICT');
});
it.each([
  { agentEnabled: false },
  { enabled: false },
  { accessMode: 'read_only' },
])(
  'refuses unavailable connections and shell execution on read-only access: %j',
  async (extra) => {
    const c = connection('ssh', extra);
    await expect(
      run(() => service.execute('p', 'thread', request(c.id), check)),
    ).rejects.toThrow();
    expect(processMock.spawn).not.toHaveBeenCalled();
  },
);
it('refuses unknown project connections, revoked turns and missing SSH fingerprints', async () => {
  const c = connection('ssh', {
    secret: { username: 'admin', password: 'test-password' },
  });
  await expect(
    run(() => service.execute('other', 'thread', request(c.id), check)),
  ).rejects.toThrow('UNAVAILABLE');
  check.mockImplementation(() => {
    throw new Error('turn revoked');
  });
  await expect(
    run(() => service.execute('p', 'thread', request(c.id), check)),
  ).rejects.toThrow('turn revoked');
  check.mockReset();
  await expect(
    run(() => service.execute('p', 'thread', request(c.id), check)),
  ).rejects.toThrow('OPERATION_FAILED');
  expect(processMock.spawn).not.toHaveBeenCalled();
  await expect(
    run(() => service.execute('p', 'thread', request(c.id), check)),
  ).rejects.toThrow('OUTCOME_UNKNOWN');
});
it('uses SFTP file operations with the same SSH credentials, without running a shell', async () => {
  const c = connection();
  await run(() =>
    service.execute(
      'p',
      'thread',
      request(c.id, {
        operation: 'read_file',
        path: 'config/app.json',
        command: undefined,
      }),
      check,
    ),
  );
  const [program, args] = processMock.spawn.mock.calls[0];
  expect(program).toBe('curl');
  expect(args).toContain('=sftp');
  expect(args).toContain(
    'sftp://host.example.test/srv/project/config/app.json',
  );
  expect(args).not.toContain('uptime');
});
it.each(['../secret', '/etc/passwd', 'folder/../secret', 'a\\secret', 'a\0b'])(
  'refuses remote traversal or absolute paths: %s',
  async (path) => {
    const c = connection('sftp');
    await expect(
      run(() =>
        service.execute(
          'p',
          'thread',
          request(c.id, { operation: 'read_file', command: undefined, path }),
          check,
        ),
      ),
    ).rejects.toThrow('INVALID_PATH');
    expect(processMock.spawn).not.toHaveBeenCalled();
  },
);
it('redacts server-held credentials, bounds output and rechecks revocation before returning', async () => {
  const c = connection();
  output = 'demo-private-key';
  expect(
    await run(() => service.execute('p', 'thread', request(c.id), check)),
  ).toMatchObject({ output: '[redacted]' });
  output = 'a'.repeat(70_000);
  const result = await run(() =>
    service.execute(
      'p',
      'thread',
      request(c.id, { requestId: 'bounded-01' }),
      check,
    ),
  );
  expect(result).toMatchObject({ truncated: true });
  expect(String(result?.output).length).toBeLessThanOrEqual(65536);
  beforeReply = () => {
    resources.update('p', c.id, { agentEnabled: false });
  };
  await expect(
    run(() =>
      service.execute(
        'p',
        'thread',
        request(c.id, { requestId: 'revoke-01' }),
        check,
      ),
    ),
  ).rejects.toThrow('OPERATION_FAILED');
});
