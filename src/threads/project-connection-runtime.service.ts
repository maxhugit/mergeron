/** Replaces native MCP connections when project policy changes; resume alone is not a reload. */
import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { createHash } from 'node:crypto';
import { CodexService } from '../codex/codex.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import type { ServerNotification, v2 } from '../codex/codex-schema';
import { isUnmaterializedThread } from './thread-materialization';
import { assertPaginatedThread } from './thread-history-mode';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';
import {
  ProjectConnectionPolicyService,
  type ProjectExecutionPolicy,
} from './project-connection-policy.service';

interface FreshResumeState {
  generation: number;
  parameters: Pick<
    v2.ThreadResumeParams,
    | 'model'
    | 'modelProvider'
    | 'approvalPolicy'
    | 'approvalsReviewer'
    | 'serviceTier'
  >;
  effort: v2.Thread['reasoningEffort'];
  readOnly: boolean;
}

@Injectable()
export class ProjectConnectionRuntimeService {
  private readonly applied = new Map<
    string,
    { context: string; transport: string; projectId: string | null }
  >();
  private changing = false;
  private readonly freshRefreshes = new Map<string, Promise<void>>();
  private readonly closing = new Map<string, () => void>();
  private readonly placeholderNames = new Set<string>();
  private readonly freshSettings = new Map<string, FreshResumeState>();
  constructor(
    private readonly codex: CodexService,
    private readonly manager: CodexProcessManager,
    private readonly policies: ProjectConnectionPolicyService,
    private readonly admission: CatalogAdmissionService,
    @Optional() private readonly folders?: ActiveFoldersService,
    @Optional()
    private readonly settingsObserver?: ThreadSettingsObserverService,
  ) {
    manager.addListener('notification', (notification: ServerNotification) => {
      if (notification.method === 'thread/deleted')
        this.placeholderNames.delete(notification.params.threadId);
      if (notification.method === 'thread/closed')
        this.closing.get(notification.params.threadId)?.();
    });
    manager.addLifecycleListener((event) => {
      if (event.type === 'appServerReady') {
        this.applied.clear();
        this.freshSettings.clear();
      }
    });
  }

