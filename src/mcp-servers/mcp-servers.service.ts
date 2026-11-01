import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { mcpTransportConfig, validateMcpServerName } from './mcp-server-config';
import type { McpServerConfigDto } from './dto/mcp-server-config.dto';
/** MCP server status facade over Codex app-server JSON-RPC methods. */
import { Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';

@Injectable()
export class McpServersService {
  constructor(private readonly codex: CodexService) {}

  /** Lists MCP server inventory and auth metadata. */
  async listServers(
    params: v2.ListMcpServerStatusParams = {},
  ): Promise<v2.ListMcpServerStatusResponse> {
    return this.codex.request<v2.ListMcpServerStatusResponse>(
      'mcpServerStatus/list',
      params,
    );
  }

  /** Writes only named transport leaves; never replaces another server or its secrets. */
  async configure(body: McpServerConfigDto) {
    const transport = mcpTransportConfig(body);
    const response = await this.codex.request<v2.ConfigReadResponse>(
      'config/read',
      { includeLayers: true },
    );
    const servers =
      (
        response.config as unknown as {
          mcp_servers?: Record<string, { url?: string; command?: string }>;
        }
      ).mcp_servers ?? {};
    const existing = servers[body.name];
    if ((existing && !body.update) || (!existing && body.update)) {
      throw BusinessException.conflict(
        ErrorCode.http.conflict,
        'Reload the server inventory before saving',
      );
    }
    if (existing && Boolean(existing.url) !== (body.transport === 'http')) {
      throw BusinessException.badRequest(
        ErrorCode.validation.fieldInvalid,
        'Transport cannot be changed for an existing server',
        { field: 'transport' },
      );
    }
    const layer = response.layers?.find(
      (layer) => layer.name.type === 'user' && !layer.name.profile,
    );
    await this.codex.request('config/batchWrite', {
      edits: Object.entries(transport).map(([key, value]) => ({
        keyPath: `mcp_servers.${body.name}.${key}`,
        value,
        mergeStrategy: 'replace' as const,
      })),
      ...(layer ? { expectedVersion: layer.version } : {}),
      reloadUserConfig: true,
    } satisfies v2.ConfigBatchWriteParams);
    return { name: body.name, saved: true, reloadRequired: true };
  }

  /** Tests only an already configured server through the normal filtered runtime. */
  async check(name: string) {
    validateMcpServerName(name);
    const config = await this.codex.request<v2.ConfigReadResponse>(
      'config/read',
      {},
    );
    const servers = (
      config.config as unknown as { mcp_servers?: Record<string, unknown> }
    ).mcp_servers;
    if (!servers || !Object.hasOwn(servers, name))
      throw BusinessException.badRequest(
        ErrorCode.validation.fieldInvalid,
        'Save the server before checking',
        { field: 'name' },
      );
    await this.reloadAll();
    return this.listServers({ detail: 'toolsAndAuthOnly', limit: 100 });
  }

  /** Reloads all configured MCP servers. The protocol does not support per-server toggles. */
  async reloadAll(): Promise<void> {
    await this.codex.request<v2.McpServerRefreshResponse>(
      'config/mcpServer/reload',
    );
  }

  /** Starts an OAuth login flow for an MCP server and returns the browser URL. */
  startOauthLogin(
    params: v2.McpServerOauthLoginParams,
  ): Promise<v2.McpServerOauthLoginResponse> {
    return this.codex.request<v2.McpServerOauthLoginResponse>(
      'mcpServer/oauth/login',
      params,
    );
  }
}
