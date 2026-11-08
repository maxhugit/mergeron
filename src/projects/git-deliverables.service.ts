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
import { lstat, readFile } from 'node:fs/promises';
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
  discoverGitDeliverables,
  gitChild,
  largeGitDocument,
  manifestSchema,
  readGitFile,
  relativeGitDirectory,
  writeGitFile,
  type GitDeliverableManifest,
} from '../deliverables/git-deliverables-format';
import { WorkspaceGitService } from './workspace-git.service';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';

const optionsSchema = z
  .object({
    boardId: z.string().min(1).max(100),
    copyId: z.string().min(1).max(100),
    directory: z.string().transform(relativeGitDirectory),
    restrictedIds: z.array(z.string().max(100)).max(100).default([]),
    adoptFolders: z.boolean().default(false),
  })
  .strict();
type Options = z.infer<typeof optionsSchema>;
type Binding = {
  pendingImport?: boolean;
  localId: string;
  folder: string;
  metadata: string;
  documents: Record<string, { localId: string; hash: string }>;
};
type Settings = Options & {
  enabled: boolean;
  bindings: Record<string, Binding>;
  lastError: string | null;
  lastSyncAt: number | null;
};
type Change = {
  deliverable: string;
  document?: string;
  action: 'import' | 'export' | 'conflict' | 'excluded';
  reason: string;
};
type Local = {
  item: ReturnType<DeliverablesService['get']>;
  manifest: GitDeliverableManifest;
  documents: ReturnType<DeliverablesService['documents']>;
};
const metadataHash = (m: GitDeliverableManifest) => digest(JSON.stringify(m));
const errorCode = (e: unknown) =>
  e instanceof Error && /^(GIT_|DELIVERABLE_)/.test(e.message)
    ? e.message
    : 'GIT_DELIVERABLES_SYNC_FAILED';

