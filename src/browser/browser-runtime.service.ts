import {
  Injectable,
  HttpException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ManagerStatusService } from '../settings/manager-status.service';

export interface BrowserRuntimeStatus {
  state: 'external' | 'missing' | 'stopped' | 'starting' | 'ready' | 'error';
  idleSeconds?: number;
  startupSeconds?: number;
  error?: string | null;
}

/** One expiring Manager lease per app process; real browser sessions keep it alive. */
@Injectable()
export class BrowserRuntimeService implements OnModuleDestroy {
  private readonly owner = randomUUID();
  private readonly refs = new Map<string, number>();
  private renewing = false;
  private external = false;
  private readonly timer = setInterval(() => void this.renew(), 20_000).unref();
  constructor(
    private readonly manager: ManagerStatusService,
    private readonly config: ConfigService,
  ) {}
  private failure() {
    return new ServiceUnavailableException({
      code: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
  }
  private async request(release = false): Promise<BrowserRuntimeStatus> {
    if (this.config.get('MERGERON_BROWSER_LIFECYCLE') === 'external')
      return { state: 'external' };
    try {
      const result = await this.manager.browserRuntime({
        owner: this.owner,
        release,
      });
      if (
        ![
          'external',
          'missing',
          'stopped',
          'starting',
          'ready',
          'error',
        ].includes(String(result.state))
      )
        throw this.failure();
      this.external = result.state === 'external';
      return result as unknown as BrowserRuntimeStatus;
    } catch (error) {
      // Compatibility with older Managers only; network failures must remain visible.
      if (error instanceof HttpException && error.getStatus() === 404) {
        this.external = true;
        return { state: 'external' };
      }
      throw this.failure();
    }
  }
  async prepare(key: string) {
    if (!this.refs.has(key) && this.refs.size >= 16) throw this.failure();
    if (this.refs.get(key) !== Infinity)
      this.refs.set(key, Date.now() + 90_000);
    try {
      const result = await this.request();
      if (result.state === 'error' || result.state === 'missing')
        await this.release(key);
      return result;
    } catch (error) {
      this.refs.delete(key);
      throw error;
    }
  }
  retain(key: string) {
    this.refs.set(key, Infinity);
  }
  async ready(key: string) {
    let deadline = Date.now() + 100_000;
    let policyRead = false;
    for (;;) {
      const result = await this.prepare(key);
      if (
        !policyRead &&
        typeof result.startupSeconds === 'number' &&
        result.startupSeconds >= 10 &&
        result.startupSeconds <= 300
      ) {
        deadline = Date.now() + (result.startupSeconds + 10) * 1000;
        policyRead = true;
      }
      if (result.state === 'ready' || result.state === 'external') return;
      if (
        result.state === 'error' ||
        result.state === 'missing' ||
        Date.now() >= deadline
      ) {
        await this.release(key);
        throw this.failure();
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  async release(key: string) {
    this.refs.delete(key);
    if (!this.refs.size && !this.external)
      await this.request(true).catch(() => {});
  }
  private async renew() {
    if (this.renewing) return;
    this.renewing = true;
    try {
      for (const [key, expires] of this.refs)
        if (expires <= Date.now()) this.refs.delete(key);
      if (this.refs.size) await this.request();
    } catch {
      /* A live operation reports failure; a failed renewal never grants access. */
    } finally {
      this.renewing = false;
    }
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    this.refs.clear();
    if (!this.external) await this.request(true).catch(() => {});
  }
}
