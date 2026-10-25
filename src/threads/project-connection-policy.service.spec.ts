import type { CodexService } from '../codex/codex.service';
import type { AppDatabase } from '../database/database.constants';
import { ProjectConnectionPolicyService } from './project-connection-policy.service';
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
  function setup(appIds: string[] = [], mcpServerIds: string[] = []) {
    const request = vi.fn((method: string) =>
      Promise.resolve(
        method === 'config/read'
          ? {
              config: {
                apps: { github: { enabled: true } },
                mcp_servers: {
                  fixture: { command: 'node', args: ['fixture.js'] },
                  disabled: { command: 'node', enabled: false },
                },
                plugins: {
                  google: { enabled: true, mcp_servers: { drive: {} } },
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
      databaseReturning(
        { projectId: 'p' },
        {
          appIds,
          mcpServerIds,
          agentModel: 'model',
          agentReasoningEffort: 'high',
        },
      ),
    );
    return { service, request };
  }
  it('explicitly disables global MCP servers, plugin servers and per-app enables for an empty selection', async () => {
    const { service, request } = setup();
    await expect(service.configForCwd('/workspaces/project')).resolves.toEqual({
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
  it('does not alter projectless execution', async () => {
    const request = vi.fn();
    const service = new ProjectConnectionPolicyService(
      { request } as unknown as CodexService,
      databaseReturning(undefined),
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
    );
    await expect(service.policyForThread('thread', '/tmp')).rejects.toThrow(
      'ne correspond pas',
    );
  });
});
