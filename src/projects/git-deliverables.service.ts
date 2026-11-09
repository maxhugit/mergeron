import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { lstat, readFile, rename } from 'node:fs/promises';
import {
  lstatSync,
  realpathSync,
  readFileSync,
  openSync,
  fstatSync,
  closeSync,
  constants,
} from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { projectResources, projectActivity } from '../database/schema';
import {
  currentAccess,
  accessContext,
  requireExecutionAccess,
  requireProjectAccess,
} from '../auth/access-context';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { DocumentOrganizationService } from '../deliverables/document-organization.service';
import {
  digest,
  portableDeliverableId,
  portableDocumentId,
  readableDeliverableFolder,
  discoverGitDeliverables,
  gitChild,
  gitDeliverablesIndex,
  readGitDeliverablesIndex,
  largeGitDocument,
  manifestSchema,
  readGitFile,
  relativeGitDirectory,
  writeGitFile,
  removeGitFile,
  type GitDeliverableManifest,
} from '../deliverables/git-deliverables-format';
import { WorkspaceGitService } from './workspace-git.service';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';

const optionsSchema = z
  .object({
    boardId: z.string().min(1).max(100),
    copyId: z.string().min(1).max(100).optional(),
    directory: z.string().transform(relativeGitDirectory),
    restrictedIds: z.array(z.string().max(100)).max(100).default([]),
    adoptFolders: z.boolean().default(false),
    renameFolders: z.boolean().optional(),
  })
  .strict();
type Options = z.infer<typeof optionsSchema>;
type Binding = {
  pendingImport?: boolean;
  pendingExport?: boolean;
  localId: string;
  folder: string;
  metadata: string;
  documents: Record<
    string,
    { localId: string; hash: string; removed?: boolean }
  >;
};
type GitContext = { branch: string | null; head: string | null };
type SyncState = {
  context?: GitContext;
  branches?: Record<string, Omit<SyncState, 'branches'>>;
  pending?: boolean;
  pendingBranch?: string;
  generation?: number;
  bindings: Record<string, Binding>;
  lastError: string | null;
  lastSyncAt: number | null;
};
type Settings = Options & {
  copies?: Record<string, SyncState>;
  context?: GitContext;
  enabled: boolean;
  bindings: Record<string, Binding>;
  lastError: string | null;
  lastSyncAt: number | null;
};
type Change = {
  deliverable: string;
  deliverableId?: string;
  document?: string;
  action: 'import' | 'export' | 'conflict' | 'excluded' | 'rename';
  reason: string;
};
type Local = {
  item: ReturnType<DeliverablesService['get']>;
  manifest: GitDeliverableManifest;
  documents: ReturnType<DeliverablesService['documents']>;
  organizationRevision: number;
  deletedDocuments: ReturnType<DeliverablesService['documents']>;
};
const metadataHash = (m: GitDeliverableManifest) => digest(JSON.stringify(m));
const errorCode = (e: unknown) =>
  e instanceof Error && /^(GIT_|DELIVERABLE_)/.test(e.message)
    ? e.message
    : 'GIT_DELIVERABLES_SYNC_FAILED';

