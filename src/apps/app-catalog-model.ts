import type { v2 } from '../codex/codex-schema';
export const CATALOG_SETTING = 'general.applicationCatalogSource';
export const CATALOG_DAY = 24 * 60 * 60 * 1000;
export type CatalogEvent = {
  at: number;
  status: 'running' | 'success' | 'failed';
  code: string;
  count?: number;
};
export type CatalogState = {
  version: 1;
  scope: string;
  updatedAt: number | null;
  nextAttempt: number;
  apps: Record<string, unknown>[];
  history: CatalogEvent[];
};
export function validateDirectory(value: unknown): Record<string, unknown>[] {
  const apps = (value as { apps?: unknown })?.apps;
  if (!Array.isArray(apps) || apps.length === 0 || apps.length > 20000)
    throw Error('CATALOG_INVALID_RESPONSE');
  const seen = new Set<string>();
  const entries: unknown[] = apps;
  for (const entry of entries) {
    const app = entry as Record<string, unknown> | null;
    if (
      !app ||
      typeof app !== 'object' ||
      typeof app.id !== 'string' ||
      !app.id ||
      app.id.length > 512 ||
      typeof app.name !== 'string' ||
      app.name.length > 1024 ||
      seen.has(app.id)
    )
      throw Error('CATALOG_INVALID_RESPONSE');
    seen.add(app.id);
  }
  return apps as Record<string, unknown>[];
}
const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
const url = (value: unknown): string | null =>
  typeof value === 'string' && /^https:\/\//i.test(value) ? value : null;
/** Snapshot metadata never establishes accessibility or tool permissions. */
export function catalogApp(
  app: Record<string, unknown>,
  runtime?: v2.InstalledApp,
): v2.AppInfo {
  const id = app.id as string,
    name = (app.name as string).trim() || id;
  const branding = app.branding as Record<string, unknown> | undefined;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/^-+|-+$/g, '') || 'app';
  return {
    id,
    name,
    description: str(app.description),
    logoUrl: url(app.logo_url ?? app.logoUrl),
    logoUrlDark: url(app.logo_url_dark ?? app.logoUrlDark),
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: str(
      app.distribution_channel ?? app.distributionChannel,
    ),
    branding: branding
      ? {
          category: str(branding.category),
          developer: str(branding.developer),
          website: url(branding.website),
          privacyPolicy: url(branding.privacy_policy ?? branding.privacyPolicy),
          termsOfService: url(
            branding.terms_of_service ?? branding.termsOfService,
          ),
          isDiscoverableApp: true,
        }
      : null,
    appMetadata: null,
    labels: null,
    installUrl:
      'https://chatgpt.com/apps/' + slug + '/' + encodeURIComponent(id),
    isAccessible: runtime?.callable === true,
    isEnabled: runtime?.enabled === true,
    pluginDisplayNames: [],
  };
}
