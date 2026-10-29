/** In-memory context wiring only: no native engine, SQLite or external account. */
import { afterEach, expect, it, vi } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import type { AppDatabase } from '../database/database.constants';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';
import type { DeliverablesService } from '../deliverables/deliverables.service';
import { accessContext } from '../auth/access-context';
import { projects, projectAgentThreads } from '../database/schema';
import { ProjectAgentToolsService } from './project-agent-tools.service';

vi.mock('../deliverables/deliverables.service', () => ({
  DeliverablesService: class {},
}));
vi.mock('../projects/project-connection-tools.schema', () => ({
  projectConnectionTools: [],
}));
afterEach(() => vi.clearAllMocks());

function previewContext(context: string) {
  return (
    JSON.parse(context.split('\n')[2]) as {
      previewEnvironment: {
        available: boolean;
        preview: { state: string } | null;
      };
    }
  ).previewEnvironment;
}

function setup() {
  const state = {
    projectId: 'project',
    bound: true,
    allowed: true,
    name: 'Project',
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          get: () =>
            table === projectAgentThreads
              ? state.bound
                ? { projectId: state.projectId }
                : undefined
              : table === projects
                ? { id: state.projectId, name: state.name }
                : undefined,
          orderBy: () => ({ all: () => [] }),
        }),
      }),
    }),
  };
  const discovery = vi.fn().mockResolvedValue({
    state: 'not_configured',
    available: false,
    missingConfiguration: ['server_disabled'],
    preview: null,
  });
  const tool = vi.fn().mockResolvedValue({ state: 'prepared' });
  const service = new ProjectAgentToolsService(
    db as unknown as AppDatabase,
    { agentCatalog: () => [] } as unknown as DeliverablesService,
    { get: () => ({ discovery, tool }) } as unknown as ModuleRef,
  );
  const identities = {
    requireActive: () => {
      if (!state.allowed) throw new Error('access denied');
    },
    requireThread: () => {
      if (!state.allowed) throw new Error('access denied');
    },
    requireProject: () => {
      if (!state.allowed) throw new Error('access denied');
    },
  } as unknown as IdentityService;
  const identity = {
    kind: 'person',
    personId: 'user',
    active: true,
    role: 'administrator',
  } as PlatformIdentity;
  const run = <T>(fn: () => T) =>
    accessContext.run({ identity, identities }, fn);
  return { state, service, discovery, tool, run };
}

it('routes recipe preparation to the server-bound project and agent, with the live lease check', async () => {
  const f = setup();
  const input = {
    tool: 'project_preview_prepare',
    requestId: 'prepare',
    policyRevision: 'observed',
    expectedRevision: null,
    recipe: { runtime: 'node', start: 'npm run dev', port: 3000 },
  };
  const active = vi.fn();
  await expect(
    f.run(() => f.service.execute('existing-agent', input, active)),
  ).resolves.toEqual({ state: 'prepared' });
  expect(f.tool).toHaveBeenCalledWith(
    'project',
    'existing-agent',
    input,
    active,
  );
  expect(active).toHaveBeenCalled();
});

it('injects an awaited live preview snapshot for every existing/new-agent turn', async () => {
  const f = setup();
  const first = (await f.run(() =>
    f.service.context('existing-agent', '/workspaces/source'),
  ))!;
  expect(previewContext(first).available).toBe(false);
  f.discovery.mockResolvedValue({
    state: 'available',
    available: true,
    missingConfiguration: [],
    preview: { state: 'running', url: 'https://instance.preview.example.org/' },
  });
  for (const thread of ['existing-agent', 'new-agent']) {
    const context = (await f.run(() => f.service.context(thread)))!;
    expect(previewContext(context).preview?.state).toBe('running');
    expect(context).toContain('not authorization');
    expect(context).toContain('project_preview_read');
    expect(f.discovery).toHaveBeenLastCalledWith('project', thread);
  }
  expect(f.discovery).toHaveBeenCalledTimes(3);
});

it('does not stop an unrelated conversation when preview discovery fails', async () => {
  const f = setup();
  f.discovery.mockRejectedValue(new Error('PRIVATE_DIAGNOSTIC'));
  const context = (await f.run(() => f.service.context('agent')))!;
  expect(previewContext(context)).toMatchObject({
    state: 'unavailable',
    available: false,
    missingConfiguration: ['preview_discovery_unavailable'],
  });
  expect(context).not.toContain('PRIVATE_DIAGNOSTIC');
});

it('rejects a project rebind during discovery rather than leaking the old snapshot', async () => {
  const f = setup();
  f.discovery.mockImplementation(() => {
    f.state.projectId = 'other-project';
    return Promise.resolve({
      state: 'available',
      privateProjectData: 'must not escape',
    });
  });
  await expect(f.run(() => f.service.context('agent'))).rejects.toThrow(
    'Project changed',
  );
});

it('rechecks access after asynchronous discovery, and skips unbound conversations', async () => {
  const f = setup();
  f.state.bound = false;
  expect(await f.service.context('unbound')).toBeNull();
  expect(f.discovery).not.toHaveBeenCalled();
  f.state.bound = true;
  f.discovery.mockImplementation(() => {
    f.state.allowed = false;
    return Promise.resolve({});
  });
  await expect(f.run(() => f.service.context('agent'))).rejects.toThrow(
    'access denied',
  );
});
