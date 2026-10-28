import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { constants, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  projectAgentThreads,
  projectResources,
  projects,
} from '../database/schema';
import { accessContext, currentAccess } from '../auth/access-context';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';
import { DocumentProtectionService } from './document-protection.service';

export interface PublicationRequest {
  requestId: string;
  resourceId: string;
  deliverableId: string;
  file: string;
  documentId?: string;
  expectedVersion?: number;
  comment: string;
}

/** A request is data, never a command, credential, or caller-selected project. */
export function publicationRequest(value: unknown): PublicationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid publication request');
  const input = value as Record<string, unknown>;
  const allowed = [
    'requestId',
    'resourceId',
    'deliverableId',
    'file',
    'documentId',
    'expectedVersion',
    'comment',
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error('Unknown publication field');
  for (const key of [
    'requestId',
    'resourceId',
    'deliverableId',
    'file',
    'comment',
  ])
    if (typeof input[key] !== 'string')
      throw new Error('Invalid publication field');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId as string))
    throw new Error('Invalid request id');
  const file = input.file as string;
  if (
    !file ||
    file.includes('\0') ||
    path.isAbsolute(file) ||
    file.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Publication requires a relative draft file');
  if (
    input.documentId !== undefined &&
    (typeof input.documentId !== 'string' || !input.documentId)
  )
    throw new Error('Invalid document id');
  if (
    input.documentId !== undefined &&
    (!Number.isSafeInteger(input.expectedVersion) ||
      Number(input.expectedVersion) < 1)
  )
    throw new Error('Updating a document requires its current version');
  if ((input.comment as string).length > 4000)
    throw new Error('Publication comment is too long');
  return input as unknown as PublicationRequest;
}

interface PublicationScope {
  projectId: string;
  root: string;
  directory: string;
  directoryInode: number;
  threadId: string;
  agentName: string;
  access: ReturnType<typeof currentAccess>;
  seen: Set<string>;
  timer: ReturnType<typeof setInterval>;
  expiresAt: number;
  processing?: Promise<void>;
  turnId?: string;
  completedTurnId?: string;
  completedSuccessfully?: boolean;
  finishing?: Promise<void>;
  revoked?: boolean;
}

/** Explicit file-based publication works for existing as well as new agents.
 * No backend credential is supplied to the agent, and no public API is added.
 */
