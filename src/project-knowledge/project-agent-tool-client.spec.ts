import { describe, expect, it } from 'vitest';
import { projectToolCommand } from './project-agent-tool-client';

describe('authenticated project CLI ingress grammar', () => {
  const helper =
    '/workspaces/.mergeron-agent-drafts/p/thread/lease/mergeron-tools.py';
  const input = { requestId: 'read-1', tool: 'get_project' };
  const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
  it.each([helper, `"${helper}"`, `'${helper}'`])(
    'accepts only the exact scoped helper %s',
    (target) => {
      expect(
        projectToolCommand(`python3 ${target} --request ${encoded}`, helper),
      ).toEqual(input);
    },
  );
  it.each([
    `python3 ${helper} --request ${encoded}; echo ok`,
    `python3 ${helper} --request ${encoded}\ntrue`,
    `python3 ${helper} --request $(printf x)`,
    `python3 /other/mergeron-tools.py --request ${encoded}`,
    `env python3 ${helper} --request ${encoded}`,
    `python3 ${helper} --result read-1`,
    `python3 ${helper} --request ${Buffer.from('{"requestId":"../../x"}').toString('base64url')}`,
    `python3 ${helper} --request ${Buffer.from('not-json').toString('base64url')}`,
    `python3 ${helper} --request ${'x'.repeat(44000)}`,
  ])('rejects indirect, unbounded or compound calls', (command) => {
    expect(projectToolCommand(command, helper)).toBeNull();
  });
});
