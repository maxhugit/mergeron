import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { DatabaseService } from '../database/database.service';
import { CatalogPathsService } from '../codex/catalog/catalog-paths.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';

export const PROJECT_ARCHIVE_MAX_BYTES = 96 * 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60_000;
const runFile = promisify(execFile);

interface PendingArchive {
  directory: string;
  file: string;
  owner: string;
  expiresAt: number;
}

/** Admin-only, single-flight project transport. Upload tokens never contain filesystem paths. */
@Injectable()
export class ProjectArchivesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectArchivesService.name);
  private readonly pending = new Map<string, PendingArchive>();
  private readonly paths: CatalogPathsService;
  private active = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly children = new Set<ChildProcessWithoutNullStreams>();

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService,
    private readonly metadata: ThreadMetadataService,
  ) {
    this.paths = new CatalogPathsService(config);
  }

  async onModuleInit() {
    // Recover only UUID-owned, unpublished imports, never existing projects.
    if (
      existsSync(
        join(dirname(this.database.databasePath), 'project-import-journal'),
      )
    ) {
      await this.engine({ action: 'recover' });
      this.metadata.invalidate();
    }
    this.timer = setInterval(() => {
      void this.expire().catch(() => {
        this.logger.warn('Nettoyage des ZIP temporaires à réessayer.');
      });
    }, 60_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
            child.once('close', () => {
              clearTimeout(timeout);
              resolve();
            });
            child.kill('SIGTERM');
          }),
      ),
    );
    await Promise.all(
      [...this.pending.values()].map((entry) =>
        rm(entry.directory, { recursive: true, force: true }),
      ),
    );
    this.pending.clear();
  }

  private async expire() {
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt > Date.now()) continue;
      this.pending.delete(token);
      await rm(entry.directory, { recursive: true, force: true });
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active)
      throw new ConflictException(
        'Un export ou import est déjà en cours. Réessayez après sa fin.',
      );
    this.active = true;
    try {
      return await operation();
    } finally {
      this.active = false;
    }
  }

  private async engine<T = Record<string, unknown>>(
    input: Record<string, unknown>,
  ): Promise<T> {
    let codexVersion = '';
    if (input.action !== 'recover') {
      try {
        const { stdout } = await runFile(this.paths.binary, ['--version'], {
          timeout: 10_000,
        });
        codexVersion = stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? '';
      } catch {
        /* A project without agents does not require a configured provider or CLI. */
      }
    }
    const version = (
      JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    return new Promise<T>((resolve, reject) => {
      const child = spawn(
        'python3',
        [join(process.cwd(), 'scripts/project_archive.py')],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          // No shell; archive names/contents never become executable arguments.
        },
      );
      this.children.add(child);
      let output = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        // SIGTERM is cooperative in the engine, so its rollback runs before exit.
        timedOut = true;
        child.kill('SIGTERM');
      }, 10 * 60_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 2 * 1024 * 1024) child.kill('SIGTERM');
      });
      // Never include arbitrary project contents or native SQL errors in server logs.
      child.stderr.resume();
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', () => {
        this.children.delete(child);
        clearTimeout(timer);
        try {
          const result = JSON.parse(output) as {
            ok: boolean;
            result: T;
            error?: string;
          };
          if (!result.ok)
            throw new BadRequestException(
              result.error ?? 'Import ou export impossible.',
            );
          resolve(result.result);
        } catch (error) {
          reject(
            error instanceof BadRequestException
              ? error
              : new BadRequestException(
                  timedOut
                    ? 'Le transfert a dépassé le délai maximal. Vérifiez l’état de l’import avant de réessayer.'
                    : 'Le transfert de projet a échoué. Aucun projet existant n’a été écrasé.',
                ),
          );
        }
      });
      child.stdin.on('error', () => {
        /* close/error supplies the actionable failure */
      });
      child.stdin.end(
        JSON.stringify({
          database: this.database.databasePath,
          workspaceRoot: '/workspaces',
          codexHome: this.paths.home,
          codexBin: this.paths.binary,
          codexVersion,
          version,
          ...input,
        }),
      );
    });
  }

  async exportProject(projectId: string) {
    return this.exclusive(async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'mergeron-project-export-'),
      );
      await chmod(directory, 0o700);
      const file = join(directory, 'project.zip');
      try {
        await this.engine({ action: 'export', projectId, archive: file });
        return {
          file,
          dispose: () => rm(directory, { recursive: true, force: true }),
        };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async preview(owner: string, stream: Readable & { truncated?: boolean }) {
    return this.exclusive(async () => {
      await this.expire();
      if (this.pending.size >= 4)
        throw new ConflictException(
          'Quatre ZIP sont déjà en attente. Importez-les ou attendez leur expiration.',
        );
      const directory = await mkdtemp(
        join(tmpdir(), 'mergeron-project-import-'),
      );
      await chmod(directory, 0o700);
      const file = join(directory, 'project.zip');
      try {
        await pipeline(
          stream,
          createWriteStream(file, { flags: 'wx', mode: 0o600 }),
        );
        if (stream.truncated)
          throw new BadRequestException(
            'Le ZIP dépasse la limite de transfert de 96 Mio.',
          );
        const result = await this.engine({ action: 'preview', archive: file });
        const token = randomUUID();
        this.pending.set(token, {
          directory,
          file,
          owner,
          expiresAt: Date.now() + PREVIEW_TTL_MS,
        });
        return { ...result, token, expiresAt: Date.now() + PREVIEW_TTL_MS };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async importProject(
    owner: string,
    personId: string | null,
    input: { token?: unknown; name?: unknown },
  ) {
    return this.exclusive(async () => {
      await this.expire();
      const entry =
        typeof input.token === 'string'
          ? this.pending.get(input.token)
          : undefined;
      if (!entry)
        throw new BadRequestException(
          'L’analyse du ZIP a expiré. Sélectionnez à nouveau le fichier.',
        );
      if (entry.owner !== owner)
        throw new ForbiddenException(
          'Ce ZIP appartient à une autre session administrative.',
        );
      if (
        input.name !== undefined &&
        (typeof input.name !== 'string' ||
          !input.name.trim() ||
          input.name.length > 200)
      )
        throw new BadRequestException(
          'Le nom du projet doit contenir entre 1 et 200 caractères.',
        );
      this.pending.delete(input.token as string);
      try {
        const result = await this.engine({
          action: 'import',
          archive: entry.file,
          name: input.name,
          personId,
        });
        this.metadata.invalidate();
        return result;
      } finally {
        await rm(entry.directory, { recursive: true, force: true });
      }
    });
  }

  async discard(owner: string, token: string) {
    const entry = this.pending.get(token);
    if (!entry) return { ok: true };
    if (entry.owner !== owner)
      throw new ForbiddenException(
        'Ce ZIP appartient à une autre session administrative.',
      );
    this.pending.delete(token);
    await rm(entry.directory, { recursive: true, force: true });
    return { ok: true };
  }
}
