import type { PreviewProfile } from './preview-profile.cjs';
export interface ExecutionCheck {
  valid: boolean;
  mode: 'development' | 'production' | 'test' | 'unknown';
  port: number;
  kind: 'development' | 'production' | 'custom';
  issues: {
    code:
      | 'portConflict'
      | 'modeOverride'
      | 'modeConflict'
      | 'commandUnknown'
      | 'modeUnknown'
      | 'hotProduction'
      | 'backgroundServer';
    severity: 'error' | 'warning';
  }[];
}
export function executionCheck(profile: PreviewProfile): ExecutionCheck;
