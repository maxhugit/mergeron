import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INTERNAL_MCP_TOOLS } from './internal-mcp-catalog';
it('advertises retargeting and its remote preconditions to native MCP clients', async () => {
  const definition = INTERNAL_MCP_TOOLS.find(
    (tool) => tool.name === 'publish_project_git',
  )!;
  const server = new McpServer({ name: 'test-git', version: '1' });
  server.registerTool(
    definition.name,
    {
      inputSchema: definition.input,
      outputSchema: definition.output,
      annotations: { readOnlyHint: definition.readOnly },
    },
    () => ({
      content: [],
      structuredContent: {
        connectionId: 'git',
        operation: 'retarget_pull_request',
        data: {},
      },
    }),
  );
  const client = new Client({ name: 'test-client', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools[0].inputSchema.properties).toMatchObject({
      operation: {
        enum: ['push', 'create_pull_request', 'retarget_pull_request'],
      },
      number: { type: 'integer' },
      base: { type: 'string' },
      expectedBase: { type: 'string' },
      expectedPullRequestHead: { type: 'string' },
    });
    expect(tools[0].annotations?.readOnlyHint).toBe(false);
  } finally {
    await client.close();
    await server.close();
  }
});
