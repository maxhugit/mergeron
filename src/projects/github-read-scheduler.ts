import { ConflictException, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

type Repository = { owner: string; repo: string; token?: string };
type Options = {
  apiVersion?: string;
  signal?: AbortSignal;
  cacheMs?: number;
  emptyRepository?: boolean;
};
type Cooldown = { until: number; failures: number; code: string };

/** One instance per backend: bounded reads, never used to authorize mutations. */
export class GitHubReadScheduler {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, { until: number; value: unknown }>();
  private readonly cooldowns = new Map<string, Cooldown>();
  private readonly logger = new Logger(GitHubReadScheduler.name);

  private scope(repo: Repository) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          repo.owner.toLowerCase(),
          repo.repo.toLowerCase(),
          repo.token ?? '',
        ]),
      )
      .digest('hex');
  }

  read<T>(
    repo: Repository,
    endpoint: string,
    options: Options = {},
  ): Promise<T> {
    const scope = this.scope(repo);
    const key = `${scope}:${options.apiVersion ?? '2022-11-28'}:${Boolean(options.emptyRepository)}:${endpoint}`;
    for (const [id, entry] of this.cache)
      if (entry.until <= Date.now()) this.cache.delete(id);
    const cached = options.cacheMs ? this.cache.get(key) : undefined;
    // A known outage must be visible even when an old successful value exists.
    const cooldown = this.cooldowns.get(scope);
    if (cooldown && cooldown.until > Date.now())
      return Promise.reject(new ConflictException(cooldown.code));
    if (cached) return Promise.resolve(cached.value as T);
    if (!options.signal && this.pending.has(key))
      return this.pending.get(key) as Promise<T>;
    const promise = this.run(repo, endpoint, scope, options).then((value) => {
      if (options.cacheMs) {
        if (this.cache.size >= 128) {
          const oldest = this.cache.keys().next();
          if (!oldest.done) this.cache.delete(oldest.value);
        }
        this.cache.set(key, { until: Date.now() + options.cacheMs, value });
      }
      return value as T;
    });
    // Independent observation budgets must not abort another caller's read.
    if (!options.signal) {
      this.pending.set(key, promise);
      void promise
        .finally(() => {
          if (this.pending.get(key) === promise) this.pending.delete(key);
        })
        .catch(() => {});
    }
    return promise;
  }

  private async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < 2) this.active++;
    else {
      if (this.queue.length >= 64)
        throw new ConflictException('GIT_GITHUB_BUSY');
      await new Promise<void>((resolve, reject) => {
        const cancel = (error: unknown) => {
          const index = this.queue.indexOf(start);
          if (index < 0) return;
          this.queue.splice(index, 1);
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(
            error instanceof Error
              ? error
              : new Error('GitHub observation cancelled'),
          );
        };
        const abort = () => cancel(signal?.reason);
        const timer = setTimeout(
          () => cancel(new ConflictException('GIT_GITHUB_BUSY')),
          30_000,
        );
        const start = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        this.queue.push(start);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return () => {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }

  private pause(scope: string, code: string, delay?: number) {
    const failures = Math.min(
      6,
      (this.cooldowns.get(scope)?.failures ?? 0) + 1,
    );
    if (!this.cooldowns.has(scope) && this.cooldowns.size >= 128) {
      const oldest = this.cooldowns.keys().next();
      if (!oldest.done) this.cooldowns.delete(oldest.value);
    }
    const old = this.cooldowns.get(scope);
    const until = Math.max(
      old?.until ?? 0,
      Date.now() + (delay ?? Math.min(60_000, 5000 * 2 ** (failures - 1))),
    );
    this.cooldowns.set(scope, { until, failures, code });
    this.logger.warn({
      event: 'github_read_failed',
      code,
      retryAfterMs: until - Date.now(),
    });
    return new ConflictException(code);
  }

  private async run(
    repo: Repository,
    endpoint: string,
    scope: string,
    options: Options,
  ) {
    const release = await this.acquire(options.signal);
    try {
      options.signal?.throwIfAborted();
      const cooldown = this.cooldowns.get(scope);
      if (cooldown && cooldown.until > Date.now())
        throw new ConflictException(cooldown.code);
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/${endpoint}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': options.apiVersion ?? '2022-11-28',
            ...(repo.token ? { Authorization: `Bearer ${repo.token}` } : {}),
          },
          redirect: 'error',
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        },
      );
      const header = (name: string) => response.headers?.get(name);
      if (!response.ok) await response.body?.cancel();
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (header('x-ratelimit-remaining') === '0' || header('retry-after')))
      ) {
        const retry = header('retry-after');
        const seconds =
          retry && /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : retry
              ? Date.parse(retry) - Date.now()
              : Number(header('x-ratelimit-reset')) * 1000 - Date.now();
        throw this.pause(
          scope,
          'GIT_GITHUB_RATE_LIMIT',
          Math.min(
            3_600_000,
            Math.max(60_000, Number.isFinite(seconds) ? seconds : 60_000),
          ),
        );
      }
      if (response.status === 401)
        throw this.pause(scope, 'GIT_GITHUB_AUTH', 60_000);
      if (response.status === 403)
        throw new ConflictException('GIT_GITHUB_ACCESS');
      if (response.status === 404)
        throw new ConflictException('GIT_GITHUB_ACCESS');
      if (options.emptyRepository && response.status === 409) return [];
      if (!response.ok) throw this.pause(scope, 'GIT_GITHUB_UNAVAILABLE');
      const value: unknown = await response.json();
      // A concurrent failure's cooldown must not be erased by an older success.
      if ((this.cooldowns.get(scope)?.until ?? 0) <= Date.now())
        this.cooldowns.delete(scope);
      return value;
    } catch (error) {
      if (error instanceof ConflictException || options.signal?.aborted)
        throw error;
      const code =
        (error as { name?: string; cause?: { code?: string } })?.name ===
          'TimeoutError' ||
        (error as { cause?: { code?: string } })?.cause?.code ===
          'UND_ERR_CONNECT_TIMEOUT'
          ? 'GIT_GITHUB_TIMEOUT'
          : 'GIT_GITHUB_NETWORK';
      throw this.pause(scope, code);
    } finally {
      release();
    }
  }
}
