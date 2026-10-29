import { describe, expect, it } from 'vitest';
import {
  agentEnvironmentCommand,
  AGENT_ENVIRONMENT_LAUNCHER,
} from './agent-environment';
import { documentIsolationArgs } from '../document-publication/document-isolation';

describe('agent cache launcher', () => {
  it('initializes caches inside the mount boundary, without changing CLI arguments', () => {
    const command = agentEnvironmentCommand(
      '/cli/codex',
      ['app-server', '--listen', 'stdio://'],
      true,
    );
    expect(command.binary).toBe(AGENT_ENVIRONMENT_LAUNCHER);
    expect(command.args).toEqual([
      '/cli/codex',
      'app-server',
      '--listen',
      'stdio://',
    ]);
    const args = documentIsolationArgs(
      {
        home: '/home/codex/.codex',
        databasePath: '/home/codex/.codex/db',
        writableRoots: ['/workspaces/p'],
        publishedRoots: ['/workspaces/p/livrables'],
        privateRoots: ['/workspaces/.mergeron-system'],
      },
      command.binary,
      command.args,
    );
    expect(args.slice(-6)).toEqual([
      '--',
      AGENT_ENVIRONMENT_LAUNCHER,
      '/cli/codex',
      'app-server',
      '--listen',
      'stdio://',
    ]);
    expect(args).toContain('--ro-bind');
    expect(args).toContain('--remount-ro');
    expect(args).toContain('/workspaces/p/livrables');
    expect(args.indexOf('/tmp')).toBeLessThan(
      args.indexOf(AGENT_ENVIRONMENT_LAUNCHER),
    );
    expect(args).not.toContain('--unshare-net');
  });

  it('preserves source-only local installations without the image launcher', () => {
    expect(agentEnvironmentCommand('codex', ['app-server'], false)).toEqual({
      binary: 'codex',
      args: ['app-server'],
    });
  });
});
