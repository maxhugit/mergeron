import {
  Injectable,
  Inject,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projects,
  projectAgentThreads,
  projectPreviewProfiles,
  agentPreviews,
} from '../database/schema';
import {
  currentAccess,
  requireProjectAccess,
  requireThreadAccess,
  requireExecutionAccess,
  accessContext,
} from '../auth/access-context';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { workAgentId } from '../projects/git-copy-ownership';
import contract, {
  type PreviewProfile,
} from '../../runtime/preview-profile.cjs';
import { PreviewManagerClient } from './preview-manager-client';
import { previewSnapshot, previewSourceFingerprint } from './preview-snapshot';
import { IdentityService } from '../auth/identity.service';
import {
  PreviewGateway,
  type PreviewGrant,
  type PreviewTransport,
} from '../../runtime/preview-gateway.cjs';

@Injectable()
export class ProjectPreviewsService implements OnModuleInit, OnModuleDestroy {
  private readonly locks = new Set<string>();
  private gateway?: PreviewGateway;
  private timer?: ReturnType<typeof setInterval>;
  private synchronizing = false;
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly config: ConfigService,
    private readonly folders: ActiveFoldersService,
    private readonly manager: PreviewManagerClient,
    private readonly identities: IdentityService,
  ) {}
  async onModuleInit() {
    if (this.config.get<string>('MERGERON_PREVIEWS_ENABLED') !== 'true') return;
    const domain = this.config.get<string>('MERGERON_PREVIEW_DOMAIN');
    const publicUrl = this.config.get<string>('MERGERON_PUBLIC_URL');
    if (!domain || !publicUrl) return;
    if (new URL(publicUrl).protocol !== 'https:')
      throw new Error('PREVIEW_HTTPS_REQUIRED');
    const main = new URL(publicUrl).hostname;
    if (main === domain || main.endsWith('.' + domain))
      throw new Error('PREVIEW_DOMAIN_OVERLAPS_APPLICATION');
    this.gateway = new PreviewGateway({
      domain,
      authorize: (grant) => this.authorizePreview(grant),
    });
    await new Promise<void>((resolve, reject) => {
      this.gateway!.server.once('error', reject);
      this.gateway!.server.listen(8173, '0.0.0.0', resolve);
    });
    this.timer = setInterval(() => {
      void this.synchronizeAll();
    }, 2000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.gateway?.close();
  }
  private async authorizePreview(
    grant: PreviewGrant,
  ): Promise<PreviewTransport> {
    if (
      grant.identity.kind !== 'person' ||
      !grant.identity.personId ||
      grant.identity.impersonation
    )
      throw new ForbiddenException('PREVIEW_ACCESS_DENIED');
    const identity = this.identities.current(grant.identity);
    this.identities.requireActive(identity);
    this.identities.requireProject(identity, grant.projectId);
    this.identities.requireThread(identity, grant.threadId);
    const row = this.row(workAgentId(this.db, grant.threadId));
    if (
      !row ||
      row.projectId !== grant.projectId ||
      row.previewId !== grant.previewId ||
      row.runId !== grant.runId ||
      row.state !== 'running'
    )
      throw new ForbiddenException('PREVIEW_ACCESS_DENIED');
    const result = await this.manager.request('transport', {
      runId: row.runId,
    });
    if (
      result.projectId !== row.projectId ||
      result.agentId !== row.agentId ||
      result.runId !== row.runId ||
      typeof result.endpoint !== 'string' ||
      typeof result.token !== 'string' ||
      typeof result.publicHost !== 'string' ||
      typeof result.expiresAt !== 'number'
    )
      throw new ForbiddenException('PREVIEW_IDENTITY_CHANGED');
    return {
      endpoint: result.endpoint,
      token: result.token,
      publicHost: result.publicHost,
      expiresAt: result.expiresAt,
    };
  }
  async open(projectId: string, threadId: string) {
    const scope = this.scope(projectId, threadId),
      identity = currentAccess()!.identity;
    const row = this.row(scope.agentId),
      recipe = this.stored(projectId);
    if (!this.gateway || !row || !recipe)
      throw new ConflictException('PREVIEW_NOT_CONFIGURED');
    const profile = this.decrypt(recipe.encryptedProfile, projectId);
    return this.gateway.mint(
      {
        projectId,
        threadId,
        previewId: row.previewId,
        runId: row.runId,
        identity,
      },
      profile.path,
    );
  }
  private snapshotDirectory(projectId: string, snapshotId: string) {
    if (!contract.ID.test(projectId) || !contract.RUN_ID.test(snapshotId))
      throw new Error('PREVIEW_INVALID_REQUEST');
    return path.join(
      '/workspaces/.mergeron-system',
      projectId,
      'previews',
      snapshotId,
    );
  }
  private async removeSnapshot(projectId: string, snapshotId: string) {
    const target = this.snapshotDirectory(projectId, snapshotId);
    // These are only our filtered temporary exports, never the working tree,
    // test databases, document versions or application backups.
    if ((await fs.realpath(target).catch(() => '')) !== target) return;
    for (const name of ['source.tar', 'source.tar.tmp'])
      await fs.unlink(path.join(target, name)).catch(() => {});
    await fs.rmdir(target).catch(() => {});
  }
  private async synchronizeAll() {
    if (this.synchronizing) return;
    this.synchronizing = true;
    try {
      const rows = this.db
        .select()
        .from(agentPreviews)
        .where(eq(agentPreviews.state, 'running'))
        .all();
      for (const row of rows) {
        if (!row.ownerPersonId || this.locks.has(row.agentId)) continue;
        const identity = this.identities.resolvePerson(row.ownerPersonId);
        await accessContext.run(
          { identity, identities: this.identities },
          async () => {
            try {
              await this.synchronize(row.projectId, row.threadId, false);
            } catch (error) {
              const message =
                error instanceof Error &&
                /^PREVIEW_[A-Z_]+$/.test(error.message)
                  ? error.message
                  : 'PREVIEW_SYNC_PAUSED';
              this.db
                .update(agentPreviews)
                .set({ error: message })
                .where(
                  and(
                    eq(agentPreviews.agentId, row.agentId),
                    eq(agentPreviews.runId, row.runId),
                  ),
                )
                .run();
            }
          },
        );
      }
    } finally {
      this.synchronizing = false;
    }
  }
  async synchronize(projectId: string, threadId: string, manual = true) {
    const scope = this.scope(projectId, threadId);
    requireExecutionAccess();
    if (this.locks.has(scope.agentId) || this.locks.size >= 2)
      throw new ConflictException('PREVIEW_BUSY');
    this.locks.add(scope.agentId);
    let snapshotId: string | undefined;
    try {
      const row = this.row(scope.agentId),
        recipe = this.stored(projectId);
      if (!row || row.state !== 'running' || !recipe)
        throw new ConflictException('PREVIEW_NOT_RUNNING');
      if (recipe.revision !== row.profileRevision)
        throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
      const profile = this.decrypt(recipe.encryptedProfile, projectId);
      if (!profile.enabled || (!manual && profile.updateMode === 'manual'))
        return;
      const check = () => {
        this.scope(projectId, threadId);
        requireExecutionAccess();
        const active =
          this.folders.resolveAgent(threadId) ?? scope.agent!.workspacePath;
        if (active !== row.sourcePath)
          throw new ConflictException('PREVIEW_SOURCE_CHANGED');
      };
      check();
      const fingerprint = await previewSourceFingerprint(row.sourcePath, check);
      if (fingerprint === row.sourceFingerprint)
        return this.status(projectId, threadId);
      snapshotId = randomUUID();
      const target = this.snapshotDirectory(projectId, snapshotId);
      await fs.mkdir(target, { mode: 0o700 });
      const snapshot = await previewSnapshot(
        row.sourcePath,
        path.join(target, 'source.tar'),
        check,
      );
      if (
        fingerprint !== (await previewSourceFingerprint(row.sourcePath, check))
      )
        throw new ConflictException('PREVIEW_SOURCE_CHANGED');
      check();
      const result = await this.manager.request('sync', {
        runId: row.runId,
        snapshotId,
        sourceSha: snapshot.sha256,
      });
      this.db
        .update(agentPreviews)
        .set({
          sourceSha: snapshot.sha256,
          sourceFingerprint: fingerprint,
          state: String(result.state),
          error: null,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(agentPreviews.agentId, row.agentId),
            eq(agentPreviews.runId, row.runId),
          ),
        )
        .run();
      await this.removeSnapshot(projectId, snapshotId);
      snapshotId = undefined;
      return this.status(projectId, threadId);
    } finally {
      if (snapshotId) await this.removeSnapshot(projectId, snapshotId);
      this.locks.delete(scope.agentId);
    }
  }
  private scope(projectId: string, threadId?: string) {
    if (!currentAccess()) throw new ForbiddenException('PREVIEW_ACCESS_DENIED');
    requireProjectAccess(projectId);
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!project) throw new NotFoundException('PREVIEW_PROJECT_MISSING');
    if (threadId) {
      requireThreadAccess(threadId);
      const agent = this.db
        .select()
        .from(projectAgentThreads)
        .where(
          and(
            eq(projectAgentThreads.threadId, threadId),
            eq(projectAgentThreads.projectId, projectId),
          ),
        )
        .get();
      if (!agent) throw new ForbiddenException('PREVIEW_ACCESS_DENIED');
      return { project, agent, agentId: workAgentId(this.db, threadId) };
    }
    return { project, agent: null, agentId: '' };
  }
  private key() {
    const source =
      this.config.get<string>('WEBUI_CONNECTION_SECRET_KEY') ??
      this.config.get<string>('WEBUI_API_KEY');
    if (!source) throw new ConflictException('PREVIEW_ENCRYPTION_KEY_REQUIRED');
    return createHash('sha256').update(source).digest();
  }
  private decrypt(value: string, projectId: string): PreviewProfile {
    const parsed = JSON.parse(value) as {
      iv: string;
      data: string;
      tag: string;
    };
    const cipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(parsed.iv, 'base64'),
    );
    cipher.setAAD(Buffer.from('mergeron-preview-profile-v1:' + projectId));
    cipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return contract.profile(
      JSON.parse(
        Buffer.concat([
          cipher.update(Buffer.from(parsed.data, 'base64')),
          cipher.final(),
        ]).toString('utf8'),
      ),
    );
  }
  private stored(projectId: string) {
    return this.db
      .select()
      .from(projectPreviewProfiles)
      .where(eq(projectPreviewProfiles.projectId, projectId))
      .get();
  }
  async settings(projectId: string) {
    this.scope(projectId);
    requireExecutionAccess();
    const row = this.stored(projectId);
    let capabilities: Record<string, unknown> = {
      enabled: false,
      runtimes: [],
      error: 'PREVIEW_MANAGER_UNAVAILABLE',
    };
    try {
      capabilities = await this.manager.request('capabilities');
    } catch {
      /* Explicit unavailable status; no fallback execution. */
    }
    return {
      profile: contract.safeProfile(
        row ? this.decrypt(row.encryptedProfile, projectId) : {},
      ),
      revision: row?.revision ?? null,
      capabilities,
      viewer: {
        enabled: this.gateway?.server.listening ?? false,
        domain: this.config.get<string>('MERGERON_PREVIEW_DOMAIN') ?? null,
      },
    };
  }
  saveSettings(
    projectId: string,
    input: { profile?: unknown; expectedRevision?: unknown },
  ) {
    this.scope(projectId);
    requireExecutionAccess();
    const before = this.stored(projectId);
    if (input.expectedRevision !== (before?.revision ?? null))
      throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
    let profile: PreviewProfile;
    try {
      profile = contract.profile(input.profile);
    } catch {
      throw new BadRequestException('PREVIEW_INVALID_CONFIGURATION');
    }
    const previous = before
      ? this.decrypt(before.encryptedProfile, projectId)
      : null;
    for (const [k, v] of Object.entries(profile.env))
      if (v === '[stored]') {
        if (!previous || !(k in previous.env))
          throw new BadRequestException('PREVIEW_SECRET_MISSING');
        profile.env[k] = previous.env[k];
      }
    for (const s of profile.services)
      for (const [k, v] of Object.entries(s.env))
        if (v === '[stored]') {
          const old = previous?.services.find((o) => o.name === s.name)?.env;
          if (!old || !(k in old))
            throw new BadRequestException('PREVIEW_SECRET_MISSING');
          s.env[k] = old[k];
        }
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from('mergeron-preview-profile-v1:' + projectId));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(profile), 'utf8'),
      cipher.final(),
    ]);
    const encryptedProfile = JSON.stringify({
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
    const revision = randomUUID(),
      updatedAt = Date.now();
    this.db
      .insert(projectPreviewProfiles)
      .values({ projectId, encryptedProfile, revision, updatedAt })
      .onConflictDoUpdate({
        target: projectPreviewProfiles.projectId,
        set: { encryptedProfile, revision, updatedAt },
      })
      .run();
    return { profile: contract.safeProfile(profile), revision };
  }
  private row(agentId: string) {
    return this.db
      .select()
      .from(agentPreviews)
      .where(eq(agentPreviews.agentId, agentId))
      .get();
  }
  async status(projectId: string, threadId: string) {
    const scope = this.scope(projectId, threadId),
      row = this.row(scope.agentId);
    if (!row || row.projectId !== projectId) return { preview: null };
    let observed: Record<string, unknown> = {
      state: row.state,
      error: row.error,
    };
    try {
      observed = await this.manager.request('status', { runId: row.runId });
      if (
        observed.runId !== row.runId ||
        observed.projectId !== projectId ||
        observed.agentId !== scope.agentId
      )
        throw new ConflictException('PREVIEW_IDENTITY_CHANGED');
      this.db
        .update(agentPreviews)
        .set({ state: String(observed.state) })
        .where(eq(agentPreviews.agentId, row.agentId))
        .run();
    } catch {
      observed = {
        state: row.state,
        error: row.error ?? 'PREVIEW_MANAGER_UNAVAILABLE',
      };
    }
    return {
      preview: {
        id: row.previewId,
        runId: row.runId,
        state: observed.state,
        error: observed.error ?? row.error,
        sourcePath: row.sourcePath,
        sourceSha: row.sourceSha,
        profileRevision: row.profileRevision,
        expiresAt: observed.expiresAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        url: observed.url ?? null,
        lastSyncedAt: observed.lastSyncedAt ?? null,
        updateMode: observed.updateMode ?? null,
        requiresRestart: observed.requiresRestart ?? false,
      },
    };
  }
  async start(
    projectId: string,
    threadId: string,
    requestId: unknown,
    refresh = false,
    assertActive: () => void = () => {},
  ) {
    const scope = this.scope(projectId, threadId);
    requireExecutionAccess();
    assertActive();
    const identity = currentAccess()!.identity;
    if (
      identity.kind !== 'person' ||
      !identity.personId ||
      identity.impersonation
    )
      throw new ForbiddenException('PREVIEW_PERSONAL_SESSION_REQUIRED');
    if (!this.gateway?.server.listening)
      throw new ConflictException('PREVIEW_NOT_CONFIGURED');
    if (typeof requestId !== 'string' || !contract.ID.test(requestId))
      throw new BadRequestException('PREVIEW_REQUEST_ID_REQUIRED');
    if (this.locks.has(scope.agentId) || this.locks.size >= 2)
      throw new ConflictException('PREVIEW_BUSY');
    this.locks.add(scope.agentId);
    try {
      const recipe = this.stored(projectId);
      if (!recipe)
        throw new ConflictException('PREVIEW_CONFIGURATION_REQUIRED');
      const profile = this.decrypt(recipe.encryptedProfile, projectId);
      if (!profile.enabled || !profile.start.trim())
        throw new ConflictException('PREVIEW_DISABLED');
      const capabilities = await this.manager.request('capabilities');
      if (
        !capabilities.enabled ||
        capabilities.domain !==
          this.config.get<string>('MERGERON_PREVIEW_DOMAIN')
      )
        throw new ConflictException('PREVIEW_NOT_CONFIGURED');
      const existing = this.row(scope.agentId);
      if (existing?.requestId === requestId)
        return this.status(projectId, threadId);
      if (existing && !refresh) {
        const status = await this.manager.request('status', {
          runId: existing.runId,
        });
        if (['running', 'starting'].includes(String(status.state)))
          return this.status(projectId, threadId);
        if (status.state !== 'stopped')
          throw new ConflictException('PREVIEW_RECREATE_REQUIRED');
      }
      if (existing && refresh)
        await this.manager.request('stop', { runId: existing.runId });
      const source =
        this.folders.resolveAgent(threadId) ?? scope.agent!.workspacePath;
      if (
        !source ||
        path
          .resolve(source)
          .split(path.sep)
          .some((p) => p.startsWith('.mergeron'))
      )
        throw new ConflictException('PREVIEW_SOURCE_REQUIRED');
      this.identities.requireWorkspacePath(source, false, identity);
      const runId = randomUUID(),
        previewId = existing?.previewId ?? randomUUID(),
        now = Date.now();
      const system = path.join(
        '/workspaces',
        '.mergeron-system',
        projectId,
        'previews',
      );
      await fs.mkdir(system, { recursive: true, mode: 0o700 });
      if ((await fs.realpath(system)) !== system)
        throw new ConflictException('PREVIEW_UNSAFE_SNAPSHOT');
      const target = path.join(system, runId);
      await fs.mkdir(target, { mode: 0o700 });
      const row = {
        agentId: scope.agentId,
        threadId,
        ownerPersonId: identity.personId,
        sourceFingerprint: null,
        projectId,
        previewId,
        runId,
        requestId,
        sourcePath: source,
        profileRevision: recipe.revision,
        state: 'preparing',
        error: null,
        sourceSha: null,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .insert(agentPreviews)
        .values(row)
        .onConflictDoUpdate({ target: agentPreviews.agentId, set: row })
        .run();
      try {
        const sourceFingerprint = await previewSourceFingerprint(source, () => {
          this.scope(projectId, threadId);
          assertActive();
        });
        const snapshot = await previewSnapshot(
          source,
          path.join(target, 'source.tar'),
          () => {
            this.scope(projectId, threadId);
            assertActive();
          },
        );
        assertActive();
        if (
          sourceFingerprint !==
          (await previewSourceFingerprint(source, () => {
            this.scope(projectId, threadId);
            assertActive();
          }))
        )
          throw new ConflictException('PREVIEW_SOURCE_CHANGED');
        const latest = this.stored(projectId);
        if (latest?.revision !== recipe.revision)
          throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
        this.db
          .update(agentPreviews)
          .set({ sourceSha: snapshot.sha256 })
          .where(eq(agentPreviews.agentId, scope.agentId))
          .run();
        const result = await this.manager.request('start', {
          projectId,
          agentId: scope.agentId,
          previewId,
          runId,
          sourceSha: snapshot.sha256,
          profile,
        });
        this.db
          .update(agentPreviews)
          .set({
            state: String(result.state),
            sourceFingerprint,
            updatedAt: Date.now(),
          })
          .where(eq(agentPreviews.agentId, scope.agentId))
          .run();
        await this.removeSnapshot(projectId, runId);
      } catch (error) {
        // Keep the same run id on uncertain outcomes: inspect, never blind-retry.
        const message =
          error instanceof Error && /^PREVIEW_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'PREVIEW_START_FAILED';
        this.db
          .update(agentPreviews)
          .set({ state: 'unknown', error: message, updatedAt: Date.now() })
          .where(eq(agentPreviews.agentId, scope.agentId))
          .run();
        throw new ConflictException(message);
      } finally {
        await this.removeSnapshot(projectId, runId);
      }
      return this.status(projectId, threadId);
    } finally {
      this.locks.delete(scope.agentId);
    }
  }
  async stop(projectId: string, threadId: string) {
    const scope = this.scope(projectId, threadId);
    requireExecutionAccess();
    if (this.locks.has(scope.agentId))
      throw new ConflictException('PREVIEW_BUSY');
    this.locks.add(scope.agentId);
    try {
      const row = this.row(scope.agentId);
      if (!row) return { preview: null };
      await this.manager.request('stop', { runId: row.runId });
      return this.status(projectId, threadId);
    } finally {
      this.locks.delete(scope.agentId);
    }
  }
  async logs(projectId: string, threadId: string) {
    const scope = this.scope(projectId, threadId);
    const row = this.row(scope.agentId);
    if (!row) throw new NotFoundException('PREVIEW_NOT_FOUND');
    return this.manager.request('logs', { runId: row.runId });
  }
  async tool(
    projectId: string,
    threadId: string,
    input: Record<string, unknown>,
    assertActive: () => void,
  ) {
    this.scope(projectId, threadId);
    assertActive();
    if (
      Object.keys(input).some(
        (k) => !['tool', 'operation', 'requestId'].includes(k),
      )
    )
      throw new BadRequestException('PREVIEW_INVALID_REQUEST');
    if (input.operation === 'status') return this.status(projectId, threadId);
    if (input.operation === 'logs') return this.logs(projectId, threadId);
    if (input.operation === 'sync')
      return this.synchronize(projectId, threadId);
    if (input.operation === 'start' || input.operation === 'refresh')
      return this.start(
        projectId,
        threadId,
        input.requestId,
        input.operation === 'refresh',
        assertActive,
      );
    if (input.operation === 'stop') return this.stop(projectId, threadId);
    throw new BadRequestException('PREVIEW_INVALID_REQUEST');
  }
}