/** Git is a portable projection of retained versions, never the version store. */
@Injectable()
export class GitDeliverablesService implements OnModuleInit, OnModuleDestroy {
  private readonly busy = new Map<string, symbol>();
  private readonly importing = new AsyncLocalStorage<{
    board: string;
    token: symbol;
    active: boolean;
  }>();
  private readonly planning = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  onModuleDestroy() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.git.onWorkingCopyChanged = undefined;
    this.copies.onCopyReady = undefined;
    this.deliverables.onGitChange = undefined;
    this.deliverables.beforeGitChange = undefined;
  }
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly deliverables: DeliverablesService,
    private readonly organization: DocumentOrganizationService,
    private readonly git: WorkspaceGitService,
    private readonly copies: WorkspaceCopiesService,
    private readonly gate: GitMutationGateService,
  ) {}
  onModuleInit() {
    this.git.onWorkingCopyChanged = (p) => this.scheduleProject(p);
    this.copies.onCopyReady = (p) => this.scheduleProject(p);
    this.deliverables.beforeGitChange = (p, r) => this.assertCanModify(p, r);
    this.deliverables.onGitChange = (p, r) => {
      try {
        if (this.isImporting(r)) return;
        this.markPending(p, r);
        this.enqueue(p, r);
      } catch {
        // Git is an optional projection. Scheduling it must never roll back
        // the domain save, including internal boards that cannot opt into Git.
        new Logger(GitDeliverablesService.name).warn(
          'Git deliverable export could not be scheduled',
        );
      }
    };
  }
  private scheduleProject(p: string) {
    try {
      requireProjectAccess(p);
      for (const board of this.db
        .select()
        .from(projectResources)
        .where(
          and(
            eq(projectResources.projectId, p),
            eq(projectResources.type, 'deliverable_board'),
          ),
        )
        .all()) {
        if (
          !board.config.internal &&
          (board.config.gitDeliverables as Settings | undefined)?.enabled
        )
          this.enqueue(p, board.id);
      }
    } catch {
      new Logger(GitDeliverablesService.name).warn(
        'Git deliverable reconciliation could not be scheduled',
      );
    }
  }
  reconcile(p: string) {
    requireExecutionAccess();
    requireProjectAccess(p);
    this.scheduleProject(p);
    return { scheduled: true };
  }
  private board(p: string, r: string) {
    requireProjectAccess(p);
    const row = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.id, r),
          eq(projectResources.projectId, p),
          eq(projectResources.type, 'deliverable_board'),
        ),
      )
      .get();
    if (!row || row.config.internal)
      throw new BadRequestException('GIT_DELIVERABLES_BOARD_UNAVAILABLE');
    const publicBoards = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.projectId, p),
          eq(projectResources.type, 'deliverable_board'),
        ),
      )
      .all()
      .filter((b) => !b.config.internal);
    if (publicBoards.length !== 1)
      throw new ConflictException('GIT_DELIVERABLES_BOARD_AMBIGUOUS');
    return row;
  }
  private settings(p: string, r: string): Settings | null {
    return (
      (this.board(p, r).config.gitDeliverables as Settings | undefined) ?? null
    );
  }
  private copyStates(s: Settings | null): Record<string, SyncState> {
    return {
      ...(s?.copyId
        ? {
            [s.copyId]: {
              bindings: s.bindings,
              lastError: s.lastError,
              lastSyncAt: s.lastSyncAt,
            },
          }
        : {}),
      ...s?.copies,
    };
  }
  private forCopy(
    p: string,
    r: string,
    copyId: string,
    context?: GitContext,
  ): Settings | null {
    const s = this.settings(p, r);
    if (!s) return null;
    const copy = this.copyStates(s)[copyId];
    context ??= copy?.context;
    const state =
      context &&
      copy?.context &&
      this.branchKey(copy.context) !== this.branchKey(context)
        ? copy.branches?.[this.branchKey(context)]
        : copy;
    return {
      ...s,
      copyId,
      context,
      bindings: state?.bindings ?? {},
      lastError: state?.lastError ?? null,
      lastSyncAt: state?.lastSyncAt ?? null,
    };
  }
  private branchKey(context: GitContext) {
    return context.branch ?? `detached:${context.head ?? 'unborn'}`;
  }
  private async gitContext(root: string): Promise<GitContext> {
    const branch =
      (
        await this.git.git(
          root,
          ['symbolic-ref', '--quiet', 'HEAD'],
          {},
          15000,
          [0, 1],
        )
      ).trim() || null;
    const head =
      (
        await this.git.git(
          root,
          ['rev-parse', '--verify', '--quiet', 'HEAD'],
          {},
          15000,
          [0, 1],
        )
      ).trim() || null;
    return { branch, head };
  }
  private async assertGitContext(root: string, context: GitContext) {
    if (JSON.stringify(await this.gitContext(root)) !== JSON.stringify(context))
      throw new ConflictException('GIT_DELIVERABLES_BRANCH_CHANGED');
  }
  private isImporting(r: string) {
    const scope = this.importing.getStore();
    return (
      scope?.active && scope.board === r && scope.token === this.busy.get(r)
    );
  }
  private async importMutation<T>(
    r: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const token = this.busy.get(r);
    if (!token) throw new ConflictException('GIT_DELIVERABLES_BUSY');
    const scope = { board: r, token, active: true };
    try {
      return await this.importing.run(scope, operation);
    } finally {
      scope.active = false;
    }
  }
  private markPending(p: string, r: string) {
    const settings = this.settings(p, r);
    if (!settings?.enabled) return;
    const actor = currentAccess()?.localAgentThreadId;
    const states = this.copyStates(settings);
    for (const copy of this.eligible(p, actor)) {
      const previous = states[copy.id];
      const headPath = join(copy.localPath!, '.git', 'HEAD');
      const descriptor = openSync(
        headPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let head: string;
      try {
        const entry = fstatSync(descriptor);
        if (!entry.isFile() || entry.size > 4096)
          throw new ConflictException('GIT_DELIVERABLES_BRANCH_CHANGED');
        head = readFileSync(descriptor, 'utf8').trim();
      } finally {
        closeSync(descriptor);
      }
      const branch = head.startsWith('ref: ')
        ? head.slice(5)
        : `detached:${head}`;
      states[copy.id] = {
        ...(previous ?? { bindings: {}, lastError: null, lastSyncAt: null }),
        pending: true,
        pendingBranch: previous?.pending
          ? (previous.pendingBranch ?? branch)
          : branch,
        generation: (previous?.generation ?? 0) + 1,
      };
    }
    const board = this.board(p, r);
    this.db
      .update(projectResources)
      .set({
        config: {
          ...board.config,
          gitDeliverables: { ...settings, copies: states },
        },
      })
      .where(eq(projectResources.id, r))
      .run();
  }
  private completePending(
    p: string,
    r: string,
    copyId: string,
    generation: number,
  ) {
    const settings = this.settings(p, r);
    if (!settings) return;
    const states = this.copyStates(settings),
      state = states[copyId];
    if (!state || (state.generation ?? 0) !== generation) return;
    states[copyId] = { ...state, pending: false };
    const board = this.board(p, r);
    this.db
      .update(projectResources)
      .set({
        config: {
          ...board.config,
          gitDeliverables: { ...settings, copies: states },
        },
      })
      .where(eq(projectResources.id, r))
      .run();
  }
  private cloneExists(localPath: string | null) {
    try {
      if (!localPath || realpathSync(localPath) !== localPath) return false;
      const root = lstatSync(localPath),
        git = lstatSync(join(localPath, '.git')),
        head = lstatSync(join(localPath, '.git', 'HEAD'));
      return (
        root.isDirectory() &&
        !root.isSymbolicLink() &&
        git.isDirectory() &&
        !git.isSymbolicLink() &&
        head.isFile() &&
        !head.isSymbolicLink() &&
        head.size <= 4096
      );
    } catch {
      return false;
    }
  }
  private eligible(p: string, actor?: string) {
    return this.copies
      .list(p)
      .filter(
        (c) =>
          c.sourceType === 'git' &&
          c.sourceEnabled &&
          c.state === 'ready' &&
          c.accessMode === 'read_write' &&
          c.ownerAgentIds.length === 1 &&
          (!actor || c.ownerThreadIds.includes(actor)) &&
          this.cloneExists(c.localPath),
      );
  }
  private target(p: string, copyId?: string) {
    const actor = currentAccess()?.localAgentThreadId;
    const copies = this.eligible(p, actor);
    const copy = copyId
      ? copies.find((c) => c.id === copyId)
      : copies.length === 1
        ? copies[0]
        : undefined;
    if (!copy)
      throw new ConflictException('GIT_DELIVERABLES_AGENT_COPY_REQUIRED');
    return copy;
  }
  /** Domain saves remain available without Git; an active transfer still owns its snapshot. */
  assertCanModify(_p: string, r: string) {
    if (this.busy.has(r) && !this.isImporting(r))
      throw new ConflictException('GIT_DELIVERABLES_BUSY');
  }
  private save(p: string, r: string, settings: Settings) {
    const board = this.board(p, r);
    const previous = board.config.gitDeliverables as Settings | undefined;
    const states = this.copyStates(previous ?? null);
    if (settings.copyId) {
      const previousCopy = states[settings.copyId];
      const state: SyncState = {
        bindings: settings.bindings,
        lastError: settings.lastError,
        lastSyncAt: settings.lastSyncAt,
        context: settings.context,
        pending: previousCopy?.pending,
        generation: previousCopy?.generation,
        pendingBranch: previousCopy?.pendingBranch,
      };
      const branches = { ...previousCopy?.branches };
      if (previousCopy?.context) {
        const previousBranch = { ...previousCopy };
        delete previousBranch.branches;
        branches[this.branchKey(previousCopy.context)] = previousBranch;
      }
      if (settings.context) branches[this.branchKey(settings.context)] = state;
      states[settings.copyId] = { ...state, branches };
    }
    this.db
      .update(projectResources)
      .set({
        config: {
          ...board.config,
          gitDeliverables: {
            ...settings,
            copyId: undefined,
            renameFolders: undefined,
            bindings: {},
            copies: states,
          },
        },
        updatedAt: Date.now(),
      })
      .where(eq(projectResources.id, r))
      .run();
  }
  configure(p: string, input: unknown) {
    requireExecutionAccess();
    const schema = optionsSchema
      .omit({ copyId: true, adoptFolders: true, renameFolders: true })
      .extend({ enabled: z.boolean() });
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException('GIT_DELIVERABLES_INVALID_SETTINGS');
    const options = parsed.data;
    this.board(p, options.boardId);
    if (this.busy.has(options.boardId) || this.planning.has(options.boardId))
      throw new ConflictException('GIT_DELIVERABLES_BUSY');
    const previous = this.settings(p, options.boardId);
    if (
      previous &&
      Object.values(this.copyStates(previous)).some(
        (s) => Object.keys(s.bindings).length,
      ) &&
      previous.directory !== options.directory
    )
      throw new ConflictException('GIT_DELIVERABLES_TARGET_ALREADY_BOUND');
    this.save(p, options.boardId, {
      ...options,
      adoptFolders: false,
      bindings: {},
      lastError: previous?.lastError ?? null,
      lastSyncAt: previous?.lastSyncAt ?? null,
    });
    if (options.enabled) {
      try {
        // Retained documents may predate activation. Reuse the guarded export
        // queue; saving this preference must not depend on Git availability.
        this.markPending(p, options.boardId);
        this.enqueue(p, options.boardId);
      } catch {
        new Logger(GitDeliverablesService.name).warn(
          'Initial Git deliverable export could not be scheduled',
        );
      }
    }
    return { enabled: options.enabled };
  }
  async status(p: string, copyId?: string) {
    requireProjectAccess(p);
    const visibleCopies = this.copies
      .list(p)
      .filter((copy) => copy.sourceType === 'git');
    const visibleIds = new Set(visibleCopies.map((copy) => copy.id));
    const boards = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.projectId, p),
          eq(projectResources.type, 'deliverable_board'),
        ),
      )
      .all()
      .filter((b) => !b.config.internal)
      .map((b) => {
        const s = b.config.gitDeliverables as Settings | undefined;
        return {
          id: b.id,
          name: b.name,
          restricted: this.deliverables
            .board(p, b.id)
            .deliverables.filter((d) => d.confidentiality === 'restricted')
            .map((d) => ({ id: d.id, title: d.title })),
          settings: s
            ? {
                enabled: s.enabled,
                mode: 'agent_copies',
                directory: s.directory,
                restrictedIds: s.restrictedIds,
                lastError:
                  Object.entries(this.copyStates(s)).find(
                    ([id, copy]) => visibleIds.has(id) && copy.lastError,
                  )?.[1].lastError ?? s.lastError,
                lastSyncAt: s.lastSyncAt,
              }
            : null,
        };
      });
    const eligibleIds = new Set(this.eligible(p).map((c) => c.id));
    const copies = await Promise.all(
      visibleCopies.map(async (c) => {
        const settings = boards[0] ? this.settings(p, boards[0].id) : null;
        const saved = this.copyStates(settings)[c.id];
        const root = await this.git.directory(p, c.id).catch(() => null);
        const context = root
          ? await this.gitContext(root).catch(() => null)
          : null;
        const branchState =
          settings && context
            ? this.forCopy(p, settings.boardId, c.id, context)
            : null;
        return {
          context,
          lastError: branchState
            ? branchState.lastError
            : (saved?.lastError ?? null),
          lastSyncAt: branchState?.lastSyncAt ?? null,
          pending: saved?.pending ?? false,
          pendingBranch: saved?.pendingBranch ?? null,
          id: c.id,
          sourceResourceId: c.sourceResourceId,
          ownerThreadIds: c.ownerThreadIds,
          localPath: c.localPath,
          name: c.name,
          writable: c.accessMode === 'read_write',
          owned: c.ownerThreadIds.length > 0,
          eligible: eligibleIds.has(c.id),
          directory: await this.git
            .directory(p, c.id)
            .then((root) => readGitDeliverablesIndex(root))
            .then((index) => index?.directory ?? 'livrables')
            .catch(() => 'livrables'),
        };
      }),
    );
    let discovered: { id: string; title: string; documents: number }[] = [];
    let discoveryError: string | null = null;
    if (copyId) {
      try {
        const root = await this.git.directory(p, copyId);
        const declared = await readGitDeliverablesIndex(root);
        const directory =
          boards[0]?.settings?.directory ?? declared?.directory ?? 'livrables';
        discovered = (await discoverGitDeliverables(root, directory)).map(
          (d) => ({
            id: d.manifest.id,
            title: d.manifest.title,
            documents: d.manifest.documents.length,
          }),
        );
      } catch (e) {
        discoveryError = errorCode(e);
      }
    }
    let proposal: Awaited<
      ReturnType<GitDeliverablesService['preview']>
    > | null = null;
    const board = boards[0];
    if (copyId && board?.settings?.enabled && eligibleIds.has(copyId)) {
      try {
        proposal = await this.comparison(p, {
          boardId: board.id,
          copyId,
          directory: board.settings.directory,
          restrictedIds: board.settings.restrictedIds,
        });
      } catch (e) {
        discoveryError = errorCode(e);
      }
    }
    return {
      boards,
      copies,
      discovered,
      discoveryError,
      proposal,
      active: Boolean(
        board && (this.busy.has(board.id) || this.planning.has(board.id)),
      ),
      verifiedAt: proposal ? Date.now() : null,
    };
  }
  disable(p: string, r: string) {
    requireExecutionAccess();
    if (this.busy.has(r)) throw new ConflictException('GIT_DELIVERABLES_BUSY');
    const settings = this.settings(p, r);
    if (settings) this.save(p, r, { ...settings, enabled: false });
    return { enabled: false };
  }
  private options(input: unknown) {
    const result = optionsSchema.safeParse(input);
    if (!result.success)
      throw new BadRequestException('GIT_DELIVERABLES_INVALID_SETTINGS');
    return result.data;
  }
  private local(
    p: string,
    r: string,
    settings: Pick<Settings, 'bindings'> | null,
    presentIds = new Set<string>(),
  ) {
    const rows = this.deliverables.board(p, r).deliverables;
    if (rows.length > 100)
      throw new BadRequestException('GIT_DELIVERABLES_LIMIT');
    const result = new Map<string, Local>();
    for (const row of rows) {
      const candidates = Object.entries(settings?.bindings ?? {}).filter(
        ([, binding]) => binding.localId === row.id,
      );
      const present = candidates.filter(([id]) => presentIds.has(id));
      if (present.length > 1)
        throw new ConflictException('GIT_DELIVERABLES_DUPLICATE_ID');
      const remoteId =
        present[0]?.[0] ??
        candidates[0]?.[0] ??
        portableDeliverableId(p, r, row.id);
      const allDocuments = this.deliverables.documents(p, r, row.id);
      const documents = allDocuments.filter((d) => d.deletedAt === null);
      const labels = this.organization.read(p, r, row.id);
      const labelNames = (ids: string[]) =>
        ids
          .map((id) => labels.labels.find((l) => l.id === id)?.name)
          .filter((n): n is string => Boolean(n))
          .sort();
      const manifest = manifestSchema.parse({
        format: 'mergeron-deliverable',
        version: 1,
        id: remoteId,
        title: row.title,
        description: row.description,
        labels: labels.labels.map((l) => l.name).sort(),
        documents: documents
          .map((d) => ({
            id:
              Object.entries(
                settings?.bindings[remoteId]?.documents ?? {},
              ).find(([, v]) => v.localId === d.id)?.[0] ??
              (remoteId === portableDeliverableId(p, r, row.id)
                ? portableDocumentId(remoteId, d.id)
                : d.id),
            path: d.name,
            labels: labelNames(labels.assignments[d.id] ?? []),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
      result.set(remoteId, {
        item: this.deliverables.get(p, r, row.id),
        manifest,
        documents,
        deletedDocuments: allDocuments.filter((d) => d.deletedAt !== null),
        organizationRevision: labels.revision,
      });
    }
    return result;
  }
  private localDocumentId(local: Local | undefined, portableId: string) {
    const name = local?.manifest.documents.find(
      (entry) => entry.id === portableId,
    )?.path;
    return name
      ? local?.documents.find((document) => document.name === name)?.id
      : undefined;
  }
  private async build(p: string, options: Options) {
    if (this.planning.size >= 2 || this.planning.has(options.boardId))
      throw new ConflictException('GIT_DELIVERABLES_BUSY');
    this.planning.add(options.boardId);
    try {
      return await this.buildUnlocked(p, options);
    } finally {
      this.planning.delete(options.boardId);
    }
  }
  private async buildUnlocked(p: string, options: Options) {
    this.board(p, options.boardId);
    const copy = this.target(p, options.copyId);
    options = { ...options, copyId: copy.id };
    const others = this.db
      .select()
      .from(projectResources)
      .where(eq(projectResources.projectId, p))
      .all();
    if (
      others.some((r) => {
        const s = r.config.gitDeliverables as Settings | undefined;
        return (
          r.id !== options.boardId &&
          s?.enabled &&
          s.copyId === options.copyId &&
          (s.directory === options.directory ||
            s.directory.startsWith(options.directory + '/') ||
            options.directory.startsWith(s.directory + '/'))
        );
      })
    )
      throw new ConflictException('GIT_DELIVERABLES_TARGET_IN_USE');
    const root = await this.git.directory(p, copy.id);
    const context = await this.gitContext(root);
    const index = await readGitDeliverablesIndex(root);
    if (index && index.directory !== options.directory)
      throw new ConflictException('GIT_DELIVERABLES_TARGET_ALREADY_BOUND');
    const projectSettings = this.settings(p, options.boardId);
    if (
      projectSettings &&
      projectSettings.directory !== options.directory &&
      Object.values(this.copyStates(projectSettings)).some(
        (s) => Object.keys(s.bindings).length,
      )
    )
      throw new ConflictException('GIT_DELIVERABLES_TARGET_ALREADY_BOUND');
    const previous = this.forCopy(p, options.boardId, copy.id, context);
    if (
      previous &&
      Object.keys(previous.bindings).length &&
      (previous.copyId !== options.copyId ||
        previous.directory !== options.directory)
    )
      throw new ConflictException('GIT_DELIVERABLES_TARGET_ALREADY_BOUND');
    const identitySettings = this.settings(p, options.boardId);
    const identities: Record<string, Binding> = {};
    for (const state of Object.values(this.copyStates(identitySettings))) {
      Object.assign(identities, state.bindings);
      for (const branch of Object.values(state.branches ?? {}))
        Object.assign(identities, branch.bindings);
    }
    const remote = await discoverGitDeliverables(
      root,
      options.directory,
      options.adoptFolders,
    );
    for (const entry of remote) {
      if (!identities[entry.manifest.id])
        identities[entry.manifest.id] = {
          localId: entry.manifest.id,
          folder: entry.folder,
          metadata: '',
          documents: {},
        };
    }
    const local = this.local(
      p,
      options.boardId,
      { bindings: identities },
      new Set(remote.map((entry) => entry.manifest.id)),
    );
    const folders = new Map<string, string>();
    const occupied = new Set(
      remote.map((entry) => entry.folder.normalize('NFKC').toLocaleLowerCase()),
    );
    for (const [id, value] of [...local.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const known =
        remote.find((entry) => entry.manifest.id === id)?.folder ??
        previous?.bindings[id]?.folder ??
        identities[id]?.folder;
      let folder =
        (options.renameFolders ? undefined : known) ??
        `${options.directory}/${readableDeliverableFolder(value.manifest.title)}`;
      if (
        (!known || options.renameFolders) &&
        folder !== known &&
        occupied.has(folder.normalize('NFKC').toLocaleLowerCase())
      )
        folder += `-${digest(id).slice(0, 8)}`;
      if (
        (!known || options.renameFolders) &&
        folder !== known &&
        occupied.has(folder.normalize('NFKC').toLocaleLowerCase())
      )
        throw new ConflictException('GIT_DELIVERABLES_FOLDER_COLLISION');
      occupied.add(folder.normalize('NFKC').toLocaleLowerCase());
      folders.set(id, folder);
    }
    const folderMoves: {
      id: string;
      from: string;
      to: string;
      hash: string;
    }[] = [];
    const changes: Change[] = [];
    for (const [id, value] of local) {
      const from = remote.find((entry) => entry.manifest.id === id);
      const to = folders.get(id)!;
      if (
        !from?.hash ||
        from.folder === to ||
        (value.item.confidentiality === 'restricted' &&
          !options.restrictedIds.includes(value.item.id))
      )
        continue;
      const existing = await lstat(await gitChild(root, to)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      changes.push({
        deliverable: value.manifest.title,
        deliverableId: value.item.id,
        action: existing ? 'conflict' : 'rename',
        reason: existing ? 'folder_collision' : 'readable_folder',
        document: `${from.folder} → ${to}`,
      });
      folderMoves.push({ id, from: from.folder, to, hash: from.hash });
    }

    const documentActions = new Map<string, 'import' | 'export' | 'delete'>();
    const evidence: unknown[] = [
      [...folders],
      folderMoves,
      options,
      previous
        ? {
            enabled: previous.enabled,
            directory: previous.directory,
            restrictedIds: previous.restrictedIds,
            bindings: previous.bindings,
          }
        : null,
      index,
      context,
    ];
    const files = new Map<
      string,
      { bytes: Buffer | null; hash: string | null }
    >();
    let total = 0;
    const read = async (relative: string) => {
      const stat = await lstat(await gitChild(root, relative)).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        },
      );
      if (stat && stat.size > largeGitDocument) {
        const hash = `large:${stat.size}:${stat.mtimeMs}`;
        files.set(relative, { bytes: null, hash });
        evidence.push([relative, hash]);
        return { bytes: null, hash };
      }
      const bytes = await readGitFile(root, relative);
      total += bytes?.length ?? 0;
      if (total > 64 * 1024 * 1024)
        throw new BadRequestException('GIT_DELIVERABLES_LIMIT');
      const hash = bytes ? digest(bytes) : null;
      files.set(relative, { bytes, hash });
      evidence.push([relative, hash]);
      return { bytes, hash };
    };
    const remotes = new Map(remote.map((r) => [r.manifest.id, r]));
    const ids = new Set([
      ...local.keys(),
      ...remotes.keys(),
      ...Object.keys(previous?.bindings ?? {}),
    ]);
    for (const id of [...ids].sort()) {
      const l = local.get(id),
        r = remotes.get(id),
        base = previous?.bindings[id];
      const title = l?.manifest.title ?? r?.manifest.title ?? id;
      evidence.push([
        id,
        l?.manifest,
        l?.item.version,
        l?.item.lifecycleStatus,
        l?.item.confidentiality,
        l?.organizationRevision,
        l?.documents.map((d) => [d.id, d.currentVersionNumber]),
        l?.deletedDocuments.map((d) => [
          d.id,
          d.currentVersionNumber,
          d.deletedAt,
        ]),
        r?.hash,
      ]);
      const add = (
        action: Change['action'],
        reason: string,
        document?: string,
      ) =>
        changes.push({
          deliverable: title,
          deliverableId: l?.item.id,
          document,
          action,
          reason,
        });
      if (
        l?.item.confidentiality === 'restricted' &&
        !options.restrictedIds.includes(l.item.id)
      ) {
        add('excluded', 'restricted');
        continue;
      }
      if (base && (!l || !r) && !(base.pendingExport && l && !r)) {
        add('conflict', !r ? 'removed_in_git' : 'removed_in_mergeron');
        continue;
      }
      if (l && !r) {
        add('export', 'new_deliverable');
        for (const doc of l.documents) {
          const latest = doc.versions.find(
            (v) => v.number === doc.currentVersionNumber,
          );
          if (!latest || latest.size > largeGitDocument)
            add('conflict', 'large_file_requires_lfs', doc.name);
          const existing = await read(`${folders.get(id)!}/${doc.name}`);
          if (existing.hash && existing.hash !== latest?.sha256)
            add('conflict', 'untracked_file_collision', doc.name);
        }
        continue;
      }
      if (!r) continue;
      r.manifest.documents.sort((a, b) => a.id.localeCompare(b.id));
      r.manifest.labels.sort();
      r.manifest.documents.forEach((d) => d.labels.sort());
      const lh = l && metadataHash(l.manifest),
        rh = metadataHash(r.manifest);
      if (!l) add('import', 'new_deliverable');
      else if (lh !== rh && !base?.pendingImport) {
        if (base && lh === base.metadata) add('import', 'metadata');
        else if (base && rh === base.metadata) add('export', 'metadata');
        else add('conflict', 'metadata_changed_both');
      }
      const remoteDocs = new Map(r.manifest.documents.map((d) => [d.id, d]));
      const localDocs = new Map(
        (l?.manifest.documents ?? []).map((d) => [d.id, d]),
      );
      for (const docId of new Set([
        ...remoteDocs.keys(),
        ...localDocs.keys(),
        ...Object.keys(base?.documents ?? {}),
      ])) {
        const rd = remoteDocs.get(docId),
          ld = localDocs.get(docId),
          bd = base?.documents[docId];
        const d = l?.documents.find(
          (d) =>
            d.id ===
            (bd?.localId ??
              identities[id]?.documents[docId]?.localId ??
              this.localDocumentId(l, docId) ??
              docId),
        );
        const latest = d?.versions.find(
          (v) => v.number === d.currentVersionNumber,
        );
        const remoteFile = rd ? await read(`${r.folder}/${rd.path}`) : null;
        const label = rd?.path ?? ld?.path ?? docId;
        const retainedBinding = bd ?? identities[id]?.documents[docId];
        const deleted = l?.deletedDocuments.find(
          (doc) =>
            doc.id === (retainedBinding?.localId ?? docId) ||
            (!retainedBinding && !d && doc.name === rd?.path),
        );
        if (deleted) {
          if (
            rd &&
            retainedBinding &&
            (remoteFile?.hash === null ||
              remoteFile?.hash === retainedBinding.hash)
          ) {
            add('export', 'deleted_document', label);
            documentActions.set(JSON.stringify([id, docId]), 'delete');
          } else if (!rd && retainedBinding) {
            // Both sides already removed the document; remember its identity without resurrection.
            if (!bd?.removed) add('export', 'deleted_document', label);
            documentActions.set(JSON.stringify([id, docId]), 'delete');
          } else add('conflict', 'deleted_document_changed_in_git', label);
          continue;
        }
        if (bd && (!rd || !d) && !(bd.removed && d && !rd)) {
          add(
            'conflict',
            !rd ? 'removed_in_git' : 'removed_in_mergeron',
            label,
          );
          continue;
        }
        if (remoteFile?.hash?.startsWith('large:')) {
          add('conflict', 'large_file_requires_lfs', label);
          continue;
        }
        if (rd && !remoteFile?.bytes) {
          add('conflict', 'missing_file', label);
          continue;
        }
        if (
          (remoteFile?.bytes?.length ?? 0) > largeGitDocument ||
          (latest?.size ?? 0) > largeGitDocument
        ) {
          add('conflict', 'large_file_requires_lfs', label);
          continue;
        }
        if (
          remoteFile?.bytes
            ?.subarray(0, 100)
            .toString()
            .startsWith('version https://git-lfs.github.com/spec/v1')
        ) {
          add('conflict', 'lfs_content_missing', label);
          continue;
        }
        const localHash = latest?.sha256;
        if (remoteFile?.hash === localHash && localHash) continue;
        const knownOlder = d?.versions.some(
          (v) =>
            v.number < d.currentVersionNumber && v.sha256 === remoteFile?.hash,
        );
        let action: 'import' | 'export' | 'conflict';
        let reason: string;
        if (!d && rd) {
          action = 'import';
          reason = 'new_document';
        } else if (!rd && d) {
          action = 'export';
          reason = 'new_document';
        } else if (bd && remoteFile?.hash === bd.hash) {
          action = 'export';
          reason = 'document';
        } else if (knownOlder) {
          action = 'export';
          reason = 'known_older_document';
        } else if (bd && localHash === bd.hash) {
          action = 'import';
          reason = 'document';
        } else {
          action = 'conflict';
          reason = 'document_changed_both';
        }
        add(action, reason, label);
        if (action !== 'conflict')
          documentActions.set(JSON.stringify([id, docId]), action);
      }
      if (
        l &&
        ['finalized', 'archived'].includes(l.item.lifecycleStatus) &&
        changes.some(
          (c) => c.deliverableId === l.item.id && c.action === 'import',
        )
      )
        add('conflict', 'read_only_deliverable');
    }
    const targets = [...local.entries()]
      .filter(
        ([, l]) =>
          l.item.confidentiality !== 'restricted' ||
          options.restrictedIds.includes(l.item.id),
      )
      .flatMap(([id, l]) => {
        const folder = folders.get(id)!;
        return [
          `${folder}/livrable.json`,
          ...l.manifest.documents.map((d) => `${folder}/${d.path}`),
        ];
      });
    targets.push(gitDeliverablesIndex);
    if (targets.length) {
      const ignored = await this.git.git(
        root,
        ['check-ignore', '--no-index', '-z', '--stdin'],
        {},
        15000,
        [0, 1],
        Buffer.from(targets.join('\0') + '\0'),
      );
      evidence.push(['ignored', ignored]);
      if (ignored)
        changes.push({
          deliverable: options.directory,
          action: 'conflict',
          reason: 'ignored_by_git',
        });
    }
    await this.assertGitContext(root, context);
    for (const entry of local.values())
      this.assertLocal(p, options.boardId, entry);
    return {
      context,
      generation:
        this.copyStates(this.settings(p, options.boardId))[copy.id]
          ?.generation ?? 0,
      options,
      previous,
      local,
      remotes,
      root,
      index,
      changes,
      files,
      identities,
      folders,
      folderMoves,
      documentActions,
      fingerprint: digest(JSON.stringify([evidence, changes])),
    };
  }
  private assertLocal(p: string, r: string, expected: Local) {
    const current = this.deliverables.get(p, r, expected.item.id);
    const docs = this.deliverables
      .documents(p, r, current.id)
      .filter((d) => d.deletedAt === null);
    const organization = this.organization.read(p, r, current.id);
    if (
      current.version !== expected.item.version ||
      current.lifecycleStatus !== expected.item.lifecycleStatus ||
      current.confidentiality !== expected.item.confidentiality ||
      organization.revision !== expected.organizationRevision ||
      JSON.stringify(
        docs.map((d) => [d.id, d.currentVersionNumber, d.name]),
      ) !==
        JSON.stringify(
          expected.documents.map((d) => [d.id, d.currentVersionNumber, d.name]),
        )
    )
      throw new ConflictException('GIT_DELIVERABLES_CHANGED');
  }
  async preview(p: string, input: unknown) {
    requireExecutionAccess();
    return this.comparison(p, input);
  }
  private async comparison(p: string, input: unknown) {
    const plan = await this.build(p, this.options(input));
    return {
      fingerprint: plan.fingerprint,
      changes: plan.changes,
      locations: [...plan.local.entries()].map(([id, value]) => ({
        deliverableId: value.item.id,
        portableId: id,
        title: value.manifest.title,
        folder: plan.folders.get(id)!,
      })),
      copyId: plan.options.copyId,
      context: plan.context,
      canApply: !plan.changes.some((c) => c.action === 'conflict'),
    };
  }
  async apply(p: string, body: { options?: unknown; fingerprint?: unknown }) {
    requireExecutionAccess();
    const options = this.options(body?.options);
    if (this.busy.has(options.boardId))
      throw new ConflictException('GIT_DELIVERABLES_BUSY');
    this.busy.set(options.boardId, Symbol());
    try {
      const copy = this.target(p, options.copyId);
      options.copyId = copy.id;
      const actor = currentAccess()?.localAgentThreadId;
      const run = async () => {
        const plan = await this.build(p, options);
        if (plan.root !== root)
          throw new ConflictException('GIT_DELIVERABLES_CHANGED');
        if (
          typeof body.fingerprint !== 'string' ||
          plan.fingerprint !== body.fingerprint
        )
          throw new ConflictException('GIT_DELIVERABLES_CHANGED');
        if (plan.changes.some((c) => c.action === 'conflict'))
          throw new ConflictException('GIT_DELIVERABLES_CONFLICTS');
        const settings: Settings = {
          ...options,
          enabled: true,
          context: plan.context,
          bindings: structuredClone(plan.previous?.bindings ?? {}),
          lastError: null,
          lastSyncAt: plan.previous?.lastSyncAt ?? null,
        };
        this.save(p, options.boardId, settings);
        const recoveries: { document: string; path: string }[] = [];
        try {
          for (const move of plan.folderMoves) {
            await this.assertGitContext(plan.root, plan.context);
            const from = await gitChild(plan.root, move.from);
            const to = await gitChild(plan.root, move.to);
            const info = await lstat(from);
            if (!info.isDirectory() || info.isSymbolicLink())
              throw new ConflictException('GIT_DELIVERABLES_CHANGED');
            const occupied = await lstat(to).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return null;
                throw error;
              },
            );
            const bytes = await readGitFile(
              plan.root,
              `${move.from}/livrable.json`,
              256 * 1024,
            );
            if (occupied || !bytes || digest(bytes) !== move.hash)
              throw new ConflictException('GIT_DELIVERABLES_CHANGED');
            await rename(from, to);
            // An interrupted migration is discoverable by the same portable ID.
            // Never copy/delete its children or overwrite a new directory after a branch switch.
            await this.assertGitContext(plan.root, plan.context);
            const remote = plan.remotes.get(move.id)!;
            remote.folder = move.to;
            for (const [path, value] of [...plan.files])
              if (path.startsWith(move.from + '/')) {
                plan.files.delete(path);
                plan.files.set(move.to + path.slice(move.from.length), value);
              }
          }
          for (const id of new Set([
            ...plan.local.keys(),
            ...plan.remotes.keys(),
          ])) {
            let l = plan.local.get(id);
            if (l) this.assertLocal(p, options.boardId, l);
            await this.assertGitContext(plan.root, plan.context);
            const r = plan.remotes.get(id);
            if (
              l?.item.confidentiality === 'restricted' &&
              !options.restrictedIds.includes(l.item.id)
            )
              continue;
            const remotePreferred =
              r &&
              (!l ||
                settings.bindings[id]?.pendingImport ||
                (metadataHash(l.manifest) !== metadataHash(r.manifest) &&
                  settings.bindings[id]?.metadata ===
                    metadataHash(l.manifest)));
            if (!l && r) {
              const item = await this.importMutation(options.boardId, () =>
                this.deliverables.create(p, options.boardId, {
                  title: r.manifest.title,
                  description: r.manifest.description,
                }),
              );
              l = {
                item,
                manifest: r.manifest,
                documents: [],
                deletedDocuments: [],
                organizationRevision: this.organization.read(
                  p,
                  options.boardId,
                  item.id,
                ).revision,
              };
              settings.bindings[id] = {
                pendingImport: true,
                localId: item.id,
                folder: r.folder,
                metadata: '',
                documents: {},
              };
              this.save(p, options.boardId, settings);
            }
            if (!l) continue;
            const manifest = structuredClone(
              remotePreferred ? r.manifest : l.manifest,
            );
            const folder = r?.folder ?? plan.folders.get(id)!;
            const binding = settings.bindings[id] ?? {
              localId: l.item.id,
              folder,
              metadata: '',
              documents: {},
            };
            if (!r) {
              binding.pendingExport = true;
              settings.bindings[id] = binding;
              this.save(p, options.boardId, settings);
            }
            if (
              remotePreferred &&
              (l.item.title !== manifest.title ||
                l.item.description !== manifest.description)
            ) {
              const item = l.item;
              l.item = await this.importMutation(options.boardId, () =>
                this.deliverables.update(p, options.boardId, item.id, {
                  title: manifest.title,
                  description: manifest.description,
                  version: item.version,
                }),
              );
            }
            const deletedIds = new Set(
              [...plan.documentActions.entries()]
                .filter(
                  ([key, action]) =>
                    (JSON.parse(key) as [string, string])[0] === id &&
                    action === 'delete',
                )
                .map(([key]) => (JSON.parse(key) as [string, string])[1]),
            );
            for (const docId of deletedIds) {
              const remoteEntry = r?.manifest.documents.find(
                (d) => d.id === docId,
              );
              if (!remoteEntry) continue;
              this.assertLocal(p, options.boardId, l);
              const path = `${folder}/${remoteEntry.path}`;
              const expected = plan.files.get(path)?.hash;
              if (expected) {
                const recovery = await removeGitFile(
                  plan.root,
                  path,
                  expected,
                  () => this.assertGitContext(plan.root, plan.context),
                );
                if (recovery)
                  recoveries.push({ document: path, path: recovery });
              } else if (await readGitFile(plan.root, path))
                throw new ConflictException('GIT_DELIVERABLES_CHANGED');
            }
            manifest.documents = manifest.documents.filter(
              (d) => !deletedIds.has(d.id),
            );
            // Merge document additions independently from metadata direction.
            for (const d of r?.manifest.documents ?? [])
              if (
                !deletedIds.has(d.id) &&
                !manifest.documents.some((m) => m.id === d.id)
              )
                manifest.documents.push(d);
            for (const d of l.manifest.documents)
              if (!manifest.documents.some((m) => m.id === d.id))
                manifest.documents.push(d);
            for (const entry of manifest.documents) {
              let doc = this.deliverables
                .documents(p, options.boardId, l.item.id)
                .find(
                  (d) =>
                    d.id ===
                    (binding.documents[entry.id]?.localId ??
                      plan.identities[id]?.documents[entry.id]?.localId ??
                      this.localDocumentId(l, entry.id) ??
                      entry.id),
                );
              const remoteEntry = r?.manifest.documents.find(
                (d) => d.id === entry.id,
              );
              const remoteFile = remoteEntry
                ? plan.files.get(`${folder}/${remoteEntry.path}`)
                : undefined;
              const plannedDocument = plan.local
                .get(id)
                ?.documents.find(
                  (d) =>
                    d.id ===
                    (binding.documents[entry.id]?.localId ??
                      plan.identities[id]?.documents[entry.id]?.localId ??
                      this.localDocumentId(l, entry.id) ??
                      entry.id),
                );
              if (
                plannedDocument &&
                (!doc ||
                  doc.currentVersionNumber !==
                    plannedDocument.currentVersionNumber ||
                  doc.name !== plannedDocument.name)
              )
                throw new ConflictException('GIT_DELIVERABLES_CHANGED');
              const importing =
                remoteFile?.bytes &&
                plan.documentActions.get(JSON.stringify([id, entry.id])) ===
                  'import';
              if (doc && doc.name !== entry.path) {
                await this.importMutation(options.boardId, () =>
                  this.deliverables.renameDocument(
                    p,
                    options.boardId,
                    l.item.id,
                    doc!.id,
                    {
                      name: entry.path,
                      expectedName: doc!.name,
                      expectedVersion: doc!.currentVersionNumber,
                    },
                  ),
                );
                const localId = doc.id;
                doc = this.deliverables
                  .documents(p, options.boardId, l.item.id)
                  .find((d) => d.id === localId)!;
              }
              if (importing) {
                const bytes = remoteFile.bytes!;
                async function* uploads() {
                  await Promise.resolve();
                  yield { filename: entry.path, stream: Readable.from(bytes) };
                }
                await this.importMutation(options.boardId, () =>
                  this.deliverables.uploadDocuments(
                    p,
                    options.boardId,
                    l.item.id,
                    uploads(),
                    {
                      documentId: doc?.id,
                      expectedVersion: doc?.currentVersionNumber,
                      comment: 'Git import',
                    },
                  ),
                );
                doc = this.deliverables
                  .documents(p, options.boardId, l.item.id)
                  .find((d) => d.deletedAt === null && d.name === entry.path)!;
              }
              if (!doc) throw new ConflictException('GIT_DELIVERABLES_CHANGED');
              const version = doc.versions.find(
                (v) => v.number === doc.currentVersionNumber,
              )!;
              const bytes = await readFile(version.snapshotPath);
              if (digest(bytes) !== version.sha256)
                throw new ConflictException('GIT_DELIVERABLES_CHANGED');
              await this.assertGitContext(plan.root, plan.context);
              const target = `${folder}/${entry.path}`;
              const original = await readGitFile(plan.root, target);
              const expected = remoteEntry
                ? remoteFile?.hash
                : (plan.files.get(target)?.hash ?? null);
              if ((original ? digest(original) : null) !== expected)
                throw new ConflictException('GIT_DELIVERABLES_CHANGED');
              if (!original || digest(original) !== version.sha256)
                await writeGitFile(
                  plan.root,
                  target,
                  bytes,
                  original ? digest(original) : null,
                );
              binding.documents[entry.id] = {
                localId: doc.id,
                hash: version.sha256,
              };
              settings.bindings[id] = binding;
              if (r) this.save(p, options.boardId, settings);
            }
            if (remotePreferred)
              await this.importMutation(options.boardId, () =>
                this.organization.importGitOrganization(
                  p,
                  options.boardId,
                  l.item.id,
                  manifest.labels,
                  Object.fromEntries(
                    manifest.documents.map((d) => [
                      binding.documents[d.id].localId,
                      d.labels,
                    ]),
                  ),
                  l.organizationRevision,
                ),
              );
            await this.assertGitContext(plan.root, plan.context);
            const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
            await writeGitFile(
              plan.root,
              `${folder}/livrable.json`,
              raw,
              r?.hash ?? null,
            );
            for (const docId of deletedIds) {
              const previousDocument =
                binding.documents[docId] ??
                plan.identities[id]?.documents[docId];
              if (previousDocument)
                binding.documents[docId] = {
                  ...previousDocument,
                  removed: true,
                };
            }
            binding.folder = folder;
            binding.metadata = metadataHash(manifest);
            binding.pendingImport = false;
            binding.pendingExport = false;
            settings.bindings[id] = binding;
            this.save(p, options.boardId, settings);
          }
          await this.assertGitContext(plan.root, plan.context);
          await writeGitFile(
            plan.root,
            gitDeliverablesIndex,
            Buffer.from(
              JSON.stringify(
                {
                  format: 'mergeron-deliverables-index',
                  version: 1,
                  directory: options.directory,
                },
                null,
                2,
              ) + '\n',
            ),
            plan.index?.hash ?? null,
          );
          await this.assertGitContext(plan.root, plan.context);
          settings.lastSyncAt = Date.now();
          this.save(p, options.boardId, settings);
          this.completePending(p, options.boardId, copy.id, plan.generation);
          const actor = currentAccess()?.identity;
          this.db
            .insert(projectActivity)
            .values({
              id: randomUUID(),
              projectId: p,
              entityType: 'deliverable_history',
              entityId: options.boardId,
              action: 'git_deliverables_synced',
              label: options.directory,
              details: {
                copyId: options.copyId,
                changes: plan.changes,
                recoveries,
              },
              actorPersonId: actor?.personId ?? null,
              actorName: actor?.name ?? 'Mergeron',
              createdAt: Date.now(),
            })
            .run();
          return {
            enabled: true,
            changes: plan.changes,
            lastSyncAt: settings.lastSyncAt,
          };
        } catch (e) {
          settings.lastError = errorCode(e);
          this.save(p, options.boardId, settings);
          throw e;
        }
      };
      const root = await this.git.directory(p, copy.id);
      return await (actor
        ? this.gate.mutateDeferredFromAgent(actor, run, { copyPath: root })
        : this.gate.mutate(run));
    } finally {
      this.busy.delete(options.boardId);
    }
  }
  private enqueue(p: string, r: string, delay = 500) {
    const key = JSON.stringify([
      r,
      currentAccess()?.localAgentThreadId ?? null,
    ]);
    if (this.stopped || this.queued.has(key)) return;
    const settings = this.settings(p, r);
    if (!settings?.enabled) return;
    const access = currentAccess();
    this.queued.add(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.queued.delete(key);
      const run = async () => {
        try {
          const current = this.settings(p, r);
          if (!current?.enabled) return;
          const actor = currentAccess()?.localAgentThreadId;
          const copies = actor ? [this.target(p)] : this.eligible(p);
          if (!copies.length)
            throw new ConflictException('GIT_DELIVERABLES_AGENT_COPY_REQUIRED');
          let retry = false;
          for (const copy of copies) {
            const options = {
              boardId: r,
              copyId: copy.id,
              directory: current.directory,
              restrictedIds: current.restrictedIds,
            };
            try {
              const generation =
                this.copyStates(this.settings(p, r))[copy.id]?.generation ?? 0;
              const preview = await this.preview(p, options);
              // Never import in the background, commit, pull or push automatically.
              if (
                !preview.canApply ||
                preview.changes.some((c) => c.action === 'import')
              )
                throw new ConflictException('GIT_DELIVERABLES_REVIEW_REQUIRED');
              if (preview.changes.some((c) => c.action === 'export')) {
                await this.apply(p, {
                  options,
                  fingerprint: preview.fingerprint,
                });
              } else {
                const state = this.forCopy(p, r, copy.id, preview.context);
                if (state) this.save(p, r, { ...state, lastError: null });
                this.completePending(p, r, copy.id, generation);
              }
            } catch (e) {
              const context = await this.git
                .directory(p, copy.id)
                .then((root) => this.gitContext(root))
                .catch(() => undefined);
              const state = this.forCopy(p, r, copy.id, context);
              if (state) this.save(p, r, { ...state, lastError: errorCode(e) });
              if (
                [
                  'GIT_BUSY',
                  'GIT_AGENT_STATE_UNKNOWN',
                  'GIT_DELIVERABLES_BUSY',
                  'GIT_DELIVERABLES_CHANGED',
                ].includes(errorCode(e))
              )
                retry = true;
              new Logger(GitDeliverablesService.name).warn(
                'Git deliverable copy requires review',
              );
            }
          }
          if (retry) this.enqueue(p, r, 5000);
        } catch (e) {
          let current: Settings | null = null;
          try {
            current = this.settings(p, r);
            if (current)
              this.save(p, r, { ...current, lastError: errorCode(e) });
          } catch {
            // A deleted board or revoked actor must not crash a background job
            // or cause it to borrow another identity to persist diagnostics.
          }
          if (
            current &&
            [
              'GIT_BUSY',
              'GIT_AGENT_STATE_UNKNOWN',
              'GIT_DELIVERABLES_BUSY',
            ].includes(errorCode(e))
          ) {
            this.enqueue(p, r, 5000);
            return;
          }
          new Logger(GitDeliverablesService.name).warn(
            'Automatic Git deliverable synchronization requires review',
          );
        }
      };
      void (access ? accessContext.run(access, run) : run()).catch(() => {
        new Logger(GitDeliverablesService.name).warn(
          'Git deliverable background job could not finish',
        );
      });
    }, delay);
    timer.unref();
    this.timers.set(key, timer);
  }
}
