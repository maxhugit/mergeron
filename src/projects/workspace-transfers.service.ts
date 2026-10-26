import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir, opendir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import {
  currentAccess,
  requireExecutionAccess,
  requireProjectAccess,
} from '../auth/access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import {
  projectActivity,
  projectWorkspaceCopies,
  projectWorkspaceResources,
  projectWorkspaceTransferRuns,
  projectWorkspaceTransfers,
  projectWorkspaces,
  type ProjectWorkspaceTransfer,
  type ProjectWorkspaceTransferRun,
} from '../database/schema';
import {
  type ConnectionSecret,
  WorkspaceResourcesService,
} from './workspace-resources.service';

type TransferChange = ProjectWorkspaceTransferRun['changes'][number];
type FileInventory = Map<string, { size: number; hash: string }>;

@Injectable()
export class WorkspaceTransfersService {
  private readonly destinationLocks = new Set<string>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  list(projectId: string) {
    requireProjectAccess(projectId);
    this.cleanupExpiredStaging(projectId);
    return {
      transfers: this.db
        .select()
        .from(projectWorkspaceTransfers)
        .where(eq(projectWorkspaceTransfers.projectId, projectId))
        .all(),
      runs: this.db
        .select()
        .from(projectWorkspaceTransferRuns)
        .where(eq(projectWorkspaceTransferRuns.projectId, projectId))
        .orderBy(desc(projectWorkspaceTransferRuns.startedAt))
        .limit(50)
        .all()
        .map((run) => ({ ...run, stagingPath: null })),
    };
  }

  create(projectId: string, input: Record<string, unknown>) {
    requireExecutionAccess();
    requireProjectAccess(projectId);
    const now = Date.now();
    const transfer: ProjectWorkspaceTransfer = {
      id: randomUUID(),
      projectId,
      name: this.requiredName(input.name),
      sourceResourceId: this.requiredId(input.sourceResourceId, 'Source'),
      destinationWorkspaceId: this.requiredId(
        input.destinationWorkspaceId,
        'Destination',
      ),
      sourcePath: this.relativePath(input.sourcePath),
      destinationPath: this.relativePath(input.destinationPath),
      exclusions: this.exclusions(input.exclusions),
      conflictPolicy:
        input.conflictPolicy === 'overwrite' ? 'overwrite' : 'skip',
      propagateDeletes: input.propagateDeletes === true,
      createdAt: now,
      updatedAt: now,
    };
    this.resolveEndpoints(transfer);
    this.db.insert(projectWorkspaceTransfers).values(transfer).run();
    this.activity(projectId, 'workspace_transfer_created', transfer, {});
    return transfer;
  }

  remove(projectId: string, id: string) {
    requireExecutionAccess();
    const transfer = this.get(projectId, id);
    const runs = this.db
      .select({ stagingPath: projectWorkspaceTransferRuns.stagingPath })
      .from(projectWorkspaceTransferRuns)
      .where(eq(projectWorkspaceTransferRuns.transferId, id))
      .all();
    for (const run of runs)
      if (run.stagingPath)
        rmSync(run.stagingPath, { recursive: true, force: true });
    this.db
      .delete(projectWorkspaceTransfers)
      .where(eq(projectWorkspaceTransfers.id, id))
      .run();
    this.activity(projectId, 'workspace_transfer_removed', transfer, {});
    return { ok: true };
  }

