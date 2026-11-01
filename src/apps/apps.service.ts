/** Apps facade over Codex app-server JSON-RPC methods. */
import { Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';

@Injectable()
export class AppsService {
  constructor(private readonly codex: CodexService) {}

  /** Lists experimental apps/connectors from Codex app-server. */
  listApps(params: v2.AppsListParams = {}): Promise<v2.AppsListResponse> {
    return this.codex.request<v2.AppsListResponse>('app/list', params);
  }

  /** Reads the committed runtime inventory without fetching the directory. */
  installedApps(
    params: v2.AppsInstalledParams = {},
  ): Promise<v2.AppsInstalledResponse> {
    return this.codex.request('app/installed', params);
  }

  /** Reads fresh metadata for one or more apps/connectors. */
  readApps(params: v2.AppsReadParams): Promise<v2.AppsReadResponse> {
    return this.codex.request<v2.AppsReadResponse>('app/read', params);
  }
}
