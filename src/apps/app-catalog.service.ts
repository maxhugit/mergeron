import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  readFileSync,
  closeSync,
  mkdirSync,
  lstatSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { SettingsService } from '../settings/settings.service';
import { AppCatalogTransport } from './app-catalog-transport.service';
import {
  CATALOG_SETTING,
  CATALOG_DAY,
  type CatalogState,
  validateDirectory,
} from './app-catalog-model';

@Injectable()
export class AppCatalogService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> | null = null;
  private cached?: { scope: string; stamp: string; state: CatalogState };
  private readonly logger = new Logger(AppCatalogService.name);
  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly transport: AppCatalogTransport,
  ) {}
  get enabled() {
    return this.settings.getSetting(CATALOG_SETTING).value === 'byparr';
  }
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => this.logger.warn('CATALOG_STORAGE_FAILED'));
    }, 60000);
    this.timer.unref();
    // No external request is started by opening a settings page.
    void this.tick().catch(() => this.logger.warn('CATALOG_STORAGE_FAILED'));
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private get home() {
    return (
      this.config.get<string>('CODEX_HOME') ??
      join(process.env.HOME ?? '/home/codex', '.codex')
    );
  }
  private identity() {
    let fd: number | undefined;
    try {
      fd = openSync(
        join(this.home, 'auth.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const auth = JSON.parse(readFileSync(fd, 'utf8')) as {
        tokens?: {
          access_token?: string;
          account_id?: string;
          id_token?: string;
        };
      };
      const tokens = auth.tokens;
      if (
        typeof tokens?.access_token !== 'string' ||
        !tokens.access_token ||
        typeof tokens.account_id !== 'string' ||
        !tokens.account_id ||
        typeof tokens.id_token !== 'string' ||
        !tokens.id_token
      )
        throw Error();
      const claims = JSON.parse(
        Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString(),
      ) as { sub?: string };
      if (!claims.sub) throw Error();
      const scope = createHash('sha256')
        .update(tokens.account_id + '\0' + claims.sub)
        .digest('hex');
      return {
        scope,
        accessToken: tokens.access_token,
        accountId: tokens.account_id,
      };
    } catch {
      throw Error('CATALOG_AUTH_UNAVAILABLE');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private directory() {
    let path = this.home;
    for (const part of ['webui', 'app-directory']) {
      path = join(path, part);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('CATALOG_STORAGE_FAILED');
    }
    return path;
  }
  private path(scope: string) {
    return join(this.directory(), scope + '.json');
  }
  private currentScope() {
    try {
      return this.identity().scope;
    } catch {
      return 'unavailable';
    }
  }
  private read(scope = this.currentScope()): CatalogState {
    const fallback: CatalogState = {
      version: 1,
      scope,
      apps: [],
      updatedAt: null,
      nextAttempt: 0,
      history: [],
    };
    try {
      const path = this.path(scope),
        stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 33 * 1024 ** 2)
        throw Error('CATALOG_STORAGE_FAILED');
      const stamp = [stat.ino, stat.mtimeMs, stat.size].join(':');
      if (this.cached?.scope === scope && this.cached.stamp === stamp)
        return this.cached.state;
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const state = JSON.parse(readFileSync(fd, 'utf8')) as CatalogState;
        if (
          state.version !== 1 ||
          state.scope !== scope ||
          !Array.isArray(state.history) ||
          !Number.isFinite(state.nextAttempt)
        )
          throw Error('CATALOG_STORAGE_FAILED');
        if (state.apps.length) validateDirectory(state);
        this.cached = { scope, stamp, state };
        return state;
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw Error('CATALOG_STORAGE_FAILED');
    }
  }
  private write(state: CatalogState) {
    const path = this.path(state.scope),
      temp = path + '.' + randomUUID();
    try {
      const fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(fd, JSON.stringify(state));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      this.cached = undefined;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* already renamed */
      }
    }
  }
  async workerStatus() {
    try {
      return await this.transport.request('status');
    } catch {
      return {
        enabled: false,
        present: false,
        running: false,
        healthy: false,
        version: null,
        error: 'CATALOG_MANAGER_UNAVAILABLE',
      };
    }
  }
  status() {
    const state = this.read();
    return {
      source: this.enabled ? 'byparr' : 'native',
      running: this.pending !== null,
      updatedAt: state.updatedAt,
      nextAttempt: this.enabled ? state.nextAttempt : null,
      count: state.apps.length,
      stale:
        state.updatedAt !== null && Date.now() - state.updatedAt > CATALOG_DAY,
      warning:
        state.history[0]?.status === 'failed' ||
        (state.history[0]?.status === 'running' && !this.pending),
      history: state.history.slice(0, 30),
    };
  }
  async setSource(source: 'native' | 'byparr') {
    if (source === 'byparr') {
      try {
        await this.transport.request('prepare');
      } catch (error) {
        const code =
          error instanceof Error && /^CATALOG_[A-Z_]{1,50}$/.test(error.message)
            ? error.message
            : 'CATALOG_PREPARE_FAILED';
        const current = this.read();
        const state = { ...current, history: [...current.history] };
        state.history = [
          {
            at: Date.now(),
            status: 'failed' as const,
            code,
          },
          ...state.history,
        ].slice(0, 30);
        this.write(state);
        throw new ServiceUnavailableException('CATALOG_PREPARE_FAILED');
      }
    }
    this.settings.updateSetting(CATALOG_SETTING, source);
    if (source === 'byparr') await this.tick();
    return this.status();
  }
  async tick() {
    if (!this.enabled) return;
    if (this.pending) return this.pending;
    const scope = this.currentScope();
    const current = this.read(scope);
    const state = { ...current, history: [...current.history] };
    if (state.history[0]?.status === 'running') {
      state.history[0] = {
        ...state.history[0],
        status: 'failed',
        code: 'CATALOG_INTERRUPTED',
      };
      this.write(state);
    }
    if (Date.now() < state.nextAttempt) return;
    this.pending = this.refresh(state).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async refresh(state: CatalogState) {
    const now = Date.now();
    // Persist the attempt before the request: restarts cannot create a retry loop.
    state.nextAttempt = now + CATALOG_DAY;
    state.history = [
      { at: now, status: 'running' as const, code: 'CATALOG_RUNNING' },
      ...state.history,
    ].slice(0, 30);
    this.write(state);
    try {
      const identity = this.identity();
      if (identity.scope !== state.scope)
        throw Error('CATALOG_ACCOUNT_CHANGED');
      const result = await this.transport.request('download', {
        accessToken: identity.accessToken,
        accountId: identity.accountId,
      });
      const apps = validateDirectory(result);
      if (!this.enabled || this.currentScope() !== state.scope)
        throw Error('CATALOG_ACCOUNT_CHANGED');
      state.apps = apps;
      state.updatedAt = Date.now();
      state.history[0] = {
        at: now,
        status: 'success',
        code: 'CATALOG_UPDATED',
        count: apps.length,
      };
    } catch (e) {
      const code =
        e instanceof Error && /^CATALOG_[A-Z_]{1,50}$/.test(e.message)
          ? e.message
          : 'CATALOG_DOWNLOAD_FAILED';
      state.history[0] = { at: now, status: 'failed', code };
      this.logger.warn(code); // Never log native error bodies or credentials.
    }
    this.write(state);
    if (state.history[0]?.status === 'success')
      this.logger.log('CATALOG_UPDATED count=' + state.apps.length);
  }
  snapshot() {
    const state = this.read();
    if (!state.updatedAt || !state.apps.length)
      throw new ServiceUnavailableException('CATALOG_NOT_READY');
    return state;
  }
}