/** Git is a portable projection of retained versions, never the version store. */
@Injectable()
export class GitDeliverablesService implements OnModuleInit, OnModuleDestroy {
  private readonly busy = new Set<string>();
  private readonly planning = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  onModuleDestroy() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.deliverables.onGitChange = undefined;
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
    this.deliverables.onGitChange = (p, r) => this.enqueue(p, r);
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
    return row;
  }
  private settings(p: string, r: string): Settings | null {
    return (
      (this.board(p, r).config.gitDeliverables as Settings | undefined) ?? null
    );
  }
  private save(p: string, r: string, settings: Settings) {
    const board = this.board(p, r);
    this.db
      .update(projectResources)
      .set({
        config: { ...board.config, gitDeliverables: settings },
        updatedAt: Date.now(),
      })
      .where(eq(projectResources.id, r))
      .run();
  }
  async status(p: string, copyId?: string) {
    requireProjectAccess(p);
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
                copyId: s.copyId,
                directory: s.directory,
                restrictedIds: s.restrictedIds,
                lastError: s.lastError,
                lastSyncAt: s.lastSyncAt,
              }
            : null,
        };
      });
    const copies = this.copies
      .list(p)
      .filter(
        (c) => c.sourceType === 'git' && c.state === 'ready' && c.sourceEnabled,
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        writable: c.accessMode === 'read_write',
        owned: c.ownerThreadIds.length > 0,
      }));
    let discovered: { id: string; title: string; documents: number }[] = [];
    let discoveryError: string | null = null;
    if (copyId) {
      try {
        const directory =
          boards.find((b) => b.settings?.copyId === copyId)?.settings
            ?.directory ?? 'livrables';
        const root = await this.git.directory(p, copyId);
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
    return { boards, copies, discovered, discoveryError };
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
  private local(p: string, r: string, settings: Settings | null) {
    const rows = this.deliverables.board(p, r).deliverables;
    if (rows.length > 100)
      throw new BadRequestException('GIT_DELIVERABLES_LIMIT');
    const result = new Map<string, Local>();
    for (const row of rows) {
      const remoteId =
        Object.entries(settings?.bindings ?? {}).find(
          ([, b]) => b.localId === row.id,
        )?.[0] ?? row.id;
      const documents = this.deliverables
        .documents(p, r, row.id)
        .filter((d) => d.deletedAt === null);
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
              ).find(([, v]) => v.localId === d.id)?.[0] ?? d.id,
            path: d.name,
            labels: labelNames(labels.assignments[d.id] ?? []),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
      result.set(remoteId, {
        item: this.deliverables.get(p, r, row.id),
        manifest,
        documents,
      });
    }
    return result;
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
    const copy = this.copies.list(p).find((c) => c.id === options.copyId);
    if (!copy || copy.accessMode !== 'read_write' || copy.ownerThreadIds.length)
      throw new ConflictException(
        'GIT_DELIVERABLES_SHARED_WRITABLE_COPY_REQUIRED',
      );
    const root = await this.git.directory(p, options.copyId);
    const previous = this.settings(p, options.boardId);
    if (
      previous &&
      Object.keys(previous.bindings).length &&
      (previous.copyId !== options.copyId ||
        previous.directory !== options.directory)
    )
      throw new ConflictException('GIT_DELIVERABLES_TARGET_ALREADY_BOUND');
    const local = this.local(p, options.boardId, previous);
    const remote = await discoverGitDeliverables(
      root,
      options.directory,
      options.adoptFolders,
    );
    const changes: Change[] = [];
    const evidence: unknown[] = [options, previous];
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
        l?.documents.map((d) => [d.id, d.currentVersionNumber]),
        r?.hash,
      ]);
      const add = (
        action: Change['action'],
        reason: string,
        document?: string,
      ) => changes.push({ deliverable: title, document, action, reason });
      if (
        l?.item.confidentiality === 'restricted' &&
        !options.restrictedIds.includes(l.item.id)
      ) {
        add('excluded', 'restricted');
        continue;
      }
      if (base && (!l || !r)) {
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
          const existing = await read(`${options.directory}/${id}/${doc.name}`);
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
        const d = l?.documents.find((d) => d.id === (bd?.localId ?? docId));
        const latest = d?.versions.find(
          (v) => v.number === d.currentVersionNumber,
        );
        const remoteFile = rd ? await read(`${r.folder}/${rd.path}`) : null;
        const label = rd?.path ?? ld?.path ?? docId;
        if (bd && (!rd || !d)) {
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
        if (!d && rd) add('import', 'new_document', label);
        else if (!rd && d) add('export', 'new_document', label);
        else if (bd && remoteFile?.hash === bd.hash)
          add('export', 'document', label);
        else if (bd && localHash === bd.hash) add('import', 'document', label);
        else add('conflict', 'document_changed_both', label);
      }
      if (
        l &&
        ['finalized', 'archived'].includes(l.item.lifecycleStatus) &&
        changes.some((c) => c.deliverable === title && c.action === 'import')
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
        const folder = remotes.get(id)?.folder ?? `${options.directory}/${id}`;
        return [
          `${folder}/livrable.json`,
          ...l.manifest.documents.map((d) => `${folder}/${d.path}`),
        ];
      });
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
    return {
      options,
      previous,
      local,
      remotes,
      root,
      changes,
      files,
      fingerprint: digest(JSON.stringify(evidence)),
    };
  }
  async preview(p: string, input: unknown) {
    requireExecutionAccess();
    const plan = await this.build(p, this.options(input));
    return {
      fingerprint: plan.fingerprint,
      changes: plan.changes,
      canApply: !plan.changes.some((c) => c.action === 'conflict'),
    };
  }
  async apply(p: string, body: { options?: unknown; fingerprint?: unknown }) {
    requireExecutionAccess();
    const options = this.options(body?.options);
    if (this.busy.has(options.boardId))
      throw new ConflictException('GIT_DELIVERABLES_BUSY');
    this.busy.add(options.boardId);
    try {
      return await this.gate.mutate(async () => {
        const plan = await this.build(p, options);
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
          bindings: structuredClone(plan.previous?.bindings ?? {}),
          lastError: null,
          lastSyncAt: plan.previous?.lastSyncAt ?? null,
        };
        this.save(p, options.boardId, settings);
        try {
          for (const id of new Set([
            ...plan.local.keys(),
            ...plan.remotes.keys(),
          ])) {
            let l = plan.local.get(id);
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
              const item = await this.deliverables.create(p, options.boardId, {
                title: r.manifest.title,
                description: r.manifest.description,
              });
              l = { item, manifest: r.manifest, documents: [] };
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
            const folder = r?.folder ?? `${options.directory}/${id}`;
            const binding = settings.bindings[id] ?? {
              localId: l.item.id,
              folder,
              metadata: '',
              documents: {},
            };
            if (
              remotePreferred &&
              (l.item.title !== manifest.title ||
                l.item.description !== manifest.description)
            )
              l.item = this.deliverables.update(p, options.boardId, l.item.id, {
                title: manifest.title,
                description: manifest.description,
                version: l.item.version,
              });
            // Merge document additions independently from metadata direction.
            for (const d of r?.manifest.documents ?? [])
              if (!manifest.documents.some((m) => m.id === d.id))
                manifest.documents.push(d);
            for (const d of l.manifest.documents)
              if (!manifest.documents.some((m) => m.id === d.id))
                manifest.documents.push(d);
            for (const entry of manifest.documents) {
              let doc = this.deliverables
                .documents(p, options.boardId, l.item.id)
                .find(
                  (d) =>
                    d.id === (binding.documents[entry.id]?.localId ?? entry.id),
                );
              const remoteEntry = r?.manifest.documents.find(
                (d) => d.id === entry.id,
              );
              const remoteFile = remoteEntry
                ? plan.files.get(`${folder}/${remoteEntry.path}`)
                : undefined;
              const latest = doc
                ? doc.versions.find(
                    (v) => v.number === doc?.currentVersionNumber,
                  )
                : undefined;
              const importing =
                remoteFile?.bytes &&
                (!doc ||
                  (latest?.sha256 !== remoteFile.hash &&
                    binding.documents[entry.id]?.hash === latest?.sha256));
              if (doc && doc.name !== entry.path) {
                await this.deliverables.renameDocument(
                  p,
                  options.boardId,
                  l.item.id,
                  doc.id,
                  {
                    name: entry.path,
                    expectedName: doc.name,
                    expectedVersion: doc.currentVersionNumber,
                  },
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
                await this.deliverables.uploadDocuments(
                  p,
                  options.boardId,
                  l.item.id,
                  uploads(),
                  {
                    documentId: doc?.id,
                    expectedVersion: doc?.currentVersionNumber,
                    comment: 'Git import',
                  },
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
              );
            const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
            await writeGitFile(
              plan.root,
              `${folder}/livrable.json`,
              raw,
              r?.hash ?? null,
            );
            binding.metadata = metadataHash(manifest);
            binding.pendingImport = false;
            settings.bindings[id] = binding;
            this.save(p, options.boardId, settings);
          }
          settings.lastSyncAt = Date.now();
          this.save(p, options.boardId, settings);
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
              details: { copyId: options.copyId, changes: plan.changes },
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
      });
    } finally {
      this.busy.delete(options.boardId);
    }
  }
  private enqueue(p: string, r: string, delay = 500) {
    if (this.stopped || this.busy.has(r) || this.queued.has(r)) return;
    const settings = this.settings(p, r);
    if (!settings?.enabled) return;
    const access = currentAccess();
    this.queued.add(r);
    const timer = setTimeout(() => {
      this.timers.delete(r);
      this.queued.delete(r);
      const run = async () => {
        try {
          const current = this.settings(p, r);
          if (!current?.enabled) return;
          const options = {
            boardId: r,
            copyId: current.copyId,
            directory: current.directory,
            restrictedIds: current.restrictedIds,
          };
          const preview = await this.preview(p, options);
          // Background synchronization exports retained versions only. Incoming
          // Git changes remain a proposal, never a surprise import.
          if (
            !preview.canApply ||
            preview.changes.some((c) => c.action === 'import')
          )
            throw new ConflictException('GIT_DELIVERABLES_REVIEW_REQUIRED');
          if (preview.changes.some((c) => c.action === 'export'))
            await this.apply(p, { options, fingerprint: preview.fingerprint });
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
            ['GIT_BUSY', 'GIT_AGENT_STATE_UNKNOWN'].includes(errorCode(e))
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
    this.timers.set(r, timer);
  }
}
