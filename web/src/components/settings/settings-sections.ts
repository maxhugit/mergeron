export const SETTINGS_SECTIONS = [
  'general',
  'infrastructure',
  'onlyOffice',
  'people',
  'account',
  'codex',
  'codexCli',
  'simpleChat',
  'terminal',
  'files',
  'database',
  'security',
  'integrations',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const ONLYOFFICE_SETTING_KEYS = [
  'general.onlyofficeUrl',
  'general.onlyofficeJwtSecret',
  'general.onlyofficeSaveMaxBytes',
  'general.publicBaseUrl',
] as const;
