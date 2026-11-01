import type { CodexService } from '../codex/codex.service';
import type { AppDatabase } from '../database/database.constants';
import { ProjectConnectionPolicyService } from './project-connection-policy.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import type { InternalMcpService } from '../internal-mcp/internal-mcp.service';
function databaseReturning(...rows: unknown[]): AppDatabase {
  let index = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ get: vi.fn(() => rows[index++]) })),
        all: vi.fn(() => []),
      })),
    })),
  } as unknown as AppDatabase;
}
describe('ProjectConnectionPolicyService', () => {
  function setup(
    appIds: string[] = [],
    mcpServerIds: string[] = [],
    internalMcp?: InternalMcpService,
  ) {
    const request = vi.fn((method: string) =>
      Promise.resolve(
        method === 'config/read'
          ? {
              config: {
                apps: { github: { enabled: true } },
                mcp_servers: {
                  fixture: {
                    command: 'node',
                    args: ['fixture.js'],
                    tool_timeout_sec: null,
                    startup_timeout_sec: null,
                  },
                  disabled: { command: 'node', enabled: false },
                },
                plugins: {
                  google: {
                    enabled: true,
                    mcp_servers: { drive: { tool_timeout_sec: null } },
                  },
                },
              },
            }
          : method === 'app/list'
            ? {
                data: [
                  { id: 'gmail', isAccessible: true, isEnabled: true },
                  { id: 'blocked', isAccessible: false, isEnabled: true },
                ],
                nextCursor: null,
              }
            : {
                data: [
                  { name: 'fixture', pluginId: null },
                  { name: 'codex_apps', pluginId: null },
                  { name: 'drive', pluginId: 'google' },
                ],
                nextCursor: null,
              },
      ),
    );
    const service = new ProjectConnectionPolicyService(
      { request } as unknown as CodexService,
      databaseReturning({
        appIds,
        mcpServerIds,
        agentModel: 'model',
        agentReasoningEffort: 'high',
      }),
      {
        executionLocationForCwd: () => ({
          projectId: 'p',
          locationId: 'local:w',
          workspaceId: 'w',
          readOnly: false,
          sourceResourceId: null,
          sourceRevision: null,
        }),
      } as unknown as ActiveFoldersService,
      internalMcp,
    );
    return { service, request };
  }
  it('omits absent optional MCP fields before sending TOML-compatible overrides', async () => {
    const { service } = setup([], ['fixture']);
    const config = await service.configForCwd('/workspaces/project');
    expect(config?.mcp_servers).toMatchObject({
      fixture: { enabled: true, command: 'node' },
    });
    expect(
      (config?.mcp_servers as Record<string, unknown>).fixture,
    ).not.toHaveProperty('tool_timeout_sec');
    expect(
      (config?.mcp_servers as Record<string, unknown>).fixture,
    ).not.toHaveProperty('startup_timeout_sec');
    expect(config?.plugins).toMatchObject({
      google: { mcp_servers: { drive: { enabled: false } } },
    });
    expect(JSON.stringify(config)).not.toContain('tool_timeout_sec');
  });
  it('explicitly disables global MCP servers, plugin servers and per-app enables for an empty selection', async () => {
    const { service, request } = setup();
    await expect(service.configForCwd('/workspaces/project')).resolves.toEqual({
      default_permissions: expect.stringMatching(
        /^mergeron_copy_/,
      ) as unknown as string,
      permissions: expect.any(Object) as unknown as Record<string, unknown>,
      features: { apps: false },
      apps: { _default: { enabled: false }, github: { enabled: false } },
      mcp_servers: {
        fixture: { command: 'node', args: ['fixture.js'], enabled: false },
        disabled: { command: 'node', enabled: false },
      },
      plugins: {
        google: { enabled: true, mcp_servers: { drive: { enabled: false } } },
      },
    });
    expect(request.mock.calls.some(([method]) => method === 'app/list')).toBe(
      false,
    );
  });
  it('allows only selected accessible apps and configured MCP transports', async () => {
    const { service } = setup(
      ['gmail', 'blocked'],
      ['fixture', 'disabled', 'drive', 'codex_apps'],
    );
    const policy = await service.policyForCwd('/workspaces/project');
    expect(policy).toMatchObject({
      model: 'model',
      reasoningEffort: 'high',
      config: {
        apps: {
          _default: { enabled: false },
          github: { enabled: false },
          gmail: { enabled: true },
          blocked: { enabled: false },
        },
        mcp_servers: {
          fixture: { command: 'node', args: ['fixture.js'], enabled: true },
          disabled: { enabled: false },
        },
        plugins: {
          google: { enabled: true, mcp_servers: { drive: { enabled: true } } },
        },
      },
    });
    expect(policy?.config.features).toBeUndefined();
    expect(policy?.config.mcp_servers).not.toHaveProperty('codex_apps');
  });
  it('fails closed when native inventory cannot be read', async () => {
    const { service, request } = setup();
    request.mockRejectedValue(new Error('unavailable'));
    await expect(service.configForCwd('/workspaces/project')).rejects.toThrow(
      'unavailable',
    );
  });
  it('adds the native internal connection without enabling external integrations', async () => {
    const connection = vi.fn().mockResolvedValue({
      id: 'connection-1',
      config: { url: 'http://127.0.0.1:1234/mcp', enabled: true },
    });
    const bind = vi.fn();
    const { service } = setup([], [], {
      connection,
      bind,
    } as unknown as InternalMcpService);
    const policy = await service.policyForCwd(
      '/workspaces/project',
      'p',
      'thread-1',
    );
    expect(connection).toHaveBeenCalledWith('p', 'thread-1');
    expect(policy).toMatchObject({
      internalMcpId: 'connection-1',
      config: {
        features: { apps: false },
        mcp_servers: {
          mergeron_internal: {
            url: 'http://127.0.0.1:1234/mcp',
            enabled: true,
          },
          fixture: { enabled: false },
        },
      },
    });
  });
  it('does not alter projectless execution', async () => {
    const request = vi.fn();
    const service = new ProjectConnectionPolicyService(
      { request } as unknown as CodexService,
      databaseReturning(undefined),
      {
        executionLocationForCwd: () => null,
      } as unknown as ActiveFoldersService,
    );
    await expect(service.configForCwd('/tmp')).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it('refuses a bound conversation cwd outside its project instead of inheriting global tools', async () => {
    const service = new ProjectConnectionPolicyService(
      { request: vi.fn() } as unknown as CodexService,
      databaseReturning(
        { projectId: 'p', workspacePath: '/workspaces/p' },
        undefined,
      ),
      {
        executionLocationForCwd: () => null,
      } as unknown as ActiveFoldersService,
    );
    await expect(service.policyForThread('thread', '/tmp')).rejects.toThrow(
      'ne correspond pas',
    );
  });
});
