import { ConflictException, Injectable } from '@nestjs/common';
import * as path from 'node:path';
import type { ServerNotification } from '../codex/codex-schema';
import { ThreadExecutionInventoryService } from './thread-execution-inventory.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';

/** The operation was not dispatched: retrying the same request is safe. */
export class GitGateRefusal extends ConflictException {}

/** Server-only scope, resolved from the validated copy, never from MCP arguments. */
export interface AgentGitScope {
  copyPath: string;
  remoteRef?: string;
}
export interface AgentGitIsolation {
  writableCopyPath: string | null;
  readOnlyRoots: string[];
}
const contains = (root: string, value: string) =>
  value === root || value.startsWith(root + path.sep);
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);

/** Scoped agent writes require acknowledged native isolation; UI/unknown work stays exclusive. */
@Injectable()
export class GitMutationGateService {
  private writing = false;
  private readonly starting = new Map<symbol, string | undefined>();
  private readonly copies = new Set<string>();
  private readonly remoteRefs = new Set<string>();
  private readonly isolation = new Map<
    string,
    AgentGitIsolation & { generation: number }
  >();
  constructor(
    private readonly inventory: ThreadExecutionInventoryService,
    private readonly manager: CodexProcessManager,
  ) {
    // Proofs from a replaced native process cannot authorize concurrent work.
    manager.addLifecycleListener?.(() => this.isolation.clear());
    manager.addListener?.('notification', (note: ServerNotification) => {
      if (
        note.method === 'thread/closed' ||
        note.method === 'thread/deleted' ||
        note.method === 'thread/archived'
      )
        this.isolation.delete(note.params.threadId);
    });
  }
  private generation() {
    return this.manager.getGeneration?.() ?? 0;
  }

  /** Only called after the native profile acknowledgement and ownership checks. */
  recordIsolation(threadId: string, isolation: AgentGitIsolation): void {
    const roots = [
      ...isolation.readOnlyRoots,
      ...(isolation.writableCopyPath ? [isolation.writableCopyPath] : []),
    ];
    if (
      roots.some((root) => !path.isAbsolute(root) || path.resolve(root) === '/')
    )
      throw new GitGateRefusal('GIT_AGENT_STATE_UNKNOWN');
    this.isolation.set(threadId, {
      generation: this.generation(),
      writableCopyPath: isolation.writableCopyPath
        ? path.resolve(isolation.writableCopyPath)
        : null,
      readOnlyRoots: isolation.readOnlyRoots.map((root) => path.resolve(root)),
    });
  }
  clearIsolation(threadId: string): void {
    this.isolation.delete(threadId);
  }
  hasIsolation(threadId: string): boolean {
    return this.isolation.get(threadId)?.generation === this.generation();
  }
  private protectedFrom(
    threadId: string | undefined,
    copyPath: string,
  ): boolean {
    if (!threadId || !this.hasIsolation(threadId)) return false;
    const proof = this.isolation.get(threadId)!;
    return (
      !(proof.writableCopyPath && overlaps(proof.writableCopyPath, copyPath)) &&
      proof.readOnlyRoots.some((root) => contains(root, copyPath))
    );
  }

  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.manager.getClient())
      throw new GitGateRefusal('GIT_AGENT_STATE_UNKNOWN');
    if (
      this.writing ||
      this.copies.size ||
      this.starting.size ||
      this.inventory.snapshot().length
    )
      throw new GitGateRefusal('GIT_BUSY');
    this.writing = true;
    try {
      return await operation();
    } finally {
      this.writing = false;
    }
  }
  async publishFromAgent<T>(
    threadId: string,
    operation: () => Promise<T>,
    scope?: AgentGitScope,
  ): Promise<T> {
    return this.mutateFromAgent(threadId, operation, scope);
  }
  async mutateFromAgent<T>(
    threadId: string,
    operation: () => Promise<T>,
    scope?: AgentGitScope,
  ): Promise<T> {
    if (!this.manager.getClient())
      throw new GitGateRefusal('GIT_AGENT_STATE_UNKNOWN');
    const active = this.inventory.snapshot();
    if (!active.includes(threadId))
      throw new GitGateRefusal('GIT_AGENT_STATE_UNKNOWN');
    // Existing/unknown sessions retain the previous conservative barrier.
    if (!scope || !this.hasIsolation(threadId)) {
      if (
        this.writing ||
        this.copies.size ||
        this.starting.size ||
        active.some((id) => id !== threadId)
      )
        throw new GitGateRefusal('GIT_BUSY');
      this.writing = true;
      try {
        return await operation();
      } finally {
        this.writing = false;
      }
    }
    const copyPath = path.resolve(scope.copyPath);
    if (this.isolation.get(threadId)!.writableCopyPath !== copyPath)
      throw new GitGateRefusal('GIT_COPY_OWNED');
    if (
      this.writing ||
      [...this.copies].some((copy) => overlaps(copy, copyPath)) ||
      (scope.remoteRef !== undefined && this.remoteRefs.has(scope.remoteRef)) ||
      active.some(
        (id) => id !== threadId && !this.protectedFrom(id, copyPath),
      ) ||
      [...this.starting.values()].some(
        (id) => !this.protectedFrom(id, copyPath),
      )
    )
      throw new GitGateRefusal('GIT_BUSY');
    this.copies.add(copyPath);
    if (scope.remoteRef !== undefined) this.remoteRefs.add(scope.remoteRef);
    try {
      return await operation();
    } finally {
      this.copies.delete(copyPath);
      if (scope.remoteRef !== undefined)
        this.remoteRefs.delete(scope.remoteRef);
    }
  }
  async startTurn<T>(
    operation: () => Promise<T>,
    threadId?: string,
  ): Promise<T> {
    if (
      this.writing ||
      [...this.copies].some((copy) => !this.protectedFrom(threadId, copy))
    )
      throw new GitGateRefusal('GIT_BUSY');
    const key = Symbol();
    this.starting.set(key, threadId);
    try {
      return await operation();
    } finally {
      this.starting.delete(key);
    }
  }
}
