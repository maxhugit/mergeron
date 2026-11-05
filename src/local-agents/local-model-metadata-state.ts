import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SettingsService } from '../settings/settings.service';
export const LOCAL_KEYS = {
  enabled: 'general.localAgentsEnabled',
  url: 'general.localAgentsUrl',
  models: 'general.localAgentsModels',
  context: 'general.localAgentsContext',
} as const;
@Injectable()
export class LocalModelMetadataState {
  private loaded: string | null = null;
  private generated = new Set<string>();
  constructor(private readonly settings: SettingsService) {}
  configuration() {
    return {
      enabled: this.settings.getSetting(LOCAL_KEYS.enabled).value === true,
      models: [
        ...new Set(
          (this.settings.getStringSetting(LOCAL_KEYS.models) ?? '')
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean),
        ),
      ].sort(),
      context: this.settings.getNumberSetting(LOCAL_KEYS.context),
    };
  }
  signature() {
    return createHash('sha256')
      .update(JSON.stringify(this.configuration()))
      .digest('hex');
  }
  requiresRestart() {
    return this.loaded !== this.signature();
  }
  assertReady() {
    if (this.requiresRestart())
      throw new ConflictException({
        code: 'LOCAL_MODEL_METADATA_RESTART_REQUIRED',
        message:
          'Restart Codex when agents are idle to load the local model metadata.',
      });
  }
  accept(signature: string, generated: string[]) {
    this.loaded = signature;
    this.generated = new Set(generated);
  }
  clear() {
    this.loaded = null;
    this.generated.clear();
  }
  isGenerated(model: string) {
    return this.generated.has(model);
  }
}
