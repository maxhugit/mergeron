import { describe, expect, it } from 'vitest';
import { INTERNAL_MCP_TOOLS, internalMcpCatalog } from './internal-mcp-catalog';
import {
  INTERNAL_MCP_IDENTITIES,
  internalMcpAnnotations,
  internalMcpTransportApprovals,
  normalizeInternalMcpRequest,
  resolveInternalMcpTool,
  validateInternalMcpIdentities,
} from './internal-mcp-tools';

describe('internal MCP public names and stable execution identities', () => {
  it('gives every schema exactly one canonical definition and localized title', () => {
    expect(INTERNAL_MCP_TOOLS).toHaveLength(21);
    expect(INTERNAL_MCP_TOOLS.map((t) => t.operation)).toEqual(
      INTERNAL_MCP_IDENTITIES.map((t) => t.operation),
    );
    expect(new Set(INTERNAL_MCP_TOOLS.map((t) => t.name)).size).toBe(21);
    for (const tool of INTERNAL_MCP_TOOLS) {
      expect(tool.titleFr).toContain(' — ');
      expect(tool.title).toContain(' — ');
      expect(tool.readOnly).toBe(tool.policy.readOnly);
    }
    for (const tool of internalMcpCatalog().tools)
      expect(tool.annotations).toEqual(
        internalMcpAnnotations(resolveInternalMcpTool(tool.name)!),
      );
  });

  it.each(INTERNAL_MCP_IDENTITIES)(
    'resolves $operation and $name to the same handler and policy',
    (tool) => {
      expect(resolveInternalMcpTool(tool.name)).toBe(tool);
      expect(resolveInternalMcpTool(tool.operation)).toBe(tool);
      expect(tool.aliases).toEqual(
        tool.name === tool.operation ? [] : [tool.operation],
      );
      const args = { requestId: 'unchanged', value: 'untrusted page text' };
      const request = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: tool.operation, arguments: args },
      };
      const normalized = normalizeInternalMcpRequest(request);
      expect(normalized).toEqual({
        ...request,
        params: { ...request.params, name: tool.name },
      });
      expect((normalized as typeof request).params.arguments).toBe(args);
      expect(request.params.name).toBe(tool.operation);
    },
  );

  it('leaves unknown names, malformed requests and other methods to SDK validation', () => {
    for (const request of [
      null,
      [],
      { method: 'tools/call', params: [] },
      { method: 'tools/call', params: { name: 3 } },
      { method: 'tools/list', params: { name: 'get_project' } },
      ...['Get_Project', 'get_project ', 'delete_task', '__proto__'].map(
        (name) => ({ method: 'tools/call', params: { name } }),
      ),
    ])
      expect(normalizeInternalMcpRequest(request)).toBe(request);
  });

  it('rejects nonstandard names and alias collisions instead of silently shadowing', () => {
    const first = INTERNAL_MCP_IDENTITIES[0];
    expect(() =>
      validateInternalMcpIdentities([{ ...first, name: 'list_monitors' }]),
    ).toThrow('Invalid internal MCP tool definition');
    expect(() =>
      validateInternalMcpIdentities([{ ...first, aliases: [first.name] }]),
    ).toThrow('duplicate');
    expect(() =>
      validateInternalMcpIdentities([
        first,
        { ...INTERNAL_MCP_IDENTITIES[1], aliases: [first.name] },
      ]),
    ).toThrow('duplicate');
  });

  it('preserves security hints and filesystem exceptions independently of names', () => {
    for (const tool of INTERNAL_MCP_IDENTITIES) {
      const operation = tool.operation;
      expect(tool.policy.destructive).toBe(
        ['prepare_project_git', 'local_browser_action'].includes(operation),
      );
      expect(tool.policy.idempotent).toBe(operation !== 'local_browser_action');
      expect(tool.policy.openWorld).toBe(
        [
          'local_browser_read',
          'local_browser_action',
          'read_project_git',
          'prepare_project_git',
          'publish_project_git',
          'create_project_git_copy',
        ].includes(operation),
      );
      expect(tool.policy.requiresWorkspaceWrite).toBe(
        !tool.readOnly &&
          ![
            'rename_agent',
            'agent_monitor_manage',
            'agent_monitor_report',
          ].includes(operation),
      );
      expect(tool.policy.administratorOnly).toBe(tool.handler !== 'project');
      expect(tool.policy.forbidImpersonation).toBe(tool.handler !== 'project');
    }
    expect(internalMcpTransportApprovals()).toEqual({
      agent_monitor_manage: { approval_mode: 'approve' },
      agent_monitor_report: { approval_mode: 'approve' },
      project_git_publish: { approval_mode: 'approve' },
      publish_project_git: { approval_mode: 'approve' },
    });
  });
});