  private key(policy: ProjectExecutionPolicy | null, transportOnly = false) {
    const stable = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(stable)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, leaf]) => [key, stable(leaf)]),
            )
          : value;
    return createHash('sha256')
      .update(
        JSON.stringify(
          stable(
            policy && {
              projectId: policy.projectId,
              config: policy.config,
              ...(!transportOnly
                ? {
                    locationId: policy.locationId,
                    workspaceId: policy.workspaceId,
                    executionCwd: policy.executionCwd,
                    readOnly: policy.readOnly,
                    sourceResourceId: policy.sourceResourceId,
                    sourceRevision: policy.sourceRevision,
                  }
                : {}),
            },
          ),
        ),
      )
      .digest('hex');
  }

  assertOpen() {
    if (this.changing)
      throw new ConflictException(
        'Les restrictions des intégrations sont en cours de mise à jour.',
      );
  }

  generation() {
    return this.manager.getGeneration();
  }

  assertGeneration(generation: number | undefined) {
    this.assertOpen();
    if (generation !== this.generation())
      throw new ConflictException(
        'Les connexions ont changé pendant la préparation. Réessayez.',
      );
  }

  assertExecutionLocation(policy: ProjectExecutionPolicy | null) {
    this.policies.assertExecutionLocation(policy, policy?.executionCwd);
  }

  record(
    threadId: string,
    policy: ProjectExecutionPolicy | null,
    generation = this.generation(),
  ) {
    if (generation === this.generation()) {
      this.freshSettings.delete(threadId);
      this.applied.set(threadId, {
        projectId: policy?.projectId ?? null,
        context: this.key(policy),
        transport: this.key(policy, true),
      });
    }
  }

  async forResume(threadId: string) {
    this.assertOpen();
    const metadata = await this.codex.request<v2.ThreadReadResponse>(
      'thread/read',
      { threadId, includeTurns: false },
    );
    const cwd = this.folders?.resolveAgent(threadId) ?? metadata.thread.cwd;
    const policy = await this.policies.policyForThread(threadId, cwd);
    this.assertOpen();
    if (
      policy &&
      metadata.thread.status.type !== 'notLoaded' &&
      this.applied.get(threadId)?.context !== this.key(policy)
    ) {
      await this.beforeTurn(threadId, cwd);
      throw new ConflictException(
        'Les connexions MCP ont été renouvelées. Rouvrez la conversation.',
      );
    }
    return policy;
  }

  async beforeTurn(threadId: string, cwd: string | null) {
    this.assertOpen();
    const generation = this.generation();
    const policy = await this.policies.policyForThread(threadId, cwd);
    this.assertGeneration(generation);
    if (
      this.applied.get(threadId)?.context === this.key(policy) ||
      (!policy && !this.applied.has(threadId))
    )
      return { policy, restarted: false, generation };
    const unmaterialized = await isUnmaterializedThread(this.codex, threadId);
    if (unmaterialized) {
      if (this.applied.get(threadId)?.transport !== this.key(policy, true)) {
        await this.refreshFreshThread(threadId, policy, cwd, generation);
        return { policy, restarted: false, reopened: true, generation };
      }
      this.assertGeneration(generation);
      this.policies.assertExecutionLocation(policy, cwd);
      this.record(threadId, policy, generation);
      return { policy, restarted: false, generation };
    }
    // Naming an agent (including a previous interrupted refresh) may already
    // have persisted its still-empty history. Do not restart unrelated agents.
    if (this.applied.has(threadId)) {
      const page = await this.codex.request<v2.ThreadTurnsListResponse>(
        'thread/turns/list',
        { threadId, limit: 1 },
      );
      if (
        Array.isArray(page.data) &&
        page.data.length === 0 &&
        page.nextCursor == null
      ) {
        await this.refreshFreshThread(threadId, policy, cwd, generation);
        return { policy, restarted: false, reopened: true, generation };
      }
    }
    // A loaded Core session ignores MCP overrides on thread/resume. Never
    // continue that session with stale permissions, or silently interrupt work.
    this.changing = true;
    try {
      await this.manager.restartControlled(() => {
        this.changing = false;
      });
      return { policy, restarted: true, generation: this.generation() };
    } catch {
      throw new ConflictException(
        'Impossible de renouveler les connexions MCP : arrêtez les agents actifs puis réessayez. Aucun accès supplémentaire accordé.',
      );
    } finally {
      this.changing = false;
    }
  }

  /** Native closure clears observation caches; retain only settings needed for this same-generation reopen. */
  freshResumeState(threadId: string) {
    const state = this.freshSettings.get(threadId);
    return state?.generation === this.generation() ? state : undefined;
  }

  /** The fallback title only makes an empty native thread durable; its first real input still names it. */
  isPlaceholderName(threadId: string, name: string | null | undefined) {
    return this.placeholderNames.has(threadId) && name === threadId;
  }

  /** Apply a fresh cwd selection without discarding its unmaterialized native session. */
  async prepareFreshLocation(
    threadId: string,
    policy: ProjectExecutionPolicy | null,
    cwd: string,
  ) {
    this.assertOpen();
    if (this.applied.get(threadId)?.transport === this.key(policy, true))
      return false;
    await this.refreshFreshThread(threadId, policy, cwd, this.generation());
    return true;
  }

  private async refreshFreshThread(
    threadId: string,
    policy: ProjectExecutionPolicy | null,
    cwd: string | null,
    generation: number,
  ) {
    const pending = this.freshRefreshes.get(threadId);
    if (pending) return pending;
    const refresh = this.persistAndUnloadFreshThread(
      threadId,
      policy,
      cwd,
      generation,
    );
    this.freshRefreshes.set(threadId, refresh);
    try {
      await refresh;
    } finally {
      this.freshRefreshes.delete(threadId);
    }
  }

  private async persistAndUnloadFreshThread(
    threadId: string,
    policy: ProjectExecutionPolicy | null,
    cwd: string | null,
    generation: number,
  ) {
    // Only a locally opened, same-project conversation can use this recovery.
    // Unknown sessions retain the existing closed-by-default behavior.
    const applied = this.applied.get(threadId);
    if (!applied || applied.projectId !== (policy?.projectId ?? null))
      throw new ConflictException(
        'Le contexte initial de cet agent est inconnu. Rouvrez sa conversation.',
      );
    const { thread } = await this.codex.request<v2.ThreadReadResponse>(
      'thread/read',
      { threadId, includeTurns: false },
    );
    this.assertGeneration(generation);
    this.policies.assertExecutionLocation(policy, cwd);
    assertPaginatedThread(thread, 'thread/read');
    if (
      thread.id !== threadId ||
      thread.ephemeral ||
      thread.status.type !== 'idle'
    )
      throw new ConflictException(
        'Cet agent doit être inactif pour actualiser ses droits.',
      );
    const observed = this.settingsObserver?.readSettings(threadId)?.settings;
    this.freshSettings.set(threadId, {
      generation,
      parameters: {
        model: observed?.model ?? thread.model,
        modelProvider: observed?.modelProvider ?? thread.modelProvider,
        ...(observed?.approvalPolicy
          ? { approvalPolicy: observed.approvalPolicy }
          : {}),
        ...(observed?.approvalsReviewer
          ? { approvalsReviewer: observed.approvalsReviewer }
          : {}),
        ...(observed?.serviceTier !== undefined
          ? { serviceTier: observed.serviceTier }
          : {}),
      },
      effort: observed?.effort ?? thread.reasoningEffort,
      readOnly: observed?.sandboxPolicy?.type === 'readOnly',
    });
    // Core 0.164 does not persist a new paginated thread until its first input
    // OR a name write. Preserve the name, identity and empty history; never
    // manufacture a model turn or touch shared user configuration.
    if (!thread.name?.trim()) {
      await this.codex.request<v2.ThreadSetNameResponse>('thread/name/set', {
        threadId,
        name: threadId,
      });
      this.placeholderNames.add(threadId);
    }
    this.assertGeneration(generation);
    const page = await this.codex.request<v2.ThreadTurnsListResponse>(
      'thread/turns/list',
      { threadId, limit: 1 },
    );
    this.assertGeneration(generation);
    if (
      !Array.isArray(page.data) ||
      page.data.length ||
      page.nextCursor != null
    )
      throw new ConflictException(
        'La conversation a démarré pendant l’actualisation de ses droits. Réessayez.',
      );
    this.policies.assertExecutionLocation(policy, cwd);
    await this.unloadFreshThread(threadId);
    this.assertGeneration(generation);
    // thread/closed has also invalidated the resume/settings caches. The normal
    // writer-open path must now validate the exact new native permission profile.
    this.applied.delete(threadId);
  }

  private unloadFreshThread(threadId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let acknowledged = false;
      let closed = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.closing.delete(threadId);
        if (error)
          reject(
            error instanceof Error
              ? error
              : new Error('Native thread release failed'),
          );
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new ConflictException(
              'La fermeture de cet agent n’a pas été confirmée. Réessayez.',
            ),
          ),
        5000,
      );
      this.closing.set(threadId, () => {
        closed = true;
        if (acknowledged) finish();
      });
      void this.codex
        .request<v2.ThreadUnsubscribeResponse>('thread/unsubscribe', {
          threadId,
        })
        .then((response) => {
          if (response.status !== 'unsubscribed') {
            finish(
              new ConflictException(
                'La libération de cet agent n’a pas été confirmée.',
              ),
            );
            return;
          }
          acknowledged = true;
          if (closed) finish();
        }, finish);
    });
  }

  /** The HTTP interceptor delegates these two routes to this exclusive gate. */
  async change<T>(write: () => T): Promise<T> {
    const release = this.admission.begin();
    this.changing = true;
    let value!: T;
    let committed = false;
    try {
      await this.manager.restartControlled(() => {
        value = write();
        committed = true;
        this.changing = false;
        release();
      });
      if (!committed)
        throw new Error('Project integration update was not committed');
      return value;
    } catch (error) {
      if (committed) throw error;
      throw new ConflictException(
        'Arrêtez les agents actifs avant de modifier les intégrations du projet. La sélection précédente est conservée.',
      );
    } finally {
      this.changing = false;
      release();
    }
  }
}
