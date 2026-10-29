/** Account-free SDK negotiation, in memory: no native engine or external HTTP. */
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INTERNAL_MCP_TOOLS, internalMcpCatalog } from './internal-mcp-catalog';

it('advertises preview output schemas exactly as administration displays them', async () => {
  const server = new McpServer({ name: 'isolated-test', version: '1' });
  const client = new Client({ name: 'isolated-client', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  for (const tool of INTERNAL_MCP_TOOLS.filter((t) =>
    t.name.startsWith('project_preview_'),
  )) {
    server.registerTool(
      tool.name,
      { inputSchema: tool.input, outputSchema: tool.output },
      () =>
        Promise.resolve({
          content: [{ type: 'text', text: '{}' }],
          structuredContent: {},
        }),
    );
  }
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      const documented = internalMcpCatalog().tools.find(
        (t) => t.name === tool.name,
      )!;
      expect(tool.inputSchema).toEqual(documented.inputSchema);
      expect(tool.outputSchema).toEqual(documented.outputSchema);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
