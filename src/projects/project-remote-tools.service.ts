import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { sshHostFingerprint } from './ssh-host-fingerprint';
import { currentAccess, requireExecutionAccess } from '../auth/access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectAgentToolRequests,
  projectConnections,
} from '../database/schema';
import {
  WorkspaceResourcesService,
  type ConnectionSecret,
} from './workspace-resources.service';

const context = {
  connectionId: z.string().min(1).max(100),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  userRequest: z.string().trim().min(1).max(2000),
};
export const useProjectConnectionInput = z.strictObject({
  ...context,
  operation: z.enum(['ssh_command', 'list_files', 'read_file', 'write_file']),
  command: z.string().min(1).max(8000).optional(),
  path: z.string().max(2048).optional(),
  content: z.string().max(64_000).optional(),
});
type Input = z.infer<typeof useProjectConnectionInput>;

/** Credentials never leave the server. Each call is bound to a live writable admin turn. */
@Injectable()
export class ProjectRemoteToolsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  async execute(
    projectId: string,
    threadId: string,
    raw: unknown,
    check: () => void,
  ) {
    const args = useProjectConnectionInput.parse(raw);
    requireExecutionAccess();
    check();
    const connection = this.db
      .select()
      .from(projectConnections)
      .where(
        and(
          eq(projectConnections.id, args.connectionId),
          eq(projectConnections.projectId, projectId),
        ),
      )
      .get();
    if (
      !connection?.enabled ||
      !connection.agentEnabled ||
      connection.protocol === 'git'
    )
      throw new ForbiddenException('PROJECT_CONNECTION_UNAVAILABLE');
    const { resource, secret } = this.resources.resolveForTransfer(
      projectId,
      args.connectionId,
    );
    if (
      !resource.enabled ||
      resource.type !== connection.protocol ||
      !resource.capabilities.read
    )
      throw new ForbiddenException('PROJECT_CONNECTION_UNAVAILABLE');
    const write =
      args.operation === 'ssh_command' || args.operation === 'write_file';
    if (
      write &&
      (resource.accessMode !== 'read_write' || !resource.capabilities.write)
    )
      throw new ForbiddenException('READ_ONLY');
    if (
      args.operation === 'ssh_command'
        ? resource.type !== 'ssh' ||
          !args.command ||
          args.command.includes('\0')
        : !['ssh', 'sftp', 'ftps', 'ftp'].includes(resource.type)
    )
      throw new ConflictException('PROJECT_CONNECTION_UNSUPPORTED');
    if (args.operation === 'write_file' && args.content === undefined)
      throw new ConflictException('PROJECT_CONNECTION_INVALID_REQUEST');
    if (args.operation !== 'ssh_command')
      this.remotePath(
        resource.rootPath,
        args.path ?? '',
        args.operation === 'list_files',
      );
    const key = and(
      eq(projectAgentToolRequests.projectId, projectId),
      eq(projectAgentToolRequests.threadId, threadId),
      eq(projectAgentToolRequests.requestId, args.requestId),
    );
    const digest = createHash('sha256')
      .update(JSON.stringify({ tool: 'use_project_connection', ...args }))
      .digest('hex');
    const previous = this.db
      .select()
      .from(projectAgentToolRequests)
      .where(key)
      .get();
    if (previous) {
      if (
        previous.digest !== digest ||
        previous.personId !== (currentAccess()?.identity.personId ?? null)
      )
        throw new ConflictException('PROJECT_CONNECTION_REQUEST_CONFLICT');
      if (previous.result) return previous.result;
      throw new ConflictException('PROJECT_CONNECTION_OUTCOME_UNKNOWN');
    }
    check();
    const now = Date.now();
    this.db
      .insert(projectAgentToolRequests)
      .values({
        projectId,
        threadId,
        requestId: args.requestId,
        digest,
        personId: currentAccess()?.identity.personId ?? null,
        createdAt: now,
      })
      .run();
    const directory = mkdtempSync(join(tmpdir(), 'mergeron-remote-'));
    try {
      const recheck = () => {
        check();
        requireExecutionAccess();
        const latest = this.db
          .select()
          .from(projectConnections)
          .where(
            and(
              eq(projectConnections.id, args.connectionId),
              eq(projectConnections.projectId, projectId),
            ),
          )
          .get();
        if (
          !latest?.enabled ||
          !latest.agentEnabled ||
          latest.updatedAt !== connection.updatedAt ||
          latest.address !== connection.address
        )
          throw new ForbiddenException('PROJECT_CONNECTION_UNAVAILABLE');
      };
      recheck();
      const result = await this.run(
        resource.type === 'ssh' && args.operation !== 'ssh_command'
          ? 'sftp'
          : resource.type,
        resource.address!,
        resource.rootPath,
        secret,
        directory,
        args,
        recheck,
      );
      recheck();
      const output = {
        connectionId: args.connectionId,
        operation: args.operation,
        ...result,
        untrustedContent: true,
      };
      this.db
        .update(projectAgentToolRequests)
        .set({ result: output })
        .where(key)
        .run();
      return output;
    } catch {
      throw new ConflictException('PROJECT_CONNECTION_OPERATION_FAILED');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private remotePath(root: string, relative: string, directory: boolean) {
    if (
      relative.includes('\\') ||
      [...relative].some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ) ||
      relative.startsWith('/') ||
      relative.split('/').some((s) => s === '..' || s === '.')
    )
      throw new ConflictException('PROJECT_CONNECTION_INVALID_PATH');
    if (!directory && !relative)
      throw new ConflictException('PROJECT_CONNECTION_INVALID_PATH');
    const base = posix.resolve('/', root),
      result = posix.join(base, relative);
    if (result !== base && !result.startsWith(base === '/' ? '/' : base + '/'))
      throw new ConflictException('PROJECT_CONNECTION_INVALID_PATH');
    return (
      result.split('/').map(encodeURIComponent).join('/') +
      (directory && !result.endsWith('/') ? '/' : '')
    );
  }

  private run(
    type: string,
    address: string,
    root: string,
    secret: ConnectionSecret | null,
    directory: string,
    input: Input,
    check: () => void,
  ) {
    const endpoint = new URL(
      address.includes('://') ? address : `${type}://${address}`,
    );
    const keyPath = join(directory, 'key'),
      hostsPath = join(directory, 'known_hosts');
    if (secret?.privateKey)
      writeFileSync(keyPath, secret.privateKey, { mode: 0o600 });
    if (secret?.knownHosts)
      writeFileSync(hostsPath, secret.knownHosts, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8' };
    let program: string, args: string[];
    if (type === 'ssh') {
      if (
        !secret?.knownHosts?.trim() ||
        !secret.username ||
        !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(secret.username) ||
        (!secret.privateKey && !secret.password) ||
        endpoint.hostname.startsWith('-')
      )
        throw new ConflictException('PROJECT_CONNECTION_SSH_AUTH_REQUIRED');
      const askpass = join(directory, 'askpass');
      writeFileSync(
        askpass,
        '#!/bin/sh\nprintf "%s\\n" "$MERGERON_REMOTE_SECRET"\n',
        { mode: 0o700 },
      );
      Object.assign(env, {
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: 'mergeron:0',
        MERGERON_REMOTE_SECRET: secret.passphrase || secret.password || '',
      });
      program = 'ssh';
      args = [
        '-F',
        '/dev/null',
        '-T',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${hostsPath}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        'IdentityAgent=none',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'PermitLocalCommand=no',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'NumberOfPasswordPrompts=1',
      ];
      if (secret.privateKey) args.push('-i', keyPath);
      else args.push('-o', 'PubkeyAuthentication=no');
      args.push(
        '-p',
        endpoint.port || '22',
        '-l',
        secret.username,
        '--',
        endpoint.hostname,
        input.command!,
      );
    } else {
      if (type === 'sftp' && !secret?.knownHosts?.trim())
        throw new ConflictException('PROJECT_CONNECTION_SSH_AUTH_REQUIRED');
      const escape = (s: string) => {
        if (/[\r\n\0]/.test(s))
          throw new ConflictException('PROJECT_CONNECTION_INVALID_SECRET');
        return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      };
      const config = [
        'silent',
        'show-error',
        'fail',
        'max-time = 30',
        'connect-timeout = 10',
      ];
      if (secret?.username || secret?.password)
        config.push(
          `user = "${escape((secret.username || '') + ':' + (secret.password || ''))}"`,
        );
      if (secret?.privateKey) config.push(`key = "${escape(keyPath)}"`);
      if (secret?.passphrase)
        config.push(`pass = "${escape(secret.passphrase)}"`);
      if (type === 'sftp')
        config.push(
          `hostpubsha256 = "${sshHostFingerprint(secret!.knownHosts!, endpoint.hostname, endpoint.port)}"`,
        );
      const configPath = join(directory, 'curl.conf');
      writeFileSync(configPath, config.join('\n') + '\n', { mode: 0o600 });
      endpoint.protocol = type + ':';
      endpoint.pathname = this.remotePath(
        root,
        input.path ?? '',
        input.operation === 'list_files',
      );
      endpoint.search = '';
      endpoint.hash = '';
      program = 'curl';
      args = [
        '--disable',
        '--config',
        configPath,
        '--globoff',
        '--proto',
        '=' + type,
        '--max-filesize',
        '65536',
      ];
      if (input.operation === 'list_files') args.push('--list-only');
      if (input.operation === 'write_file') args.push('--upload-file', '-');
      args.push('--url', endpoint.toString());
    }
    check();
    return new Promise<{
      output: string;
      exitCode: number | null;
      truncated: boolean;
    }>((resolve, reject) => {
      const child = spawn(program, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = Buffer.alloc(0),
        truncated = false,
        settled = false;
      const append = (data: Buffer) => {
        const remaining = 65536 - output.length;
        if (data.length > remaining) {
          truncated = true;
          child.kill('SIGKILL');
        }
        output = Buffer.concat([
          output,
          data.subarray(0, Math.max(remaining, 0)),
        ]);
      };
      child.stdout.on('data', append);
      // SSH command stderr is useful; curl diagnostics may contain credentials/URLs.
      child.stderr.on('data', (data: Buffer) => {
        if (type === 'ssh') append(data);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          reject(new Error('timeout'));
        }
      }, 30_000);
      const authorization = setInterval(() => {
        try {
          check();
        } catch {
          child.kill('SIGKILL');
        }
      }, 500);
      child.on('error', () => {
        clearTimeout(timer);
        clearInterval(authorization);
        if (!settled) {
          settled = true;
          reject(new Error('remote operation failed'));
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        clearInterval(authorization);
        if (settled) return;
        settled = true;
        if (type !== 'ssh' && code !== 0 && !truncated) {
          reject(new Error('remote operation failed'));
          return;
        }
        let text = output.toString('utf8');
        for (const value of [
          secret?.password,
          secret?.token,
          secret?.privateKey,
          secret?.passphrase,
        ])
          if (value) text = text.replaceAll(value, '[redacted]');
        resolve({ output: text, exitCode: code, truncated });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(
        input.operation === 'write_file' ? input.content : undefined,
      );
    });
  }
}
