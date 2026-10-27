import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  requireExecutionAccess,
  requireProjectAccess,
} from '../auth/access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectWorkspaceCopies,
  projectWorkspaceResources,
  projectWorkspaceSecrets,
  projectWorkspaces,
  projectLocations,
  projectConnections,
  type ProjectWorkspaceResource,
} from '../database/schema';

export type WorkspaceResourceType = ProjectWorkspaceResource['type'];
export type WorkspaceAccessMode = ProjectWorkspaceResource['accessMode'];
export type ConnectionSecret = {
  username?: string;
  password?: string;
  token?: string;
  privateKey?: string;
  passphrase?: string;
  knownHosts?: string;
};

export interface WorkspaceResourceView extends Omit<
  ProjectWorkspaceResource,
  'lastError'
> {
  lastError: string | null;
  hasSecret: boolean;
  localPath: string | null;
}

const TYPES = new Set<WorkspaceResourceType>([
  'git',
  'ssh',
  'sftp',
  'ftp',
  'ftps',
]);

/** Defines external project resources without exposing credentials to activities. */
@Injectable()
export class WorkspaceResourcesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly config: ConfigService,
  ) {}

  list(projectId: string): WorkspaceResourceView[] {
    requireProjectAccess(projectId);
    this.ensureLocalResources(projectId);
    return this.db
      .select()
      .from(projectWorkspaceResources)
      .where(eq(projectWorkspaceResources.projectId, projectId))
      .all()
      .map((resource) => this.view(this.normalized(resource)));
  }

  create(
    projectId: string,
    input: Record<string, unknown>,
  ): WorkspaceResourceView {
    requireExecutionAccess();
    requireProjectAccess(projectId);
    const type = input.type;
    if (typeof type !== 'string' || !TYPES.has(type as WorkspaceResourceType))
      throw new BadRequestException('Unsupported workspace resource type');
    const name = this.requiredString(input.name, 'Resource name');
    const address = this.requiredString(input.address, 'Resource address');
    this.parseEndpoint(type as WorkspaceResourceType, address);
    const rootPath = this.normalizeRoot(input.rootPath);
    const accessMode =
      input.accessMode === 'read_write' ? 'read_write' : 'read_only';
    if (type === 'ftp' && input.allowInsecure !== true)
      throw new BadRequestException('Plain FTP must be enabled explicitly');
    const now = Date.now();
    const id = randomUUID();
    const capabilities = {
      read: true,
      write: accessMode === 'read_write',
      execute: false as const,
    };
    this.db.transaction((tx) => {
      tx.insert(projectWorkspaceResources)
        .values({
          id,
          projectId,
          name,
          type: type as WorkspaceResourceType,
          address,
          rootPath,
          accessMode,
          capabilities,
          enabled: input.enabled !== false,
          connectionState: input.enabled === false ? 'disabled' : 'untested',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const secret = this.secretInput(input.secret);
      if (secret) this.storeSecret(tx, id, secret, now);
    });
    return this.get(projectId, id);
  }

  update(
    projectId: string,
    id: string,
    input: Record<string, unknown>,
  ): WorkspaceResourceView {
    requireExecutionAccess();
    const resource = this.raw(projectId, id);
    if (
      input.expectedAddress !== undefined &&
      input.expectedAddress !== resource.address
    )
      throw new ConflictException('Connection changed; reload before saving');
    if (resource.type === 'local')
      throw new ConflictException(
        'Local compatibility resources are managed as workspaces',
      );
    const address =
      input.address === undefined
        ? resource.address!
        : this.requiredString(input.address, 'Resource address');
    this.parseEndpoint(resource.type, address);
    const accessMode =
      input.accessMode === undefined
        ? resource.accessMode
        : input.accessMode === 'read_write'
          ? 'read_write'
          : 'read_only';
    const enabled =
      input.enabled === undefined ? resource.enabled : input.enabled === true;
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.update(projectWorkspaceResources)
        .set({
          name:
            input.name === undefined
              ? resource.name
              : this.requiredString(input.name, 'Resource name'),
          address,
          rootPath:
            input.rootPath === undefined
              ? resource.rootPath
              : this.normalizeRoot(input.rootPath),
          accessMode,
          capabilities: {
            read: true,
            write: accessMode === 'read_write',
            execute: false,
          },
          enabled,
          connectionState: enabled ? 'untested' : 'disabled',
          lastCheckedAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(projectWorkspaceResources.id, id))
        .run();
      if (input.secret !== undefined) {
        tx.delete(projectWorkspaceSecrets)
          .where(eq(projectWorkspaceSecrets.resourceId, id))
          .run();
        const secret = this.secretInput(input.secret);
        if (secret) this.storeSecret(tx, id, secret, now);
      }
    });
    return this.get(projectId, id);
  }

  setEnabled(
    projectId: string,
    id: string,
    enabled: boolean,
  ): WorkspaceResourceView {
    requireExecutionAccess();
    const resource = this.raw(projectId, id);
    if (resource.type === 'local')
      throw new ConflictException(
        'Local workspace resources cannot be disabled',
      );
    this.db
      .update(projectWorkspaceResources)
      .set({
        enabled,
        connectionState: enabled ? 'untested' : 'disabled',
        lastCheckedAt: null,
        lastError: null,
        updatedAt: Date.now(),
      })
      .where(eq(projectWorkspaceResources.id, id))
      .run();
    return this.get(projectId, id);
  }

  async test(projectId: string, id: string): Promise<WorkspaceResourceView> {
    requireExecutionAccess();
    const resource = this.raw(projectId, id);
    if (resource.type === 'local') return this.get(projectId, id);
    if (!resource.enabled) throw new ConflictException('Resource is disabled');
    const secret = this.readSecret(id);
    let lastError: string | null = null;
    try {
      await this.probe(resource.type, resource.address!, secret);
    } catch (error) {
      lastError = this.safeError(error);
    }
    this.db
      .update(projectWorkspaceResources)
      .set({
        connectionState: lastError ? 'unreachable' : 'connected',
        lastCheckedAt: Date.now(),
        lastError,
        updatedAt: Date.now(),
      })
      .where(eq(projectWorkspaceResources.id, id))
      .run();
    return this.get(projectId, id);
  }

  detach(projectId: string, id: string) {
    requireExecutionAccess();
    const resource = this.raw(projectId, id);
    if (resource.type === 'local')
      throw new ConflictException('Detach the corresponding workspace instead');
    this.db.transaction((tx) => {
      tx.update(projectWorkspaceCopies)
        .set({ state: 'revoked', updatedAt: Date.now() })
        .where(eq(projectWorkspaceCopies.sourceResourceId, id))
        .run();
      tx.delete(projectWorkspaceResources)
        .where(eq(projectWorkspaceResources.id, id))
        .run();
    });
    return { ok: true, remoteDataDeleted: false };
  }

  /** Materializes a Git resource without disclosing its credentials. */
  async cloneGit(
    projectId: string,
    id: string,
    target: string,
    branch?: string | null,
  ): Promise<{ branch: string; revision: string }> {
    requireExecutionAccess();
    const resource = this.raw(projectId, id);
    if (resource.type !== 'git')
      throw new BadRequestException(
        'This resource type cannot create a Git working copy',
      );
    if (!resource.enabled)
      throw new ConflictException('Source resource is disabled');
    if (branch && !this.validGitRef(branch))
      throw new BadRequestException('Invalid Git branch or tag');
    const secret = this.readSecret(id);
    const cloneArgs = ['clone', '--single-branch'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push('--', resource.address!, target);
    try {
      await this.runGit(cloneArgs, secret, 120_000);
      const revision = (
        await this.runGit(
          ['-C', target, 'rev-parse', '--verify', '--quiet', 'HEAD'],
          null,
          10_000,
          [0, 1],
        )
      ).stdout.trim();
      const effectiveBranch = (
        await this.runGit(
          ['-C', target, 'branch', '--show-current'],
          null,
          10_000,
        )
      ).stdout.trim();
      if (!revision && !effectiveBranch) throw new Error('Invalid HEAD');
      // An empty revision denotes an unborn branch, not a failed clone.
      return { branch: effectiveBranch || branch || 'detached', revision };
    } catch {
      // Never expose credentials or raw Git diagnostics to HTTP clients.
      throw new ConflictException('WORKSPACE_GIT_CLONE_FAILED');
    }
  }

  get(projectId: string, id: string): WorkspaceResourceView {
    return this.view(this.raw(projectId, id));
  }

  /** Server-only transfer material. Never expose this result from a controller. */
  resolveForTransfer(projectId: string, id: string) {
    const resource = this.raw(projectId, id);
    return { resource, secret: this.readSecret(id) };
  }

  private raw(projectId: string, id: string): ProjectWorkspaceResource {
    requireProjectAccess(projectId);
    this.ensureLocalResources(projectId);
    const resource = this.db
      .select()
      .from(projectWorkspaceResources)
      .where(
        and(
          eq(projectWorkspaceResources.id, id),
          eq(projectWorkspaceResources.projectId, projectId),
        ),
      )
      .get();
    if (!resource) throw new NotFoundException('Workspace resource not found');
    return this.normalized(resource);
  }

  /** All consumers read the separated model; legacy rows adapt writes/secrets. */
  private normalized(
    resource: ProjectWorkspaceResource,
  ): ProjectWorkspaceResource {
    if (resource.type === 'local') {
      const location = this.db
        .select()
        .from(projectLocations)
        .where(
          and(
            eq(
              projectLocations.localWorkspaceId,
              resource.localWorkspaceId ?? '',
            ),
            eq(projectLocations.projectId, resource.projectId),
          ),
        )
        .get();
      if (!location)
        throw new ConflictException('Local project location is unresolved');
      return {
        ...resource,
        name: location.name,
        accessMode: location.accessMode,
        capabilities: location.capabilities,
      };
    }
    const location = this.db
      .select()
      .from(projectLocations)
      .where(
        and(
          eq(projectLocations.legacyResourceId, resource.id),
          eq(projectLocations.projectId, resource.projectId),
        ),
      )
      .get();
    const connection = location?.connectionId
      ? this.db
          .select()
          .from(projectConnections)
          .where(
            and(
              eq(projectConnections.id, location.connectionId),
              eq(projectConnections.projectId, resource.projectId),
            ),
          )
          .get()
      : null;
    if (!location || !connection)
      throw new ConflictException(
        'Project connection or location is unresolved',
      );
    return {
      ...resource,
      name: location.name,
      type: connection.protocol,
      address: connection.address,
      rootPath: location.path,
      accessMode: location.accessMode,
      capabilities: location.capabilities,
      enabled: connection.enabled,
      connectionState: connection.connectionState,
      lastCheckedAt: connection.lastCheckedAt,
    };
  }

  private view(resource: ProjectWorkspaceResource): WorkspaceResourceView {
    const secret = this.db
      .select({ resourceId: projectWorkspaceSecrets.resourceId })
      .from(projectWorkspaceSecrets)
      .where(eq(projectWorkspaceSecrets.resourceId, resource.id))
      .get();
    const workspace = resource.localWorkspaceId
      ? this.db
          .select({ path: projectWorkspaces.path })
          .from(projectWorkspaces)
          .where(eq(projectWorkspaces.id, resource.localWorkspaceId))
          .get()
      : undefined;
    return {
      ...resource,
      lastError: resource.lastError,
      hasSecret: Boolean(secret),
      localPath: workspace?.path ?? null,
    };
  }

  private ensureLocalResources(projectId: string) {
    const now = Date.now();
    for (const workspace of this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, projectId))
      .all()) {
      this.db
        .insert(projectWorkspaceResources)
        .values({
          id: workspace.id,
          projectId,
          localWorkspaceId: workspace.id,
          name: workspace.name,
          type: 'local',
          address: null,
          rootPath: '/',
          accessMode: 'read_write',
          capabilities: { read: true, write: true, execute: false },
          enabled: true,
          connectionState: 'local',
          createdAt: workspace.createdAt || now,
          updatedAt: workspace.updatedAt || now,
        })
        .onConflictDoUpdate({
          target: projectWorkspaceResources.id,
          set: {
            name: workspace.name,
            localWorkspaceId: workspace.id,
            updatedAt: workspace.updatedAt || now,
          },
        })
        .run();
    }
  }

  private key(): Buffer {
    const source =
      this.config.get<string>('WEBUI_CONNECTION_SECRET_KEY') ??
      this.config.get<string>('WEBUI_API_KEY');
    if (!source)
      throw new ConflictException(
        'Connection secret encryption key is not configured',
      );
    return createHash('sha256').update(source).digest();
  }

  private storeSecret(
    db: AppDatabase,
    resourceId: string,
    value: ConnectionSecret,
    now: number,
  ) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    db.insert(projectWorkspaceSecrets)
      .values({
        resourceId,
        encryptedValue: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  private readSecret(resourceId: string): ConnectionSecret | null {
    const row = this.db
      .select()
      .from(projectWorkspaceSecrets)
      .where(eq(projectWorkspaceSecrets.resourceId, resourceId))
      .get();
    if (!row) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(row.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(row.authTag, 'base64'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(row.encryptedValue, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    ) as ConnectionSecret;
  }

  private secretInput(value: unknown): ConnectionSecret | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException('Connection secret must be an object');
    const allowed = [
      'username',
      'password',
      'token',
      'privateKey',
      'passphrase',
      'knownHosts',
    ] as const;
    const result: ConnectionSecret = {};
    for (const key of allowed) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        if (typeof item !== 'string' || item.length > 64_000)
          throw new BadRequestException('Invalid connection secret');
        result[key] = item;
      }
    }
    return Object.values(result).some(Boolean) ? result : null;
  }

  private requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048)
      throw new BadRequestException(`${label} is required`);
    return value.trim();
  }

  private normalizeRoot(value: unknown): string {
    const root =
      value === undefined ? '/' : this.requiredString(value, 'Allowed root');
    if (root.includes('\0') || root.split(/[\\/]+/).includes('..'))
      throw new BadRequestException(
        'Allowed root must not escape the resource',
      );
    return root;
  }

  private parseEndpoint(
    type: WorkspaceResourceType,
    address: string,
  ): { host: string; port: number } {
    const scheme = type === 'git' ? undefined : type;
    if (type === 'git') {
      if (!/^(https?:\/\/|ssh:\/\/|git@[^:]+:)/i.test(address))
        throw new BadRequestException('Git address must use HTTPS or SSH');
      if (/^https?:\/\//i.test(address)) {
        const url = new URL(address);
        if (url.username || url.password)
          throw new BadRequestException(
            'Credentials must be stored as a connection secret',
          );
      }
      return { host: '', port: 0 };
    }
    let url: URL;
    try {
      url = new URL(
        address.includes('://') ? address : `${scheme}://${address}`,
      );
    } catch {
      throw new BadRequestException('Invalid resource address');
    }
    if (
      !url.hostname ||
      (url.protocol !== `${scheme}:` &&
        !(type === 'sftp' && url.protocol === 'ssh:'))
    )
      throw new BadRequestException(`Address must use ${scheme}://`);
    if (url.username || url.password)
      throw new BadRequestException(
        'Credentials must be stored as a connection secret',
      );
    const defaults = { ssh: 22, sftp: 22, ftp: 21, ftps: 990 };
    return {
      host: url.hostname,
      port: url.port
        ? Number(url.port)
        : defaults[type as keyof typeof defaults],
    };
  }

  private async probe(
    type: WorkspaceResourceType,
    address: string,
    secret: ConnectionSecret | null,
  ) {
    if (type === 'git') return this.probeGit(address, secret);
    const endpoint = this.parseEndpoint(type, address);
    if (type === 'ftps') return this.probeTls(endpoint.host, endpoint.port);
    if (type === 'ftp')
      return this.probeFtp(endpoint.host, endpoint.port, secret);
    return this.probeBanner(endpoint.host, endpoint.port, 'SSH-');
  }

  private probeGit(
    address: string,
    secret: ConnectionSecret | null,
  ): Promise<void> {
    return this.runGit(['ls-remote', '--heads', address], secret, 10_000).then(
      () => undefined,
    );
  }

  private runGit(
    args: string[],
    secret: ConnectionSecret | null,
    timeoutMs: number,
    acceptedExitCodes: number[] = [0],
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let askpassDirectory: string | null = null;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      };
      const token = secret?.token || secret?.password;
      if (token && args.some((argument) => /^https:\/\//i.test(argument))) {
        askpassDirectory = mkdtempSync(join(tmpdir(), 'mergeron-git-'));
        const askpass = join(askpassDirectory, 'askpass.sh');
        writeFileSync(
          askpass,
          '#!/bin/sh\ncase "$1" in *Username*) printf %s "$MERGERON_GIT_USERNAME";; *) printf %s "$MERGERON_GIT_TOKEN";; esac\n',
          { mode: 0o700 },
        );
        chmodSync(askpass, 0o700);
        env.GIT_ASKPASS = askpass;
        env.MERGERON_GIT_USERNAME = secret.username || 'oauth2';
        env.MERGERON_GIT_TOKEN = token;
      }
      const child = spawn('git', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let error = '';
      child.stdout.on('data', (chunk) => {
        if (output.length < 10_000) output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (error.length < 1000) error += String(chunk);
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Git operation timed out'));
      }, timeoutMs);
      child.on('error', (cause) => {
        clearTimeout(timeout);
        if (askpassDirectory)
          rmSync(askpassDirectory, { recursive: true, force: true });
        reject(cause);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (askpassDirectory)
          rmSync(askpassDirectory, { recursive: true, force: true });
        if (code !== null && acceptedExitCodes.includes(code))
          resolve({ stdout: output, stderr: error });
        else
          reject(
            new Error(
              token
                ? 'Git authentication failed'
                : error || 'Git connection failed',
            ),
          );
      });
    });
  }

  private validGitRef(value: string): boolean {
    return (
      value.length <= 200 &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.includes('..') &&
      !value.includes('//') &&
      !value.includes('@{') &&
      !value.includes('/.')
    );
  }

  private probeBanner(
    host: string,
    port: number,
    expected: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const timeout = setTimeout(
        () => socket.destroy(new Error('Connection timed out')),
        8_000,
      );
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.once('data', (data) => {
        clearTimeout(timeout);
        socket.destroy();
        if (String(data).startsWith(expected)) resolve();
        else reject(new Error('Unexpected server response'));
      });
      socket.connect(port, host);
    });
  }

  private probeTls(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connectTls({
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
      });
      const timeout = setTimeout(
        () => socket.destroy(new Error('Connection timed out')),
        8_000,
      );
      socket.once('secureConnect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    });
  }

  private probeFtp(
    host: string,
    port: number,
    secret: ConnectionSecret | null,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const timeout = setTimeout(
        () => socket.destroy(new Error('Connection timed out')),
        8_000,
      );
      let stage = 'banner';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        const line = String(chunk);
        if (stage === 'banner' && line.startsWith('220')) {
          if (!secret?.username) {
            clearTimeout(timeout);
            socket.destroy();
            resolve();
            return;
          }
          stage = 'user';
          socket.write(`USER ${secret.username}\r\n`);
          return;
        }
        if (stage === 'user' && line.startsWith('230')) {
          clearTimeout(timeout);
          socket.destroy();
          resolve();
          return;
        }
        if (
          stage === 'user' &&
          line.startsWith('331') &&
          secret?.password !== undefined
        ) {
          stage = 'pass';
          socket.write(`PASS ${secret.password}\r\n`);
          return;
        }
        if (stage === 'pass' && line.startsWith('230')) {
          clearTimeout(timeout);
          socket.destroy();
          resolve();
          return;
        }
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error('FTP authentication failed'));
      });
      socket.once('error', reject);
      socket.connect(port, host);
    });
  }

  private safeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : 'Connection failed';
    return raw
      .replace(/https?:\/\/[^\s/@]+@/g, 'https://[redacted]@')
      .slice(0, 500);
  }
}
