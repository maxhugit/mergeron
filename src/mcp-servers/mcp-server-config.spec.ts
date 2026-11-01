import { mcpTransportConfig, validateMcpServerName } from './mcp-server-config';
import { McpServersService } from './mcp-servers.service';
import type { CodexService } from '../codex/codex.service';

describe('administrator MCP configuration', () => {
  it.each([
    'mergeron_internal',
    'codex_apps',
    'openai-tools',
    '../other',
    'x.y',
    '__proto__',
    'constructor',
    '',
  ])('rejects reserved or unsafe name %s', (name) => {
    // "constructor" is a legal slug but should not be accepted as a table identity.
    expect(() => validateMcpServerName(name)).toThrow();
  });
  it.each([
    'file:///tmp/server',
    'https://user:secret@example.com/mcp',
    'https://example.com/mcp?token=secret',
    'javascript:alert(1)',
  ])('rejects unsafe transport %s', (url) => {
    expect(() =>
      mcpTransportConfig({ name: 'custom', transport: 'http', url }),
    ).toThrow();
  });
  it('keeps arguments as an array without shell interpolation', () => {
    expect(
      mcpTransportConfig({
        name: 'custom',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
      }),
    ).toEqual({ command: 'node', args: ['server.js'] });
  });
  it('writes transport leaves with version checking and preserves unrelated config', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        config: {
          mcp_servers: { other: { url: 'https://other.example/mcp' } },
        },
        layers: [{ name: { type: 'user', profile: null }, version: 'v1' }],
      })
      .mockResolvedValue({});
    const service = new McpServersService({
      request,
    } as unknown as CodexService);
    expect(
      await service.configure({
        name: 'custom',
        transport: 'http',
        url: 'https://example.com/mcp',
      }),
    ).toEqual({ name: 'custom', saved: true, reloadRequired: true });
    expect(request).toHaveBeenLastCalledWith('config/batchWrite', {
      edits: [
        {
          keyPath: 'mcp_servers.custom.url',
          value: 'https://example.com/mcp',
          mergeStrategy: 'replace',
        },
      ],
      expectedVersion: 'v1',
      reloadUserConfig: true,
    });
    expect(
      request.mock.calls.some(
        ([method]) => method === 'config/mcpServer/reload',
      ),
    ).toBe(false);
  });
  it('refuses overwrites and changes of transport before writing', async () => {
    const request = vi.fn().mockResolvedValue({
      config: { mcp_servers: { custom: { url: 'https://example.com/mcp' } } },
      layers: [],
    });
    const service = new McpServersService({
      request,
    } as unknown as CodexService);
    await expect(
      service.configure({
        name: 'custom',
        transport: 'http',
        url: 'https://new.example/mcp',
      }),
    ).rejects.toThrow();
    await expect(
      service.configure({
        name: 'custom',
        transport: 'stdio',
        command: 'node',
        update: true,
      }),
    ).rejects.toThrow();
    expect(
      request.mock.calls.every(([method]) => method === 'config/read'),
    ).toBe(true);
  });
  it('does not reload or test an unregistered target', async () => {
    const request = vi.fn().mockResolvedValue({ config: {} });
    const service = new McpServersService({
      request,
    } as unknown as CodexService);
    await expect(service.check('custom')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
