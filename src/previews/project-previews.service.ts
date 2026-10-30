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
  agentPreviewRecipes,
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
import storage from '../../runtime/preview-storage.cjs';
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
    const effective = this.effectiveProfile(grant.projectId, row.agentId);
    if (
      !effective.profile.enabled ||
      effective.revision !== row.profileRevision
    )
      throw new ForbiddenException('PREVIEW_CONFIGURATION_CHANGED');
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
    const row = this.row(scope.agentId);
    const effective = this.effectiveProfile(projectId, scope.agentId);
    if (
      !this.gateway ||
      !row ||
      !effective.profile.enabled ||
      effective.revision !== row.profileRevision
    )
      throw new ConflictException('PREVIEW_NOT_CONFIGURED');
    const observed = await this.status(projectId, threadId);
    if (observed.preview?.ready !== true)
      throw new ConflictException('PREVIEW_NOT_READY');
    this.scope(projectId, threadId);
    return this.gateway.mint(
      {
        projectId,
        threadId,
        previewId: row.previewId,
        runId: row.runId,
        identity,
      },
      effective.profile.path,
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
  async synchronize(
    projectId: string,
    threadId: string,
    manual = true,
    assertActive: () => void = () => {},
  ) {
    const scope = this.scope(projectId, threadId);
    requireExecutionAccess();
    if (this.locks.has(scope.agentId) || this.locks.size >= 2)
      throw new ConflictException('PREVIEW_BUSY');
    this.locks.add(scope.agentId);
    let snapshotId: string | undefined;
    try {
      const row = this.row(scope.agentId);
      if (row && row.projectId !== projectId)
        throw new ForbiddenException('PREVIEW_IDENTITY_CHANGED');
      if (!row || row.state !== 'running')
        throw new ConflictException('PREVIEW_NOT_RUNNING');
      const recipe = this.effectiveProfile(projectId, scope.agentId);
      if (recipe.revision !== row.profileRevision)
        throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
      const profile = recipe.profile;
      if (!profile.enabled || (!manual && profile.updateMode === 'manual'))
        return;
      const check = () => {
        this.scope(projectId, threadId);
        requireExecutionAccess();
        assertActive();
        if (
          this.effectiveProfile(projectId, scope.agentId).revision !==
          recipe.revision
        )
          throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
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
    return contract.profile(this.decryptValue(value, projectId));
  }
  private decryptValue(value: string, binding: string): unknown {
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
    cipher.setAAD(Buffer.from('mergeron-preview-profile-v1:' + binding));
    cipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(parsed.data, 'base64')),
        cipher.final(),
      ]).toString('utf8'),
    );
  }
  private encryptValue(value: unknown, binding: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from('mergeron-preview-profile-v1:' + binding));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return JSON.stringify({
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
  }
  private agentRecipe(projectId: string, agentId: string) {
    const row = this.db
      .select()
      .from(agentPreviewRecipes)
      .where(eq(agentPreviewRecipes.agentId, agentId))
      .get();
    return row?.projectId === projectId ? row : undefined;
  }
  private recipeBinding(projectId: string, agentId: string) {
    return JSON.stringify(['agent', projectId, agentId]);
  }
  private effectiveProfile(projectId: string, agentId: string) {
    const policy = this.stored(projectId);
    if (!policy) throw new ConflictException('PREVIEW_CONFIGURATION_REQUIRED');
    const approved = this.decrypt(policy.encryptedProfile, projectId);
    if (!approved.agentManaged)
      return { profile: approved, revision: policy.revision };
    const recipe = this.agentRecipe(projectId, agentId);
    if (!recipe) throw new ConflictException('PREVIEW_PREPARATION_REQUIRED');
    if (recipe.policyRevision !== policy.revision)
      throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
    return {
      profile: contract.agentProfile(
        approved,
        this.decryptValue(
          recipe.encryptedRecipe,
          this.recipeBinding(projectId, agentId),
        ),
      ),
      revision: policy.revision + ':' + recipe.revision,
    };
  }
  /** Persistent project delegation, not an agent-selected execution capability. */
  async prepare(
    projectId: string,
    threadId: string,
    input: Record<string, unknown>,
    assertActive: () => void,
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
    if (
      typeof input.requestId !== 'string' ||
      !contract.ID.test(input.requestId)
    )
      throw new BadRequestException('PREVIEW_REQUEST_ID_REQUIRED');
    const policy = this.stored(projectId);
    if (!policy) throw new ConflictException('PREVIEW_CONFIGURATION_REQUIRED');
    const approved = this.decrypt(policy.encryptedProfile, projectId);
    let recipe: ReturnType<typeof contract.agentRecipe>;
    try {
      recipe = contract.agentRecipe(input.recipe);
      contract.agentProfile(approved, recipe);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'PREVIEW_AGENT_NOT_AUTHORIZED'
      )
        throw new ForbiddenException(error.message);
      throw new BadRequestException(
        error instanceof Error &&
          error.message === 'PREVIEW_RUNTIME_NOT_ALLOWED'
          ? error.message
          : 'PREVIEW_INVALID_CONFIGURATION',
      );
    }
    if (input.policyRevision !== policy.revision)
      throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
    if (this.locks.has(scope.agentId))
      throw new ConflictException('PREVIEW_BUSY');
    this.locks.add(scope.agentId);
    try {
      const fingerprint = contract.fingerprint(recipe);
      const before = this.agentRecipe(projectId, scope.agentId);
      if (
        before?.requestId === input.requestId &&
        (before.fingerprint !== fingerprint ||
          before.policyRevision !== policy.revision)
      )
        throw new ConflictException('PREVIEW_REQUEST_CONFLICT');
      if (
        before?.fingerprint === fingerprint &&
        before.policyRevision === policy.revision
      )
        return {
          state: 'prepared',
          recipeRevision: before.revision,
          reused: true,
        };
      if (input.expectedRevision !== (before?.revision ?? null))
        throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
      const instance = this.row(scope.agentId);
      if (instance && instance.projectId !== projectId)
        throw new ForbiddenException('PREVIEW_IDENTITY_CHANGED');
      if (
        instance &&
        instance.projectId === projectId &&
        instance.state !== 'stopped'
      )
        throw new ConflictException('PREVIEW_STOP_BEFORE_PREPARE');
      const capabilities = await this.manager.request('capabilities', {}, 1500);
      assertActive();
      if (this.scope(projectId, threadId).agentId !== scope.agentId)
        throw new ForbiddenException('PREVIEW_IDENTITY_CHANGED');
      requireExecutionAccess();
      if (this.stored(projectId)?.revision !== policy.revision)
        throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
      const runtimes = Array.isArray(capabilities.runtimes)
        ? capabilities.runtimes.map((v: { id?: unknown }) => v?.id)
        : [];
      if (
        capabilities.enabled !== true ||
        capabilities.domain !==
          this.config.get<string>('MERGERON_PREVIEW_DOMAIN')
      )
        throw new ConflictException('PREVIEW_NOT_CONFIGURED');
      if (
        [recipe.runtime, ...recipe.services.map((s) => s.runtime)].some(
          (id) => !runtimes.includes(id),
        )
      )
        throw new BadRequestException('PREVIEW_RUNTIME_NOT_ALLOWED');
      const row = {
        agentId: scope.agentId,
        projectId,
        encryptedRecipe: this.encryptValue(
          recipe,
          this.recipeBinding(projectId, scope.agentId),
        ),
        revision: randomUUID(),
        policyRevision: policy.revision,
        requestId: input.requestId,
        fingerprint,
        updatedAt: Date.now(),
      };
      this.db
        .insert(agentPreviewRecipes)
        .values(row)
        .onConflictDoUpdate({ target: agentPreviewRecipes.agentId, set: row })
        .run();
      return { state: 'prepared', recipeRevision: row.revision, reused: false };
    } finally {
      this.locks.delete(scope.agentId);
    }
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
    const encryptedProfile = this.encryptValue(profile, projectId);
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
  async status(projectId: string, threadId: string, deadlineMs?: number) {
    const scope = this.scope(projectId, threadId),
      row = this.row(scope.agentId);
    const policy = this.stored(projectId);
    const defaultLifetimeMinutes = policy
      ? this.decrypt(policy.encryptedProfile, projectId).lifetimeMinutes
      : 300;
    if (!row || row.projectId !== projectId)
      return { preview: null, defaultLifetimeMinutes };
    let observed: Record<string, unknown> = {
      state: row.state,
      error: row.error,
    };
    try {
      observed = await this.manager.request(
        'status',
        { runId: row.runId },
        deadlineMs,
      );
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
      defaultLifetimeMinutes,
      preview: {
        id: row.previewId,
        runId: row.runId,
        state: observed.state,
        error: observed.error ?? row.error,
        sourcePath: row.sourcePath,
        sourceSha: row.sourceSha,
        profileRevision: row.profileRevision,
        expiresAt: observed.expiresAt ?? null,
        lifetimeMinutes: observed.lifetimeMinutes,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        url: observed.ready === true ? (observed.url ?? null) : null,
        lastSyncedAt: observed.lastSyncedAt ?? null,
        updateMode: observed.updateMode ?? null,
        requiresRestart: observed.requiresRestart ?? false,
        ready: observed.ready === true,
        httpStatus:
          typeof observed.httpStatus === 'number' ? observed.httpStatus : null,
        storage: storage.safeStorageStatus(observed.storage),
        cleanup:
          observed.state === 'stopped' && observed.cleanupComplete === true
            ? {
                runtimeResourcesRemoved: true,
                sourceFilesPreserved: true,
                launchConfigurationRetained: true,
                historyRetained: true,
              }
            : null,
      },
    };
  }
  /** Read-only discovery; no recipe, environment values, credentials or grant. */
  async discovery(projectId: string, threadId: string) {
    this.scope(projectId, threadId);
    const [capabilities, status] = await Promise.all([
      this.manager.request('capabilities', {}, 1500).catch(() => null),
      this.status(projectId, threadId, 1500),
    ]);
    // Recheck the caller and binding after awaiting the Manager. No snapshot
    // from another project or a revoked conversation may enter the next turn.
    const scope = this.scope(projectId, threadId);
    const reasons: string[] = [];
    const domain = this.config.get<string>('MERGERON_PREVIEW_DOMAIN');
    const platformEnabled =
      this.config.get<string>('MERGERON_PREVIEWS_ENABLED') === 'true';
    if (!platformEnabled) reasons.push('server_disabled');
    if (!domain) reasons.push('preview_domain_missing');
    if (platformEnabled && !this.gateway?.server.listening)
      reasons.push('viewer_not_ready');
    if (!capabilities) reasons.push('manager_unavailable');
    else {
      if (capabilities.enabled !== true) reasons.push('manager_not_configured');
      if (domain && capabilities.domain !== domain)
        reasons.push('preview_domain_mismatch');
    }
    const runtimes = new Set(
      (Array.isArray(capabilities?.runtimes) ? capabilities.runtimes : [])
        .map((value: unknown) =>
          value && typeof value === 'object'
            ? (value as { id?: unknown }).id
            : undefined,
        )
        .filter(
          (id): id is string =>
            typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id),
        ),
    );
    const recipe = this.stored(projectId);
    let profile: PreviewProfile | null = null;
    if (!recipe) reasons.push('project_profile_missing');
    else {
      try {
        profile = this.decrypt(recipe.encryptedProfile, projectId);
      } catch {
        reasons.push('project_profile_unreadable');
      }
    }
    if (profile) {
      if (!profile.enabled) reasons.push('project_disabled');
      if (!profile.agentManaged && !profile.start.trim())
        reasons.push('start_command_missing');
      if (
        profile.agentManaged &&
        capabilities &&
        !profile.agentRuntimes.some((id) => runtimes.has(id))
      )
        reasons.push('agent_runtimes_missing');
      if (
        !profile.agentManaged &&
        capabilities &&
        !runtimes.has(profile.runtime)
      )
        reasons.push('runtime_not_allowed');
      if (
        capabilities &&
        !profile.agentManaged &&
        profile.services.some((service) => !runtimes.has(service.runtime))
      )
        reasons.push('service_runtime_not_allowed');
    }
    const source =
      this.folders.resolveAgent(threadId) ?? scope.agent!.workspacePath;
    if (!source) reasons.push('working_directory_missing');
    else if (
      path
        .resolve(source)
        .split(path.sep)
        .some((p) => p.startsWith('.mergeron'))
    )
      reasons.push('working_directory_protected');
    else {
      try {
        const access = currentAccess()!;
        access.identities.requireWorkspacePath(source, false, access.identity);
      } catch {
        reasons.push('working_directory_access_denied');
      }
    }
    // Keep only the public instance summary. In particular, an arbitrary URL
    // or an authorization token must never be injected as an agent instruction.
    const row = this.row(scope.agentId);
    const prepared = this.agentRecipe(projectId, scope.agentId);
    let effective: ReturnType<
      ProjectPreviewsService['effectiveProfile']
    > | null = null;
    if (
      profile &&
      (!profile.agentManaged || prepared?.policyRevision === recipe?.revision)
    ) {
      try {
        effective = this.effectiveProfile(projectId, scope.agentId);
      } catch {
        reasons.push('agent_recipe_unreadable');
      }
    }
    const instanceCurrent =
      effective?.profile.enabled === true &&
      effective.revision === row?.profileRevision;
    let url: string | null = null;
    const previewUrl = status.preview?.url;
    if (
      domain &&
      row &&
      status.preview?.state === 'running' &&
      status.preview.ready &&
      instanceCurrent &&
      typeof previewUrl === 'string'
    ) {
      try {
        const candidate = new URL(previewUrl);
        if (
          candidate.protocol === 'https:' &&
          // Keep already running legacy hosts usable until their normal stop.
          [row.previewId, row.runId].some(
            (id) => candidate.hostname === `${id}.${domain}`,
          ) &&
          !candidate.username &&
          !candidate.password &&
          !candidate.port &&
          !candidate.search &&
          !candidate.hash
        )
          url = candidate.origin + candidate.pathname;
      } catch {
        /* No usable public URL; never manufacture an access grant. */
      }
    }
    const identity = currentAccess()!.identities.current(
      currentAccess()!.identity,
    );
    const safeError = status.preview?.error;
    const previewState =
      typeof status.preview?.state === 'string'
        ? status.preview.state
        : 'unknown';
    return {
      state: reasons.length
        ? capabilities
          ? 'not_configured'
          : 'unavailable'
        : 'available',
      checkedAt: new Date().toISOString(),
      available: reasons.length === 0,
      platformEnabled,
      projectConfigured: profile !== null,
      projectEnabled: profile?.enabled ?? false,
      runtime:
        effective?.profile.runtime ??
        (profile?.agentManaged ? null : profile?.runtime) ??
        null,
      updateMode:
        effective?.profile.updateMode ??
        (profile?.agentManaged ? null : profile?.updateMode) ??
        null,
      preparation: {
        projectAuthorized: profile?.enabled === true && profile.agentManaged,
        policyRevision: recipe?.revision ?? null,
        recipeRevision: prepared?.revision ?? null,
        required:
          profile?.agentManaged === true &&
          prepared?.policyRevision !== recipe?.revision,
        allowedRuntimes: profile?.agentManaged
          ? profile.agentRuntimes.filter((id) => runtimes.has(id))
          : [],
        limits: profile
          ? {
              memoryMb: profile.memoryMb,
              cpus: profile.cpus,
              lifetimeMinutes: profile.lifetimeMinutes,
              maxServices: 3,
              storage: storage.safeStorageLimits(capabilities?.storage),
            }
          : null,
      },
      missingConfiguration: reasons,
      management: {
        identityAllowed:
          identity.kind === 'person' &&
          !identity.impersonation &&
          identity.role === 'administrator',
        requiresExplicitHumanRequest: !(
          profile?.enabled === true && profile.agentManaged
        ),
        requiresWritableTurn: true,
      },
      preview: status.preview
        ? {
            state: [
              'preparing',
              'starting',
              'running',
              'stopped',
              'failed',
              'unknown',
            ].includes(previewState)
              ? previewState
              : 'unknown',
            url,
            ready: status.preview.ready === true && instanceCurrent,
            httpStatus: status.preview.httpStatus,
            storage: status.preview.storage,
            expiresAt:
              typeof status.preview.expiresAt === 'number' &&
              Number.isFinite(status.preview.expiresAt)
                ? status.preview.expiresAt
                : null,
            lifetimeMinutes: status.preview.lifetimeMinutes,
            lastSyncedAt:
              typeof status.preview.lastSyncedAt === 'number' &&
              Number.isFinite(status.preview.lastSyncedAt)
                ? status.preview.lastSyncedAt
                : null,
            requiresRestart: status.preview.requiresRestart === true,
            cleanup: status.preview.cleanup,
            error:
              safeError == null
                ? null
                : typeof safeError === 'string' &&
                    /^PREVIEW_[A-Z_]{1,80}$/.test(safeError)
                  ? safeError
                  : 'PREVIEW_STATUS_UNAVAILABLE',
          }
        : null,
    };
  }
  async start(
    projectId: string,
    threadId: string,
    requestId: unknown,
    refresh = false,
    assertActive: () => void = () => {},
    lifetimeMinutes?: unknown,
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
      const recipe = this.effectiveProfile(projectId, scope.agentId);
      const profile = { ...recipe.profile };
      if (lifetimeMinutes !== undefined) {
        try {
          profile.lifetimeMinutes = contract.lifetime(lifetimeMinutes);
        } catch {
          throw new BadRequestException('PREVIEW_INVALID_LIFETIME');
        }
      }
      if (!profile.enabled || !profile.start.trim())
        throw new ConflictException('PREVIEW_DISABLED');
      const check = () => {
        if (this.scope(projectId, threadId).agentId !== scope.agentId)
          throw new ForbiddenException('PREVIEW_IDENTITY_CHANGED');
        requireExecutionAccess();
        assertActive();
        if (
          this.effectiveProfile(projectId, scope.agentId).revision !==
          recipe.revision
        )
          throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
      };
      const capabilities = await this.manager.request('capabilities');
      check();
      if (
        !capabilities.enabled ||
        capabilities.domain !==
          this.config.get<string>('MERGERON_PREVIEW_DOMAIN')
      )
        throw new ConflictException('PREVIEW_NOT_CONFIGURED');
      const existing = this.row(scope.agentId);
      if (existing && existing.projectId !== projectId)
        throw new ForbiddenException('PREVIEW_IDENTITY_CHANGED');
      if (existing?.requestId === requestId) {
        if (existing.profileRevision !== recipe.revision)
          throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
        return this.status(projectId, threadId);
      }
      if (existing && !refresh) {
        const status = await this.manager.request('status', {
          runId: existing.runId,
        });
        check();
        if (['running', 'starting'].includes(String(status.state))) {
          if (existing.profileRevision !== recipe.revision)
            throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
          return this.status(projectId, threadId);
        }
        if (status.state !== 'stopped')
          throw new ConflictException('PREVIEW_RECREATE_REQUIRED');
      }
      if (existing && refresh)
        await this.manager.request('stop', { runId: existing.runId });
      check();
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
        const checkSource = () => {
          check();
          if (
            (this.folders.resolveAgent(threadId) ??
              this.scope(projectId, threadId).agent!.workspacePath) !== source
          )
            throw new ConflictException('PREVIEW_SOURCE_CHANGED');
          this.identities.requireWorkspacePath(source, false, identity);
        };
        const sourceFingerprint = await previewSourceFingerprint(
          source,
          checkSource,
        );
        const snapshot = await previewSnapshot(
          source,
          path.join(target, 'source.tar'),
          checkSource,
        );
        checkSource();
        if (
          sourceFingerprint !==
          (await previewSourceFingerprint(source, checkSource))
        )
          throw new ConflictException('PREVIEW_SOURCE_CHANGED');
        checkSource();
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
  async setLifetime(
    projectId: string,
    threadId: string,
    input: { lifetimeMinutes?: unknown; requestId?: unknown },
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
    let minutes: number | null;
    try {
      minutes = contract.lifetime(input.lifetimeMinutes);
    } catch {
      throw new BadRequestException('PREVIEW_INVALID_LIFETIME');
    }
    if (
      typeof input.requestId !== 'string' ||
      !contract.ID.test(input.requestId)
    )
      throw new BadRequestException('PREVIEW_REQUEST_ID_REQUIRED');
    if (this.locks.has(scope.agentId))
      throw new ConflictException('PREVIEW_BUSY');
    this.locks.add(scope.agentId);
    try {
      const row = this.row(scope.agentId);
      if (!row || row.state !== 'running')
        throw new ConflictException('PREVIEW_NOT_RUNNING');
      if (row.projectId !== projectId)
        throw new ForbiddenException('PREVIEW_IDENTITY_CHANGED');
      const effective = this.effectiveProfile(projectId, scope.agentId);
      if (
        !effective.profile.enabled ||
        effective.revision !== row.profileRevision
      )
        throw new ConflictException('PREVIEW_CONFIGURATION_CHANGED');
      await this.manager.request('lifetime', {
        runId: row.runId,
        lifetimeMinutes: minutes,
        requestId: input.requestId,
      });
      this.scope(projectId, threadId);
      requireExecutionAccess();
      assertActive();
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
      if (row.projectId !== projectId)
        throw new ForbiddenException('PREVIEW_IDENTITY_CHANGED');
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
    if (row.projectId !== projectId)
      throw new ForbiddenException('PREVIEW_IDENTITY_CHANGED');
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
    const allowed =
      input.tool === 'project_preview_prepare'
        ? ['tool', 'requestId', 'recipe', 'policyRevision', 'expectedRevision']
        : ['tool', 'operation', 'requestId', 'lifetimeMinutes'];
    if (Object.keys(input).some((k) => !allowed.includes(k)))
      throw new BadRequestException('PREVIEW_INVALID_REQUEST');
    if (input.tool === 'project_preview_prepare')
      return this.prepare(projectId, threadId, input, assertActive);
    if (input.operation === 'status')
      return this.discovery(projectId, threadId);
    if (input.operation === 'logs') return this.logs(projectId, threadId);
    if (input.operation === 'lifetime') {
      await this.setLifetime(projectId, threadId, input, assertActive);
      return this.discovery(projectId, threadId);
    }
    if (input.operation === 'sync') {
      await this.synchronize(projectId, threadId, true, assertActive);
      return this.discovery(projectId, threadId);
    }
    if (input.operation === 'start' || input.operation === 'refresh') {
      await this.start(
        projectId,
        threadId,
        input.requestId,
        input.operation === 'refresh',
        assertActive,
        input.lifetimeMinutes,
      );
      assertActive();
      return this.discovery(projectId, threadId);
    }
    if (input.operation === 'stop') {
      await this.stop(projectId, threadId);
      return this.discovery(projectId, threadId);
    }
    throw new BadRequestException('PREVIEW_INVALID_REQUEST');
  }
}
