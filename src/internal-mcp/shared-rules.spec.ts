import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  INTERNAL_MCP_INSTRUCTIONS,
  INTERNAL_MCP_RULES_REVISION,
  INTERNAL_MCP_TOOLS,
  internalMcpCatalog,
} from './internal-mcp-catalog';
it('delivers revisioned common rules once during MCP initialization', async () => {
  const server = new McpServer(
    { name: 'rules-test', version: '1' },
    { instructions: INTERNAL_MCP_INSTRUCTIONS },
  );
  const client = new Client({ name: 'rules-reader', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    expect(client.getInstructions()).toContain(
      `Common rules revision ${INTERNAL_MCP_RULES_REVISION}`,
    );
    expect(internalMcpCatalog().instructionsRevision).toBe(
      INTERNAL_MCP_RULES_REVISION,
    );
    for (const name of [
      'project_connection_manage',
      'project_git_read',
      'project_git_publish',
    ]) {
      const tool = INTERNAL_MCP_TOOLS.find((t) => t.name === name)!;
      expect(tool.description).not.toContain('Common rules revision');
      expect(tool.description).not.toContain('requestId must remain identical');
    }
    expect(INTERNAL_MCP_INSTRUCTIONS).toContain(
      'Tool-specific destructive confirmations and backup requirements remain mandatory',
    );
  } finally {
    await client.close();
    await server.close();
  }
});