@Injectable()
export class DocumentPublicationService implements OnModuleDestroy {
  private readonly scopes = new Map<string, PublicationScope>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly deliverables: DeliverablesService,
    private readonly protection: DocumentProtectionService,
    manager: CodexProcessManager,
  ) {
    manager.addListener('notification', (note: ServerNotification) => {
      if (
        note.method === 'thread/closed' ||
        note.method === 'thread/deleted' ||
        note.method === 'thread/archived'
      ) {
        this.revoke(note.params.threadId);
        return;
      }
      if (note.method !== 'turn/completed' && note.method !== 'turn/started')
        return;
      const scope = this.scopes.get(note.params.threadId);
      if (!scope) return;
      if (note.method === 'turn/started') {
        scope.turnId = note.params.turn.id;
        scope.completedTurnId = undefined;
        scope.completedSuccessfully = undefined;
        return;
      }
      scope.completedTurnId = note.params.turn.id;
      scope.completedSuccessfully = note.params.turn.status === 'completed';
      // Keep the bounded lease through Core's automatic continuation. A stop
      // or failed turn revokes it; the next explicit user turn rotates it.
      if (
        scope.turnId === scope.completedTurnId &&
        !scope.completedSuccessfully
      )
        void this.finish(scope);
    });
    manager.addLifecycleListener(() => this.stopAll());
  }

  onModuleDestroy(): void {
    this.stopAll();
  }

  revoke(threadId: string): void {
    const scope = this.scopes.get(threadId);
    if (scope) void this.finish(scope);
  }

  private stopAll(): void {
    for (const scope of this.scopes.values()) {
      scope.revoked = true;
      clearInterval(scope.timer);
    }
    this.scopes.clear();
  }

  async prepare(threadId: string, agentName?: string | null) {
    const binding = this.db
      .select()
      .from(projectAgentThreads)
      .where(eq(projectAgentThreads.threadId, threadId))
      .get();
    if (!binding) return null;
    const boards = this.db
      .select()
      .from(projectResources)
      .where(
        and(
          eq(projectResources.projectId, binding.projectId),
          eq(projectResources.type, 'deliverable_board'),
        ),
      )
      .all();
    const rule =
      'The user-facing action is « Enregistrer une nouvelle version ». Retained documents must be saved as versions through the deliverables manager. This is not a lifecycle status, public sharing, or validation. Code and temporary files are exempt. Files outside this process are drafts, not retained documents. Never edit retained files directly, including with full access.';
    if (!boards.length)
      return {
        context: `<document_publication>\n${rule}\nThis project has no deliverables manager: do not retain documents. Ask the user to add one before publication.\n</document_publication>`,
        bind: () => {},
        abort: () => {},
      };
    if (!this.protection.enabled)
      return {
        context: `<document_publication>\n${rule}\nProtected publication is unavailable in this runtime. Do not claim that documents have been published.\n</document_publication>`,
        bind: () => {},
        abort: () => {},
      };
    let scope = this.scopes.get(threadId);
    // Never reuse an execution lease across browser identities/security modes.
    if (
      scope &&
      (scope.access?.identity.personId !== currentAccess()?.identity.personId ||
        scope.access?.identity.impersonation?.sessionId !==
          currentAccess()?.identity.impersonation?.sessionId)
    ) {
      await this.finish(scope);
      scope = undefined;
    }
    if (scope?.completedTurnId) {
      await this.finish(scope);
      scope = undefined;
    }
    if (!scope) {
      const project = this.db
        .select()
        .from(projects)
        .where(eq(projects.id, binding.projectId))
        .get();
      if (!project || project.workspaceLayoutVersion < 1)
        throw new Error('A primary project workspace is required');
      const root = await fs.realpath(project.workspacePath);
      const directory = await this.protection.directory(path.dirname(root), [
        '.mergeron-agent-drafts',
        path.basename(root),
        createHash('sha256').update(threadId).digest('hex'),
        randomUUID(),
      ]);
      const created: PublicationScope = {
        projectId: binding.projectId,
        root,
        directory,
        directoryInode: (await fs.stat(directory)).ino,
        threadId,
        agentName: `Agent — ${agentName || threadId}`,
        access: currentAccess(),
        seen: new Set(),
        expiresAt: Date.now() + 60 * 60 * 1000,
        timer: setInterval(() => {
          if (Date.now() > created.expiresAt) {
            void this.finish(created);
            return;
          }
          void this.scan(created);
        }, 1000),
      };
      created.timer.unref();
      scope = created;
      this.scopes.set(threadId, scope);
    }
    const catalog = boards.flatMap((board) =>
      this.deliverables
        .board(binding.projectId, board.id)
        .deliverables.map((item) => ({
          resourceId: board.id,
          deliverableId: item.id,
          title: item.title,
          documents: (item.documents ?? []).map((document) => ({
            documentId: document.id,
            name: document.name,
            expectedVersion: document.currentVersionNumber,
          })),
        })),
    );
    const active = scope;
    const context = [
      '<document_publication>',
      rule,
      `Write retained document drafts only in ${JSON.stringify(scope.directory)}. Finish the draft before requesting its version.`,
      'To save a new version, atomically write valid JSON in publication-request.json in that directory: {"requestId":"unique-id","resourceId":"from-catalog","deliverableId":"from-catalog","file":"relative-file-name","comment":"Version comment"}.',
      'For an existing document, also provide documentId and expectedVersion from the catalog; retain its file name. If no target exists, ask the user to select one or explicitly request its creation using the project tools.',
      'Mergeron writes publication-result.json. Wait for a matching requestId and status="published" before claiming the version was saved. Process requests sequentially; a refusal preserves the draft. Never overwrite retained files or retry with a stale version.',
      'This execution lease accepts at most 20 requests for one hour, including automatic continuation. If no matching acknowledgement arrives within 60 seconds, report that saving is unconfirmed; do not claim success. A stop revokes the lease.',
      'No manager credentials are needed. Keep code and temporary files in their ordinary folders. Do not add the draft directory to source control.',
      `Catalog: ${JSON.stringify(catalog)}`,
      ...(!boards.length
        ? [
            'This project has no deliverables manager: do not retain documents. Ask the user to add a manager; project tools cannot create a manager.',
          ]
        : []),
      '</document_publication>',
    ].join('\n');
    return {
      context,
      draftDirectory: active.directory,
      bind: (turnId: string) => {
        active.turnId = turnId;
        if (active.completedTurnId === turnId && !active.completedSuccessfully)
          void this.finish(active);
      },
      abort: () => {
        void this.finish(active);
      },
    };
  }

  private async finish(scope: PublicationScope): Promise<void> {
    scope.revoked = true;
    if (scope.finishing) return scope.finishing;
    scope.finishing = (async () => {
      clearInterval(scope.timer);
      if (scope.processing) await scope.processing;
      if (this.scopes.get(scope.threadId) === scope)
        this.scopes.delete(scope.threadId);
    })();
    return scope.finishing;
  }

  async scan(scope: PublicationScope): Promise<void> {
    if (scope.processing) return scope.processing;
    scope.processing = this.process(scope).finally(() => {
      scope.processing = undefined;
    });
    return scope.processing;
  }

  private async process(scope: PublicationScope): Promise<void> {
    let request: PublicationRequest | undefined;
    let stage: string | undefined;
    try {
      if (this.scopes.get(scope.threadId) !== scope) return;
      const directory = await fs.lstat(scope.directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.ino !== scope.directoryInode
      )
        throw new Error('The draft directory was replaced');
      const manifest = await this.readDraft(
        scope,
        'publication-request.json',
        32 * 1024,
      );
      request = publicationRequest(JSON.parse(manifest.toString('utf8')));
      if (scope.seen.has(request.requestId)) return;
      if (scope.seen.size >= 20)
        throw new Error('Publication limit reached for this turn');
      scope.seen.add(request.requestId);
      const binding = this.db
        .select()
        .from(projectAgentThreads)
        .where(eq(projectAgentThreads.threadId, scope.threadId))
        .get();
      if (binding?.projectId !== scope.projectId)
        throw new Error('The agent project changed');
      const operation = async () => {
        this.deliverables.get(
          scope.projectId,
          request!.resourceId,
          request!.deliverableId,
        );
        stage = await this.protection.directory(scope.root, [
          'livrables',
          '.version-staging',
          randomUUID(),
        ]);
        const file = path.join(stage, path.basename(request!.file));
        await this.stageDraft(scope, request!.file, file);
        if (scope.revoked || this.scopes.get(scope.threadId) !== scope)
          throw new Error('The save operation was revoked before commit');
        return this.deliverables.addDocumentVersion(
          scope.projectId,
          request!.resourceId,
          request!.deliverableId,
          {
            path: file,
            expectedVersion: request!.expectedVersion,
            comment: request!.comment,
          },
          {
            personId: scope.access?.identity.personId ?? null,
            name: scope.agentName,
          },
          request!.documentId,
        );
      };
      let result: Awaited<ReturnType<typeof operation>>;
      if (scope.access) {
        const identity = scope.access.identity.personId
          ? scope.access.identities.resolvePerson(
              scope.access.identity.personId,
            )
          : scope.access.identity;
        scope.access.identities.requireActive(identity);
        scope.access.identities.requireAdministrator(identity);
        result = await accessContext.run(
          { ...scope.access, identity },
          operation,
        );
      } else result = await operation();
      await this.result(scope, {
        requestId: request.requestId,
        status: 'published',
        documentId: result.document.id,
        version: result.version.number,
        path: result.document.sourcePath,
      });
    } catch (error) {
      if (!request && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return;
      // Never include filesystem errors, private paths, or request contents in acknowledgements.
      await this.result(scope, {
        requestId: request?.requestId ?? null,
        status: 'failed',
        message:
          'Publication failed. Check the selected deliverable, document version and draft; the draft is preserved.',
      }).catch(() => {});
    } finally {
      if (stage) {
        await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
        // Never leave a technical staging folder in the working-space explorer.
        await fs.rmdir(path.dirname(stage)).catch(() => {});
      }
    }
  }

  private async readDraft(
    scope: PublicationScope,
    relative: string,
    limit: number,
  ): Promise<Buffer> {
    const file = await this.openDraft(scope, relative, limit);
    try {
      const buffer = Buffer.allocUnsafe(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw new Error('Draft too large');
      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  }

  private async openDraft(
    scope: PublicationScope,
    relative: string,
    limit: number,
  ) {
    const source = path.resolve(scope.directory, relative);
    if (!source.startsWith(scope.directory + path.sep))
      throw new Error('Invalid draft path');
    const file = await fs.open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      const actual = await fs.realpath(`/proc/self/fd/${file.fd}`);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > limit ||
        !actual.startsWith(scope.directory + path.sep)
      )
        throw new Error('Invalid draft file');
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  private async stageDraft(
    scope: PublicationScope,
    relative: string,
    target: string,
  ): Promise<void> {
    const limit = 100 * 1024 * 1024;
    const file = await this.openDraft(scope, relative, limit);
    try {
      const before = await file.stat();
      let size = 0;
      await pipeline(
        file.createReadStream({ autoClose: false }),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            callback(size > limit ? new Error('Draft too large') : null, chunk);
          },
        }),
        createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      );
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new Error('Draft changed while saving');
    } finally {
      await file.close();
    }
  }

  private async result(
    scope: PublicationScope,
    value: Record<string, unknown>,
    prefix = 'publication',
  ): Promise<void> {
    // Anchor writes to the checked directory descriptor. A full-access agent
    // replacing the path with a symlink must never redirect a backend write
    // into a retained-document directory between validation and acknowledgement.
    const directory = await fs.open(
      scope.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await directory.stat();
      const anchored = `/proc/self/fd/${directory.fd}`;
      if (
        !stat.isDirectory() ||
        stat.ino !== scope.directoryInode ||
        (await fs.realpath(anchored)) !== scope.directory
      )
        throw new Error('Replaced result directory');
      const temporary = path.join(
        anchored,
        `.${prefix}-result-${randomUUID()}`,
      );
      await fs.writeFile(temporary, JSON.stringify(value), {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.rename(temporary, path.join(anchored, `${prefix}-result.json`));
    } finally {
      await directory.close();
    }
  }
}
