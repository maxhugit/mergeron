import { expect, it } from 'vitest';
import { presentElicitation } from './elicitation-interaction';
import { presentMcpTool } from './mcp-tool-presentation';
const params = (extra = {}) => ({
  serverName: 'mergeron_internal',
  mode: 'form',
  message: 'Allow tool?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    tool_name: 'project_git_local_manage',
    tool_params: { operation: 'commit', message: 'Résumé', copyId: 'copy' },
    ...extra,
  },
});
it('preserves immutable tool arguments and supplies the internal catalogue titles', () => {
  const tool = presentElicitation(params()).tool!;
  expect(tool.name).toBe('project_git_local_manage');
  expect(tool.titleFr).toContain('Git');
  expect(JSON.parse(tool.argumentsJson!)).toEqual({
    operation: 'commit',
    message: 'Résumé',
    copyId: 'copy',
  });
  expect(presentElicitation(params()).fields).toEqual([]);
});
it('masks credential keys and URL credentials without changing operational arguments', () => {
  const tool = presentMcpTool(
    params({
      tool_params: {
        operation: 'commit',
        token: 'private',
        nested: { password: 'private' },
        url: 'https://user:pass@example.test/?token=private&branch=main',
      },
    }),
  )!;
  expect(tool.argumentsJson).not.toContain('private');
  expect(tool.argumentsJson).not.toContain('user:pass');
  expect(tool.argumentsJson).toContain('main');
});
it('keeps actual invocation arguments even when display metadata differs and never invents missing arguments', () => {
  expect(
    presentMcpTool(
      params({ tool_params_display: { operation: 'stage', paths: ['a.md'] } }),
    )?.argumentsJson,
  ).toContain('commit');
  expect(
    presentMcpTool(params({ tool_params_display: 'Display only' }))
      ?.argumentsJson,
  ).toContain('commit');
  expect(
    presentMcpTool(params({ tool_params: undefined }))?.argumentsJson,
  ).toBeNull();
  expect(
    presentMcpTool(params({ tool_params: { message: 'x'.repeat(40000) } }))
      ?.argumentsJson,
  ).toBeNull();
});
it('does not interpret arbitrary input requests as a tool authorization', () => {
  expect(
    presentMcpTool({
      ...params(),
      _meta: { tool_name: 'project_git_local_manage' },
    }),
  ).toBeUndefined();
  expect(
    presentMcpTool({ ...params(), serverName: 'other' })?.titleFr,
  ).toBeUndefined();
});
