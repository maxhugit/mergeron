/** Shared helpers for runtime settings UI. */
import type { SettingDto } from '@/generated/api/types.gen';

export type SettingValue = SettingDto['value'];
export type RuntimeSetting = SettingDto;

export function parseDraftValue(
  setting: RuntimeSetting,
  draft: string,
): { ok: true; value: SettingValue } | { ok: false; error: string } {
  if (setting.type === 'number') {
    if (!draft.trim()) return { ok: false, error: 'Value is required' };
    const value = Number(draft);
    if (!Number.isFinite(value))
      return { ok: false, error: 'Value must be a number' };
    if (setting.constraints.integer && !Number.isInteger(value)) {
      return { ok: false, error: 'Value must be an integer' };
    }
    if (
      setting.constraints.min !== undefined &&
      value < setting.constraints.min
    ) {
      return { ok: false, error: 'Value is below the minimum' };
    }
    if (
      setting.constraints.max !== undefined &&
      value > setting.constraints.max
    ) {
      return { ok: false, error: 'Value is above the maximum' };
    }
    return { ok: true, value };
  }

  if (setting.type === 'boolean') {
    return { ok: true, value: draft === 'true' };
  }

  if (setting.type === 'json') {
    try {
      return { ok: true, value: JSON.parse(draft) as SettingValue };
    } catch {
      return { ok: false, error: 'Value must be valid JSON' };
    }
  }

  return { ok: true, value: draft };
}

export function formatSettingValue(value: SettingValue): string {
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function sectionLabel(section: string): string {
  if (section === 'simpleChat') return 'Codex';
  const labels: Record<string, string> = {
    general: 'General',
    onlyOffice: 'OnlyOffice',
    people: 'People',
    account: 'Account',
    codex: 'Codex',
    codexCli: 'Codex CLI',
    terminal: 'Terminal',
    files: 'Files',
    database: 'Database',
    security: 'Security',
    integrations: 'Integrations',
  };
  return labels[section] ?? section;
}

export function settingsPageLabel(section: string): string {
  if (section === 'internalMcp') return 'internalMcpTitle';
  if (section === 'general') return 'Server';
  if (section === 'infrastructure') return 'managerInfrastructure';
  if (section === 'files') return 'File settings';
  if (section === 'terminal') return 'Terminal settings';
  return sectionLabel(section);
}

/** Short context displayed below the active administration title. */
export function settingsPageDescription(section: string): string {
  const descriptions: Record<string, string> = {
    internalMcp: 'internalMcpDescription',
    general:
      'Manage server runtime settings. Personal appearance and session logout are available from My account.',
    infrastructure: 'managerInfrastructureDescription',
    onlyOffice: 'onlyOfficeSettingsDescription',
    people:
      'Create people before they connect. The manual reference uniquely identifies each person.',
    account:
      'Manage Codex app-server auth separately from the WebUI session login.',
    codex:
      'Manage Codex app-server settings. Changes are saved to user config.toml and hot-reloaded.',
    codexCli:
      'Review installed and available Codex CLI versions, then manage updates safely.',
    simpleChat:
      'Choose the execution engine used by Simple Chat conversations.',
    terminal:
      'Runtime changes apply only to new terminals and future detach timers.',
    files: 'File upload limits take effect after server restart.',
    database: 'Review the storage configuration and current database status.',
    security:
      'Manage authentication, local accounts and workspace access restrictions.',
    integrations:
      'Manage the plugins, applications, and MCP servers available on the platform.',
  };
  return descriptions[section] ?? '';
}

export function settingLabel(key: string): string {
  const labels: Record<string, string> = {
    'general.maxIdleSubscriptions': 'Maximum idle subscriptions',
    'general.onlyofficeUrl': 'OnlyOffice server URL',
    'general.onlyofficeJwtSecret': 'OnlyOffice JWT secret',
    'general.onlyofficeSaveMaxBytes': 'OnlyOffice maximum save size',
    'general.publicBaseUrl': 'Public Mergeron URL',
    'terminal.maxSessions': 'Maximum terminal sessions',
    'terminal.graceMs': 'Detached terminal timeout',
    'terminal.scrollback': 'Terminal scrollback lines',
    'terminal.defaultCwd': 'Default terminal directory',
    'files.uploadMaxBytes': 'Maximum upload size',
    'files.excludedDirs': 'Excluded files and directories',
    'security.workspaceRoots': 'Allowed workspace roots',
  };
  if (labels[key]) return labels[key];
  const label = key.split('.').at(-1) ?? key;
  return label.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

export function sourceLabel(source: RuntimeSetting['source']): string {
  if (source === 'db') return 'runtime override';
  if (source === 'env') return 'environment';
  return 'default';
}

export function sourceVariant(
  source: RuntimeSetting['source'],
): 'default' | 'secondary' | 'outline' {
  if (source === 'db') return 'default';
  if (source === 'env') return 'secondary';
  return 'outline';
}
