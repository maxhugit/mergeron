import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INTERNAL_MCP_TOOLS } from './internal-mcp-catalog';
import { prepareProjectGitOperationInput } from '../projects/project-connection-tools.schema';
it('advertises both reviewed restore operations to native agents without arbitrary reset or missing confirmations', async () => {
  const definition = INTERNAL_MCP_TOOLS.find(
    (tool) => tool.name === 'project_git_local_manage',
  )!;
  const server = new McpServer({ name: 'test-restore', version: '1' });
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
        operation: 'restore_files',
        data: {},
        untrustedContent: true,
      },
    }),
  );
  const client = new Client({ name: 'restore-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools[0].inputSchema.properties?.operation).toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric schema matcher.
      enum: expect.arrayContaining([
        'restore_files_review',
        'restore_files',
        'restore_github_review',
        'restore_github',
      ]),
    });
    expect(tools[0].annotations?.readOnlyHint).toBe(false);
    const args = {
      connectionId: 'git',
      copyId: 'copy',
      operation: 'restore_files',
      requestId: 'restore-1',
      userRequest: 'Discard my selected local edit.',
      expectedHead: 'a'.repeat(40),
      expectedBranch: 'work',
      fingerprint: 'b'.repeat(64),
      paths: ['README.md'],
      reviewFingerprint: 'c'.repeat(64),
      confirmation: 'RESTORE_LOCAL_FILES',
    };
    expect(prepareProjectGitOperationInput.safeParse(args).success).toBe(true);
    expect(
      prepareProjectGitOperationInput.safeParse({ ...args, operation: 'reset' })
        .success,
    ).toBe(false);
    expect(
      prepareProjectGitOperationInput.safeParse({
        ...args,
        confirmation: undefined,
      }).success,
    ).toBe(false);
    expect(
      prepareProjectGitOperationInput.safeParse({ ...args, shell: 'anything' })
        .success,
    ).toBe(false);
    expect(
      (await client.callTool({ name: definition.name, arguments: args }))
        .isError,
    ).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
it('advertises retargeting and its remote preconditions to native MCP clients', async () => {
  const definition = INTERNAL_MCP_TOOLS.find(
    (tool) => tool.name === 'project_git_publish',
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
        enum: [
          'push',
          'create_pull_request',
          'retarget_pull_request',
          'update_pull_request',
        ],
      },
      number: { type: 'integer' },
      base: { type: 'string' },
      expectedBase: { type: 'string' },
      expectedPullRequestHead: { type: 'string' },
      expectedUpdatedAt: { type: 'string', format: 'date-time' },
    });
    expect(tools[0].annotations?.readOnlyHint).toBe(false);
  } finally {
    await client.close();
    await server.close();
  }
});
