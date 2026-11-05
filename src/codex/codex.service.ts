import { LocalModelCatalogService } from './catalog/local-model-catalog.service';
import type { v2 } from './codex-schema';
/**
 * Thin facade over CodexProcessManager for business modules.
 * Provides typed request helpers that map to app-server JSON-RPC methods.
 */
import { Injectable, Optional } from '@nestjs/common';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { CodexProcessManager } from './codex-process-manager.service';
import type { CodexJsonRpcClient } from './codex-jsonrpc-client';
import { CodexUnavailableError } from './codex-errors';

@Injectable()
export class CodexService {
  constructor(
    private readonly processManager: CodexProcessManager,
    @Optional() private readonly localAgents?: LocalAgentsService,
    @Optional() private readonly localCatalog?: LocalModelCatalogService,
  ) {}

  /**
   * Returns the active JSON-RPC client.
   *
   * @throws Error if the app-server is not connected
   */
  getClient(): CodexJsonRpcClient {
    const client = this.processManager.getClient();
    if (!client) {
      throw new CodexUnavailableError();
    }
    return client;
  }

  /**
   * Sends a typed request to the app-server and returns the result.
   *
   * @param method - JSON-RPC method name
   * @param params - Method parameters
   * @returns The response result
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method === 'config/read' && this.localCatalog) {
      const response = await this.getClient().request<v2.ConfigReadResponse>(
        method,
        params,
      );
      return this.localCatalog.sourceConfig(response) as T;
    }
    if (this.localAgents)
      return this.localAgents.request<T>(this.getClient(), method, params);
    return this.getClient().request<T>(method, params);
  }
}
