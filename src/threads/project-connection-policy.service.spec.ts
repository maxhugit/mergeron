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
  it('builds deny-by-default app and MCP overrides for the owning project', async () => {
    const request = vi.fn((method: string) => {
      if (method === 'app/list') {
        return Promise.resolve({
          data: [
            { id: 'gmail', isAccessible: true, isEnabled: true },
            { id: 'github', isAccessible: true, isEnabled: true },
          ],
          nextCursor: null,
        });
      }
      return Promise.resolve({
        data: [
          { name: 'example_server', pluginId: null, authStatus: 'oAuth' },
          { name: 'drive', pluginId: 'google', authStatus: 'unsupported' },
        ],
        nextCursor: null,
      });
    });
    const service = new ProjectConnectionPolicyService(
      { request } as unknown as CodexService,
      databaseReturning(
        { projectId: 'project-1' },
        {
          appIds: ['gmail'],
          mcpServerIds: ['example_server'],
          agentModel: 'gpt-project',
          agentReasoningEffort: 'high',
        },
      ),
    );

    await expect(service.configForCwd('/workspaces/mail')).resolves.toEqual({
      apps: {
        _default: { enabled: false },
        gmail: { enabled: true },
        github: { enabled: false },
      },
      mcp_servers: { example_server: { enabled: true } },
      plugins: {
        google: { mcp_servers: { drive: { enabled: false } } },
      },
    });
  });

  it('does not emit the built-in connector catalog as an MCP transport', async () => {
    const request = vi.fn((method: string) =>
      Promise.resolve({
        data:
          method === 'app/list'
            ? []
            : [
                {
                  name: 'codex_apps',
                  pluginId: null,
                  authStatus: 'unsupported',
                },
              ],
        nextCursor: null,
      }),
    );
    const service = new ProjectConnectionPolicyService(
      { request } as unknown as CodexService,
      databaseReturning(
        { projectId: 'project-1' },
        {
          appIds: [],
          mcpServerIds: ['codex_apps'],
          agentModel: null,
          agentReasoningEffort: null,
        },
      ),
    );

    await expect(service.configForCwd('/workspaces/mail')).resolves.toEqual({
      apps: { _default: { enabled: false } },
      mcp_servers: {},
      plugins: {},
    });
    expect(request).not.toHaveBeenCalledWith('app/list', expect.anything());
    expect(request).toHaveBeenCalledWith('mcpServerStatus/list', {
      limit: 100,
      cursor: undefined,
      detail: 'toolsAndAuthOnly',
    });
  });

  it('does not query connector catalogs when the project selects none', async () => {
    const request = vi.fn();
    const service = new ProjectConnectionPolicyService(
      { request } as unknown as CodexService,
      databaseReturning(
        { projectId: 'project-1' },
        {
          appIds: [],
          mcpServerIds: [],
          agentModel: null,
          agentReasoningEffort: null,
        },
      ),
    );

    await expect(service.configForCwd('/workspaces/mail')).resolves.toEqual({
      apps: { _default: { enabled: false } },
      mcp_servers: {},
      plugins: {},
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns the project model and reasoning effort with the connection policy', async () => {
    const service = new ProjectConnectionPolicyService(
      {
        request: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
      } as unknown as CodexService,
      databaseReturning(
        { projectId: 'project-1' },
        {
          appIds: [],
          mcpServerIds: [],
          agentModel: 'gpt-project',
          agentReasoningEffort: 'xhigh',
        },
      ),
    );

    await expect(
      service.policyForCwd('/workspaces/mail'),
    ).resolves.toMatchObject({
      projectId: 'project-1',
      model: 'gpt-project',
      reasoningEffort: 'xhigh',
    });
  });

  it('does not add overrides outside a project workspace', async () => {
    const request = vi.fn();
    const service = new ProjectConnectionPolicyService(
      { request } as unknown as CodexService,
      databaseReturning(undefined),
    );

    await expect(service.configForCwd('/tmp')).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