  async preview(projectId: string, id: string) {
    requireExecutionAccess();
    this.cleanupExpiredStaging(projectId);
    const transfer = this.get(projectId, id);
    const runId = randomUUID();
    const endpoints = this.resolveEndpoints(transfer);
    let stagingPath: string | null = null;
    let sourceRoot = endpoints.sourcePath;
    if (!sourceRoot) {
      stagingPath = path.join(
        endpoints.primaryPath,
        '.mergeron',
        'transfers',
        runId,
      );
      await mkdir(stagingPath, { recursive: true });
      await this.downloadRemote(
        endpoints.source,
        endpoints.secret,
        transfer.sourcePath,
        stagingPath,
        transfer.exclusions,
      );
      sourceRoot = stagingPath;
    }
    const [sourceFiles, destinationFiles] = await Promise.all([
      this.inventory(sourceRoot, transfer.exclusions),
      this.inventory(endpoints.destinationPath, []),
    ]);
    const changes = this.plan(
      sourceFiles,
      destinationFiles,
      transfer.conflictPolicy,
      transfer.propagateDeletes,
    );
    const summary = this.summary(changes);
    const planHash = this.planHash(transfer, changes);
    const identity = currentAccess()?.identity;
    const run: ProjectWorkspaceTransferRun = {
      id: runId,
      projectId,
      transferId: id,
      status: 'previewed',
      planHash,
      changes,
      summary,
      stagingPath,
      error: null,
      actorPersonId: identity?.personId ?? null,
      actorName: identity?.name ?? 'Système',
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.db.insert(projectWorkspaceTransferRuns).values(run).run();
    this.activity(projectId, 'workspace_transfer_previewed', transfer, {
      runId,
      summary,
      propagateDeletes: transfer.propagateDeletes,
    });
    return { ...run, stagingPath: null };
  }

  async execute(projectId: string, id: string, runId: string) {
    requireExecutionAccess();
    const transfer = this.get(projectId, id);
    const run = this.db
      .select()
      .from(projectWorkspaceTransferRuns)
      .where(
        and(
          eq(projectWorkspaceTransferRuns.id, runId),
          eq(projectWorkspaceTransferRuns.transferId, id),
        ),
      )
      .get();
    if (!run) throw new NotFoundException('Transfer preview not found');
    if (run.status === 'success' || run.status === 'completed_with_conflicts')
      return { run: { ...run, stagingPath: null }, idempotent: true };
    if (!['previewed', 'error'].includes(run.status))
      throw new ConflictException('Transfer is already running');
    if (this.planHash(transfer, run.changes) !== run.planHash)
      throw new ConflictException(
        'Transfer settings changed after preview. Create a new preview.',
      );
    const endpoints = this.resolveEndpoints(transfer);
    const lock = path.resolve(endpoints.destinationPath);
    if (this.destinationLocks.has(lock))
      throw new ConflictException(
        'Another transfer is already writing to this destination',
      );
    this.destinationLocks.add(lock);
    this.db
      .update(projectWorkspaceTransferRuns)
      .set({ status: 'running', error: null })
      .where(eq(projectWorkspaceTransferRuns.id, runId))
      .run();
    try {
      const sourceRoot = run.stagingPath ?? endpoints.sourcePath;
      if (!sourceRoot || !existsSync(sourceRoot))
        throw new ConflictException(
          'The prepared source is unavailable. Create a new preview.',
        );
      await this.applyPlan(sourceRoot, endpoints.destinationPath, run.changes);
      const hasConflicts = run.changes.some(
        (change) => change.action === 'conflict',
      );
      const status = hasConflicts ? 'completed_with_conflicts' : 'success';
      const finishedAt = Date.now();
      this.db
        .update(projectWorkspaceTransferRuns)
        .set({ status, finishedAt, stagingPath: null, error: null })
        .where(eq(projectWorkspaceTransferRuns.id, runId))
        .run();
      if (run.stagingPath)
        await rm(run.stagingPath, { recursive: true, force: true });
      this.activity(projectId, 'workspace_transfer_completed', transfer, {
        runId,
        status,
        summary: run.summary,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Workspace transfer failed';
      this.db
        .update(projectWorkspaceTransferRuns)
        .set({ status: 'error', error: message, finishedAt: Date.now() })
        .where(eq(projectWorkspaceTransferRuns.id, runId))
        .run();
      this.activity(projectId, 'workspace_transfer_failed', transfer, {
        runId,
        error: message,
      });
      throw error;
    } finally {
      this.destinationLocks.delete(lock);
    }
    const completed = this.db
      .select()
      .from(projectWorkspaceTransferRuns)
      .where(eq(projectWorkspaceTransferRuns.id, runId))
      .get()!;
    return { run: { ...completed, stagingPath: null }, idempotent: false };
  }

  private get(projectId: string, id: string) {
    requireProjectAccess(projectId);
    const transfer = this.db
      .select()
      .from(projectWorkspaceTransfers)
      .where(
        and(
          eq(projectWorkspaceTransfers.id, id),
          eq(projectWorkspaceTransfers.projectId, projectId),
        ),
      )
      .get();
    if (!transfer) throw new NotFoundException('Workspace transfer not found');
    return transfer;
  }

  private resolveEndpoints(transfer: ProjectWorkspaceTransfer) {
    const { resource: source, secret } = this.resources.resolveForTransfer(
      transfer.projectId,
      transfer.sourceResourceId,
    );
    if (!source.enabled || !source.capabilities.read)
      throw new ConflictException('Transfer source is disabled or unreadable');
    if (source.type === 'git' || source.type === 'ssh')
      throw new ConflictException(
        source.type === 'git'
          ? 'Create a Git working copy before using it in a transfer'
          : 'Remote SSH execution is not allowed. Use an SFTP resource.',
      );
    const destination = this.db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.id, transfer.destinationWorkspaceId),
          eq(projectWorkspaces.projectId, transfer.projectId),
        ),
      )
      .get();
    if (!destination)
      throw new NotFoundException('Destination workspace not found');
    const folders = new ActiveFoldersService(this.db);
    const destinationPolicy = folders.executionLocationForCwd(
      destination.path,
      transfer.projectId,
    );
    if (!destinationPolicy || destinationPolicy.readOnly)
      throw new ConflictException(
        'Destination location is read-only or unavailable',
      );
    if (source.localWorkspaceId)
      folders.validateLocationSelection(transfer.projectId, {
        locationId: `local:${source.localWorkspaceId}`,
      });
    const copy = this.db
      .select()
      .from(projectWorkspaceCopies)
      .where(eq(projectWorkspaceCopies.localWorkspaceId, destination.id))
      .get();
    if (copy) {
      const copySource = this.db
        .select()
        .from(projectWorkspaceResources)
        .where(eq(projectWorkspaceResources.id, copy.sourceResourceId))
        .get();
      if (
        !copySource ||
        !copySource.enabled ||
        copySource.accessMode !== 'read_write' ||
        copy.state !== 'ready'
      )
        throw new ConflictException(
          'Destination working copy is read-only or revoked',
        );
    }
    const primary = this.db
      .select({ path: projectWorkspaces.path })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.projectId, transfer.projectId),
          eq(projectWorkspaces.primary, true),
        ),
      )
      .get();
    if (!primary) throw new ConflictException('Primary workspace is missing');
    const sourcePath = source.localWorkspaceId
      ? this.confined(
          this.db
            .select({ path: projectWorkspaces.path })
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.id, source.localWorkspaceId))
            .get()?.path ?? '',
          transfer.sourcePath,
        )
      : null;
    const destinationPath = this.confined(
      destination.path,
      transfer.destinationPath,
    );
    if (
      sourcePath &&
      (sourcePath === destinationPath ||
        sourcePath.startsWith(destinationPath + path.sep) ||
        destinationPath.startsWith(sourcePath + path.sep))
    )
      throw new ConflictException(
        'Transfer source and destination folders must not overlap',
      );
    return {
      source,
      secret,
      sourcePath,
      destinationPath,
      primaryPath: primary.path,
    };
  }

  private async inventory(root: string, exclusions: string[]) {
    const result: FileInventory = new Map();
    if (!existsSync(root)) return result;
    const visit = async (directory: string, prefix: string) => {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (this.excluded(relative, exclusions)) continue;
        if (entry.isSymbolicLink())
          throw new ConflictException(
            `Symbolic links are not transferable: ${relative}`,
          );
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute, relative);
        else if (entry.isFile()) {
          if (result.size >= 10_000)
            throw new ConflictException('Transfer exceeds 10,000 files');
          const info = await stat(absolute);
          result.set(relative, {
            size: info.size,
            hash: await this.hashFile(absolute),
          });
        }
      }
    };
    await visit(root, '');
    return result;
  }

  private plan(
    source: FileInventory,
    destination: FileInventory,
    policy: ProjectWorkspaceTransfer['conflictPolicy'],
    propagateDeletes: boolean,
  ): TransferChange[] {
    const changes: TransferChange[] = [];
    for (const [file, sourceInfo] of [...source].sort()) {
      const current = destination.get(file);
      changes.push({
        path: file,
        action: !current
          ? 'create'
          : current.hash === sourceInfo.hash
            ? 'unchanged'
            : policy === 'overwrite'
              ? 'update'
              : 'conflict',
        size: sourceInfo.size,
        sourceHash: sourceInfo.hash,
        destinationHash: current?.hash ?? null,
      });
    }
    if (propagateDeletes)
      for (const [file, current] of [...destination].sort())
        if (!source.has(file))
          changes.push({
            path: file,
            action: 'delete',
            size: current.size,
            sourceHash: null,
            destinationHash: current.hash,
          });
    return changes;
  }

  private async applyPlan(
    sourceRoot: string,
    destinationRoot: string,
    changes: TransferChange[],
  ) {
    await mkdir(destinationRoot, { recursive: true });
    for (const change of changes) {
      if (change.action === 'unchanged' || change.action === 'conflict')
        continue;
      const destination = this.confined(destinationRoot, change.path);
      const currentHash = existsSync(destination)
        ? await this.hashFile(destination)
        : null;
      if (change.action === 'delete') {
        if (currentHash === null) continue;
        if (currentHash !== change.destinationHash)
          throw new ConflictException(
            `Destination changed after preview: ${change.path}`,
          );
        await rm(destination);
        continue;
      }
      if (currentHash === change.sourceHash) continue;
      if (currentHash !== change.destinationHash)
        throw new ConflictException(
          `Destination changed after preview: ${change.path}`,
        );
      const source = this.confined(sourceRoot, change.path);
      if ((await this.hashFile(source)) !== change.sourceHash)
        throw new ConflictException(
          `Source changed after preview: ${change.path}`,
        );
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.mergeron-${randomUUID()}.tmp`;
      await copyFile(source, temporary);
      await rename(temporary, destination);
    }
  }

  private async downloadRemote(
    resource: ReturnType<
      WorkspaceResourcesService['resolveForTransfer']
    >['resource'],
    secret: ConnectionSecret | null,
    sourcePath: string,
    target: string,
    exclusions: string[],
  ) {
    if (!resource.address)
      throw new ConflictException('Remote resource has no address');
    const base = new URL(resource.address);
    base.pathname = this.urlPath(resource.rootPath, sourcePath);
    const queue: Array<{ url: URL; relative: string }> = [
      { url: base, relative: '' },
    ];
    let files = 0;
    while (queue.length) {
      const current = queue.shift()!;
      const listing = await this.curl(current.url, secret);
      for (const item of this.parseRemoteListing(listing)) {
        const relative = current.relative
          ? `${current.relative}/${item.name}`
          : item.name;
        if (this.excluded(relative, exclusions)) continue;
        const url = new URL(current.url);
        url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(item.name)}`;
        if (item.directory) {
          url.pathname += '/';
          queue.push({ url, relative });
          continue;
        }
        files += 1;
        if (files > 10_000)
          throw new ConflictException('Transfer exceeds 10,000 files');
        const output = this.confined(target, relative);
        await mkdir(path.dirname(output), { recursive: true });
        await this.curl(url, secret, output);
      }
    }
  }

  private parseRemoteListing(value: string) {
    const result: Array<{ name: string; directory: boolean }> = [];
    for (const raw of value.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line === '.' || line === '..') continue;
      const mlsd = line.match(/^(.+;)\s*(.+)$/);
      if (mlsd) {
        const type = mlsd[1].match(/(?:^|;)type=([^;]+)/i)?.[1];
        if (type === 'cdir' || type === 'pdir') continue;
        result.push({ name: mlsd[2], directory: type === 'dir' });
        continue;
      }
      const parts = line.split(/\s+/);
      if (!/^[dl-][rwxstST-]{9}$/.test(parts[0] ?? '') || parts.length < 9)
        throw new ConflictException(
          'Remote directory listing format is not supported',
        );
      const name = parts.slice(8).join(' ');
      if (!name || name === '.' || name === '..') continue;
      if (parts[0][0] === 'l')
        throw new ConflictException(`Remote symbolic link refused: ${name}`);
      result.push({ name, directory: parts[0][0] === 'd' });
    }
    return result;
  }

  private curl(
    url: URL,
    secret: ConnectionSecret | null,
    output?: string,
  ): Promise<string> {
    const temporary = mkdtempSync(path.join(tmpdir(), 'mergeron-transfer-'));
    const configPath = path.join(temporary, 'curl.conf');
    const config: string[] = [
      'silent',
      'show-error',
      'fail',
      'max-time = 120',
      'disable-epsv',
    ];
    if (secret?.username || secret?.password)
      config.push(
        `user = "${this.curlEscape(`${secret.username ?? ''}:${secret.password ?? ''}`)}"`,
      );
    if (secret?.privateKey) {
      const keyPath = path.join(temporary, 'key');
      writeFileSync(keyPath, secret.privateKey, { mode: 0o600 });
      config.push(`key = "${this.curlEscape(keyPath)}"`);
      if (secret.passphrase)
        config.push(`pass = "${this.curlEscape(secret.passphrase)}"`);
    }
    if (secret?.knownHosts) {
      const knownHostsPath = path.join(temporary, 'known_hosts');
      writeFileSync(knownHostsPath, secret.knownHosts, { mode: 0o600 });
      config.push(`knownhosts = "${this.curlEscape(knownHostsPath)}"`);
    }
    writeFileSync(configPath, `${config.join('\n')}\n`, { mode: 0o600 });
    return new Promise((resolve, reject) => {
      const args = ['--config', configPath];
      if (output) args.push('--output', output);
      args.push(url.toString());
      const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        if (stdout.length < 5_000_000) stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 2_000) stderr += String(chunk);
      });
      child.on('error', (error) => {
        rmSync(temporary, { recursive: true, force: true });
        reject(error);
      });
      child.on('close', (code) => {
        rmSync(temporary, { recursive: true, force: true });
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || 'Remote transfer failed'));
      });
    });
  }

  private urlPath(root: string, relative: string) {
    const parts = [...root.split('/'), ...relative.split('/')]
      .filter(Boolean)
      .map(encodeURIComponent);
    return `/${parts.join('/')}${parts.length ? '/' : ''}`;
  }

  private curlEscape(value: string) {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  }

  private confined(root: string, relative: string) {
    if (!root) throw new ConflictException('Workspace path is unavailable');
    const base = path.resolve(root);
    const candidate = path.resolve(base, relative || '.');
    if (candidate !== base && !candidate.startsWith(base + path.sep))
      throw new BadRequestException('Transfer path leaves its resource');
    let cursor = base;
    for (const part of path.relative(base, candidate).split(path.sep)) {
      if (!part || part === '.') continue;
      cursor = path.join(cursor, part);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
        throw new ConflictException('Transfer paths cannot contain symlinks');
    }
    return candidate;
  }

  private excluded(file: string, patterns: string[]) {
    const normalized = file.replaceAll('\\', '/');
    if (
      normalized === '.git' ||
      normalized.startsWith('.git/') ||
      normalized.includes('/.git/') ||
      normalized === '.mergeron' ||
      normalized.startsWith('.mergeron/') ||
      normalized.includes('/.mergeron/')
    )
      return true;
    return patterns.some((pattern) => this.glob(pattern, normalized));
  }

  private glob(pattern: string, value: string) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('**', '\u0000')
      .replaceAll('*', '[^/]*')
      .replaceAll('?', '[^/]')
      .replaceAll('\u0000', '.*');
    return new RegExp(`^(?:${escaped})(?:/.*)?$`).test(value);
  }

  private hashFile(file: string) {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(file);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  private summary(changes: TransferChange[]) {
    const result: Record<string, number> = {
      create: 0,
      update: 0,
      conflict: 0,
      delete: 0,
      unchanged: 0,
    };
    for (const change of changes) result[change.action] += 1;
    return result;
  }

  private planHash(
    transfer: ProjectWorkspaceTransfer,
    changes: TransferChange[],
  ) {
    return createHash('sha256')
      .update(
        JSON.stringify({
          transfer: {
            sourceResourceId: transfer.sourceResourceId,
            destinationWorkspaceId: transfer.destinationWorkspaceId,
            sourcePath: transfer.sourcePath,
            destinationPath: transfer.destinationPath,
            exclusions: transfer.exclusions,
            conflictPolicy: transfer.conflictPolicy,
            propagateDeletes: transfer.propagateDeletes,
          },
          changes,
        }),
      )
      .digest('hex');
  }

  private requiredName(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || value.length > 120)
      throw new BadRequestException('Transfer name is required');
    return value.trim();
  }

  private requiredId(value: unknown, label: string) {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${label} is required`);
    return value.trim();
  }

  private relativePath(value: unknown) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || value.includes('\0'))
      throw new BadRequestException('Transfer path must be relative');
    const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
    if (
      path.posix.isAbsolute(normalized) ||
      normalized === '..' ||
      normalized.startsWith('../')
    )
      throw new BadRequestException('Transfer path must stay in its resource');
    return normalized === '.' ? '' : normalized;
  }

  private exclusions(value: unknown) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 100)
      throw new BadRequestException('Exclusions must be a list');
    return value.map((item) => {
      if (
        typeof item !== 'string' ||
        !item.trim() ||
        item.length > 200 ||
        item.includes('\0') ||
        item.startsWith('/') ||
        item.split('/').includes('..')
      )
        throw new BadRequestException('Invalid exclusion pattern');
      return item.trim().replaceAll('\\', '/');
    });
  }

  private activity(
    projectId: string,
    action: string,
    transfer: ProjectWorkspaceTransfer,
    details: Record<string, unknown>,
  ) {
    const identity = currentAccess()?.identity;
    this.db
      .insert(projectActivity)
      .values({
        id: randomUUID(),
        projectId,
        action,
        entityType: 'workspace_transfer',
        entityId: transfer.id,
        label: transfer.name,
        details,
        actorPersonId: identity?.personId ?? null,
        actorName: identity?.name ?? 'Système',
        createdAt: Date.now(),
      })
      .run();
  }

  private cleanupExpiredStaging(projectId: string) {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const run of this.db
      .select()
      .from(projectWorkspaceTransferRuns)
      .where(eq(projectWorkspaceTransferRuns.projectId, projectId))
      .all()) {
      if (!run.stagingPath || run.startedAt >= cutoff) continue;
      rmSync(run.stagingPath, { recursive: true, force: true });
      this.db
        .update(projectWorkspaceTransferRuns)
        .set({
          status: 'error',
          stagingPath: null,
          error: 'Transfer preview expired',
          finishedAt: Date.now(),
        })
        .where(eq(projectWorkspaceTransferRuns.id, run.id))
        .run();
    }
  }
}
