/** Replaces native MCP connections when project policy changes; resume alone is not a reload. */
import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { createHash } from 'node:crypto';
import { CodexService } from '../codex/codex.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import type { v2 } from '../codex/codex-schema';
import {
  ProjectConnectionPolicyService,
  type ProjectExecutionPolicy,
} from './project-connection-policy.service';

@Injectable()
export class ProjectConnectionRuntimeService {
  private readonly applied = new Map<string, string>();
  private changing = false;
  constructor(
    private readonly codex: CodexService,
    private readonly manager: CodexProcessManager,
    private readonly policies: ProjectConnectionPolicyService,
    private readonly admission: CatalogAdmissionService,
    @Optional() private readonly folders?: ActiveFoldersService,
  ) {
    manager.addLifecycleListener((event) => {
      if (event.type === 'appServerReady') this.applied.clear();
    });
  }

  private key(policy: ProjectExecutionPolicy | null) {
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
            policy && { projectId: policy.projectId, config: policy.config },
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

  record(
    threadId: string,
    policy: ProjectExecutionPolicy | null,
    generation = this.generation(),
  ) {
    if (generation === this.generation())
      this.applied.set(threadId, this.key(policy));
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
      this.applied.get(threadId) !== this.key(policy)
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
      this.applied.get(threadId) === this.key(policy) ||
      (!policy && !this.applied.has(threadId))
    )
      return { policy, restarted: false, generation };
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
