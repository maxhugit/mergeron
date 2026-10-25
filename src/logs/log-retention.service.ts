import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { requireExecutionAccess } from '../auth/access-context';
import {
  configureLogRetention,
  DEFAULT_LOG_RETENTION,
  LOG_RETENTION_KEY,
  logStorageInventory,
  pruneLogArchives,
  validateLogRetention,
} from './log-retention';

@Injectable()
export class LogRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogRetentionService.name);
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private running = false;
  constructor(private readonly settings: SettingsService) {}
  policy() {
    try {
      return validateLogRetention(
        this.settings.getSetting(LOG_RETENTION_KEY).value,
      );
    } catch {
      return {
        ...DEFAULT_LOG_RETENTION,
        application: { ...DEFAULT_LOG_RETENTION.application, enabled: false },
        codex: { ...DEFAULT_LOG_RETENTION.codex, enabled: false },
      };
    }
  }
  onModuleInit() {
    configureLogRetention(this.policy());
    this.unsubscribe = this.settings.onChange((event) => {
      if (event.key === LOG_RETENTION_KEY) configureLogRetention(this.policy());
    });
    this.timer = setInterval(() => {
      void this.maintain();
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }
  async storage() {
    requireExecutionAccess();
    const files = await logStorageInventory();
    return {
      estimatedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
      policy: this.policy(),
    };
  }
  async update(value: unknown) {
    requireExecutionAccess();
    let policy;
    try {
      policy = validateLogRetention(value);
    } catch {
      throw new BadRequestException('Invalid log retention policy');
    }
    this.settings.updateSetting(LOG_RETENTION_KEY, policy);
    configureLogRetention(policy);
    // First cleanup is performed by the next maintenance tick, not the GET.
    return { policy };
  }
  private async maintain() {
    if (this.running) return;
    this.running = true;
    try {
      await pruneLogArchives(this.policy());
    } catch {
      this.logger.warn('Log retention cleanup will be retried');
    } finally {
      this.running = false;
    }
  }
}
