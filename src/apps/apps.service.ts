import { requireThreadAccess } from '../auth/access-context';
import { AppCatalogService } from './app-catalog.service';
import { catalogApp } from './app-catalog-model';
/** Apps facade over Codex app-server JSON-RPC methods. */
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';

@Injectable()
export class AppsService {
  constructor(
    private readonly codex: CodexService,
    @Optional() private readonly catalog?: AppCatalogService,
  ) {}

  /** Lists experimental apps/connectors from Codex app-server. */
  async listApps(params: v2.AppsListParams = {}): Promise<v2.AppsListResponse> {
    if (params.threadId) requireThreadAccess(params.threadId);
    if (!this.catalog?.enabled)
      return this.codex.request<v2.AppsListResponse>('app/list', params);
    const state = this.catalog.snapshot();
    let offset = 0;
    if (params.cursor) {
      const parts = params.cursor.split(':');
      if (
        parts.length !== 4 ||
        parts[0] !== 'catalog' ||
        parts[1] !== state.scope ||
        parts[2] !== String(state.updatedAt) ||
        !/^(0|[1-9][0-9]{0,5})$/.test(parts[3])
      )
        throw new BadRequestException('CATALOG_CURSOR_EXPIRED');
      offset = Number(parts[3]);
      if (offset >= state.apps.length)
        throw new BadRequestException('CATALOG_CURSOR_EXPIRED');
    }
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    // The daily file stores discovery metadata only, never live permissions.
    const runtime = await this.installedApps({
      threadId: params.threadId,
    }).catch(() => ({ apps: [] as v2.InstalledApp[] }));
    const byId = new Map(runtime.apps.map((app) => [app.id, app]));
    const apps = state.apps.filter((app) => app.visibility !== 'HIDDEN');
    const data = apps
      .slice(offset, offset + limit)
      .map((app) => catalogApp(app, byId.get(app.id as string)));
    const next = offset + limit;
    return {
      data,
      nextCursor:
        next < apps.length
          ? ['catalog', state.scope, state.updatedAt, next].join(':')
          : null,
    };
  }

  /** Reads the committed runtime inventory without fetching the directory. */
  installedApps(
    params: v2.AppsInstalledParams = {},
  ): Promise<v2.AppsInstalledResponse> {
    return this.codex.request('app/installed', params);
  }

  /** Reads fresh metadata for one or more apps/connectors. */
  async readApps(params: v2.AppsReadParams): Promise<v2.AppsReadResponse> {
    if (params.threadId) requireThreadAccess(params.threadId);
    try {
      return await this.codex.request<v2.AppsReadResponse>('app/read', params);
    } catch (error) {
      if (!this.catalog?.enabled) throw error;
      const state = this.catalog.snapshot();
      const known = new Map(
        state.apps
          .filter((app) => app.visibility !== 'HIDDEN')
          .map((app) => [app.id, app]),
      );
      const apps: v2.AppsReadResponse['apps'] = [],
        missingAppIds: string[] = [];
      for (const id of new Set(params.appIds)) {
        const app = known.get(id);
        if (!app) {
          missingAppIds.push(id);
          continue;
        }
        const info = catalogApp(app);
        apps.push({
          id,
          name: info.name,
          description: info.description,
          iconUrl: info.logoUrl,
          iconUrlDark: info.logoUrlDark,
          distributionChannel: info.distributionChannel,
          installUrl: info.installUrl,
          pluginDisplayNames: [],
          toolSummaries: null,
        });
      }
      return { apps, missingAppIds };
    }
  }
}
