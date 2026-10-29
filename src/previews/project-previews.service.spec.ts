import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { accessContext } from '../auth/access-context';
import type { AppDatabase } from '../database/database.constants';
import {
  projects,
  projectAgentThreads,
  projectPreviewProfiles,
  agentPreviews,
  agentPreviewRecipes,
} from '../database/schema';
import type { ActiveFoldersService } from '../active-folders/active-folders.service';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';
import { ProjectPreviewsService } from './project-previews.service';
import type { PreviewManagerClient } from './preview-manager-client';
import { PreviewGateway } from '../../runtime/preview-gateway.cjs';
import fs from 'node:fs/promises';
vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(() => Promise.resolve()),
    realpath: vi.fn((target: string) => Promise.resolve(target)),
    unlink: vi.fn(() => Promise.resolve()),
    rmdir: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('./preview-snapshot', () => ({
  previewSnapshot: vi.fn(() => Promise.resolve({ sha256: 'a'.repeat(64) })),
  previewSourceFingerprint: vi.fn(() => Promise.resolve('fingerprint')),
}));
vi.mock('../auth/identity.service', () => ({ IdentityService: class {} }));
vi.mock('../active-folders/active-folders.service', () => ({
  ActiveFoldersService: class {},
}));
vi.mock('../projects/git-copy-ownership', () => ({
  workAgentId: (_db: unknown, thread: string) => thread,
}));

function setup(role: 'administrator' | 'standard' = 'administrator') {
  const identity: PlatformIdentity = {
    kind: 'person',
    personId: 'user',
    name: 'Test',
    role,
    active: true,
  };
  const rows = new Map<unknown, Record<string, unknown>>([
    [projects, { id: 'p' }],
    [
      projectAgentThreads,
      { projectId: 'p', threadId: 't', workspacePath: '/workspaces/source' },
    ],
  ]);
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          get: () => rows.get(table),
          all: () => [rows.get(table)].filter(Boolean),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({ run: () => rows.set(table, row) }),
      }),
    }),
    update: (table: unknown) => ({
      set: (row: Record<string, unknown>) => ({
        where: () => ({
          run: () => rows.set(table, { ...rows.get(table), ...row }),
        }),
      }),
    }),
  };
  const identities = {
    current: (i: PlatformIdentity) => i,
    requireProject: (i: PlatformIdentity, id: string) => {
      if (!i.active || id !== 'p') throw new ForbiddenException();
    },
    requireThread: (i: PlatformIdentity, id: string) => {
      if (!i.active || id !== 't') throw new ForbiddenException();
    },
    requireActive: (i: PlatformIdentity) => {
      if (!i.active) throw new ForbiddenException();
    },
    requireAdministrator: (i: PlatformIdentity) => {
      if (!i.active || i.role !== 'administrator')
        throw new ForbiddenException();
    },
    requireWorkspacePath: (source: string) => {
      if (!source.startsWith('/workspaces/')) throw new ForbiddenException();
    },
  } as unknown as IdentityService;
  const request = vi.fn(
    (
      ...args: [string, Record<string, unknown>?]
    ): Promise<Record<string, unknown>> => {
      void args;
      return Promise.resolve({
        enabled: true,
        domain: 'preview.example.org',
        runtimes: [{ id: 'node' }],
      });
    },
  );
  const config = new ConfigService({
    WEBUI_CONNECTION_SECRET_KEY: 'isolated-test-encryption-key',
    MERGERON_PREVIEW_DOMAIN: 'preview.example.org',
    MERGERON_PREVIEWS_ENABLED: 'false',
  });
  const service = new ProjectPreviewsService(
    db as unknown as AppDatabase,
    config,
    { resolveAgent: () => null } as unknown as ActiveFoldersService,
    { request } as unknown as PreviewManagerClient,
    identities,
  );
  const run = <T>(fn: () => T) =>
    accessContext.run({ identity, identities }, fn);
  return { service, rows, identity, run, request, config };
}
describe('project-scoped generic preview service', () => {
  function configured(role: 'administrator' | 'standard' = 'administrator') {
    const f = setup(role);
    f.identity.role = 'administrator';
    f.run(() =>
      f.service.saveSettings('p', {
        expectedRevision: null,
        profile: {
          enabled: true,
          start: 'PRIVATE_START_COMMAND',
          env: { TEST_SECRET: 'PRIVATE_ENV_VALUE' },
        },
      }),
    );
    f.identity.role = role;
    f.config.set('MERGERON_PREVIEWS_ENABLED', 'true');
    Object.assign(f.service, { gateway: { server: { listening: true } } });
    return f;
  }
  function delegated() {
    const f = configured();
    f.run(() =>
      f.service.saveSettings('p', {
        expectedRevision: f.rows.get(projectPreviewProfiles)?.revision,
        profile: {
          enabled: true,
          agentManaged: true,
          agentRuntimes: ['node'],
          memoryMb: 256,
          cpus: 1,
          lifetimeMinutes: 15,
          env: { PRIVATE_KEY: 'MANUAL_SECRET_NOT_INHERITED' },
        },
      }),
    );
    const input = {
      tool: 'project_preview_prepare',
      requestId: 'prepare-01',
      policyRevision: f.rows.get(projectPreviewProfiles)!.revision,
      expectedRevision: null,
      recipe: {
        runtime: 'node',
        start: 'npm run dev',
        port: 3000,
        env: { MODE: 'test' },
      },
    };
    return { ...f, input };
  }
  it('prepares a private per-agent recipe, with idempotency and optimistic revisions', async () => {
    const f = delegated();
    const result = await f.run(() =>
      f.service.tool('p', 't', f.input, () => {}),
    );
    expect(result).toMatchObject({ state: 'prepared', reused: false });
    const stored = f.rows.get(agentPreviewRecipes)!;
    expect(stored.agentId).toBe('t');
    expect(stored.encryptedRecipe).not.toContain('npm run dev');
    expect(stored.encryptedRecipe).not.toContain('MODE');
    expect(
      await f.run(() => f.service.tool('p', 't', f.input, () => {})),
    ).toMatchObject({
      state: 'prepared',
      reused: true,
      recipeRevision: stored.revision,
    });
    await expect(
      f.run(() =>
        f.service.tool(
          'p',
          't',
          { ...f.input, recipe: { ...f.input.recipe, port: 4000 } },
          () => {},
        ),
      ),
    ).rejects.toThrow('PREVIEW_REQUEST_CONFLICT');
    await expect(
      f.run(() =>
        f.service.tool(
          'p',
          't',
          {
            ...f.input,
            requestId: 'prepare-02',
            recipe: { ...f.input.recipe, port: 4000 },
          },
          () => {},
        ),
      ),
    ).rejects.toThrow('PREVIEW_CONFIGURATION_CHANGED');
    expect(f.request.mock.calls.every(([op]) => op === 'capabilities')).toBe(
      true,
    );
    expect(f.service['effectiveProfile']('p', 't').profile.env).toEqual({
      MODE: 'test',
    });
    expect(() =>
      f.service['decryptValue'](
        String(stored.encryptedRecipe),
        JSON.stringify(['agent', 'p', 'other-agent']),
      ),
    ).toThrow();
    const discovery = await f.run(() => f.service.discovery('p', 't'));
    expect(discovery.preparation).toMatchObject({
      projectAuthorized: true,
      required: false,
      recipeRevision: stored.revision,
    });
    expect(discovery.management.requiresExplicitHumanRequest).toBe(false);
  });
  it('does not let an agent authorize itself, inject infrastructure or exceed approved runtimes', async () => {
    const f = delegated();
    for (const extra of [
      { enabled: true },
      { memoryMb: 4096 },
      { image: 'private' },
      { url: 'https://example.org' },
      { env: { PRIVATE_KEY: '[stored]' } },
    ])
      await expect(
        f.run(() =>
          f.service.tool(
            'p',
            't',
            { ...f.input, recipe: { ...f.input.recipe, ...extra } },
            () => {},
          ),
        ),
      ).rejects.toThrow('PREVIEW_INVALID_CONFIGURATION');
    await expect(
      f.run(() =>
        f.service.tool(
          'p',
          't',
          { ...f.input, recipe: { ...f.input.recipe, runtime: 'python' } },
          () => {},
        ),
      ),
    ).rejects.toThrow('PREVIEW_RUNTIME_NOT_ALLOWED');
    f.identity.role = 'standard';
    await expect(
      f.run(() => f.service.tool('p', 't', f.input, () => {})),
    ).rejects.toThrow();
    f.identity.role = 'administrator';
    f.run(() =>
      f.service.saveSettings('p', {
        expectedRevision: f.rows.get(projectPreviewProfiles)!.revision,
        profile: { enabled: true },
      }),
    );
    await expect(
      f.run(() => f.service.tool('p', 't', f.input, () => {})),
    ).rejects.toThrow('PREVIEW_AGENT_NOT_AUTHORIZED');
    expect(f.rows.has(agentPreviewRecipes)).toBe(false);
  });
  it('rechecks policy and active turn after asynchronous preparation and does not overwrite an active recipe', async () => {
    const f = delegated();
    let checks = 0;
    await expect(
      f.run(() =>
        f.service.tool('p', 't', f.input, () => {
          if (++checks >= 3) throw Error('REVOKED_TURN');
        }),
      ),
    ).rejects.toThrow('REVOKED_TURN');
    expect(f.rows.has(agentPreviewRecipes)).toBe(false);
    f.request.mockImplementation(() => {
      f.rows.set(projectPreviewProfiles, {
        ...f.rows.get(projectPreviewProfiles)!,
        revision: 'changed',
      });
      return Promise.resolve({
        enabled: true,
        domain: 'preview.example.org',
        runtimes: [{ id: 'node' }],
      });
    });
    await expect(
      f.run(() => f.service.tool('p', 't', f.input, () => {})),
    ).rejects.toThrow('PREVIEW_CONFIGURATION_CHANGED');
    expect(f.rows.has(agentPreviewRecipes)).toBe(false);
    const active = delegated();
    active.rows.set(agentPreviews, {
      agentId: 't',
      projectId: 'p',
      state: 'running',
    });
    await expect(
      active.run(() => active.service.tool('p', 't', active.input, () => {})),
    ).rejects.toThrow('PREVIEW_STOP_BEFORE_PREPARE');
  });
  it('starts the prepared recipe under project caps, reports HTTP readiness, and honors policy revocation', async () => {
    const f = delegated();
    await f.run(() => f.service.tool('p', 't', f.input, () => {}));
    let live: Record<string, unknown> = {};
    let ready = false;
    f.request.mockImplementation((op, input) => {
      if (op === 'capabilities')
        return Promise.resolve({
          enabled: true,
          domain: 'preview.example.org',
          runtimes: [{ id: 'node' }],
        });
      if (op === 'start') {
        live = {
          projectId: 'p',
          agentId: 't',
          runId: input!.runId,
          state: 'running',
        };
        expect(input!.profile).toMatchObject({
          memoryMb: 256,
          cpus: 1,
          lifetimeMinutes: 15,
          env: { MODE: 'test' },
          start: 'npm run dev',
        });
        expect(JSON.stringify(input!.profile)).not.toContain('MANUAL_SECRET');
      }
      return Promise.resolve({
        ...live,
        ready,
        httpStatus: ready ? 200 : 503,
        url: `https://${String(live.runId)}.preview.example.org/`,
      });
    });
    const pending = await f.run(() =>
      f.service.tool(
        'p',
        't',
        {
          tool: 'project_preview_manage',
          operation: 'start',
          requestId: 'start-01',
        },
        () => {},
      ),
    );
    expect(pending).toMatchObject({
      preview: { state: 'running', ready: false, url: null },
    });
    expect(fs.mkdir).toHaveBeenCalled(); // Mocked snapshot FS; no actual /workspaces write.
    ready = true;
    const running = await f.run(() =>
      f.service.tool(
        'p',
        't',
        { tool: 'project_preview_read', operation: 'status' },
        () => {},
      ),
    );
    expect(running).toMatchObject({
      preview: {
        ready: true,
        url: `https://${String(live.runId)}.preview.example.org/`,
      },
    });
    f.run(() =>
      f.service.saveSettings('p', {
        expectedRevision: f.rows.get(projectPreviewProfiles)!.revision,
        profile: { enabled: false, agentManaged: true },
      }),
    );
    await expect(
      f.run(() => f.service.start('p', 't', 'start-02')),
    ).rejects.toThrow('PREVIEW_CONFIGURATION_CHANGED');
    await expect(f.run(() => f.service.synchronize('p', 't'))).rejects.toThrow(
      'PREVIEW_CONFIGURATION_CHANGED',
    );
  });
  it('refuses execution if the role is revoked while capabilities are being checked', async () => {
    const f = delegated();
    await f.run(() => f.service.tool('p', 't', f.input, () => {}));
    f.request.mockImplementation(() => {
      f.identity.role = 'standard';
      return Promise.resolve({
        enabled: true,
        domain: 'preview.example.org',
        runtimes: [{ id: 'node' }],
      });
    });
    await expect(
      f.run(() => f.service.start('p', 't', 'start-01')),
    ).rejects.toThrow();
    expect(f.request.mock.calls.some(([op]) => op === 'start')).toBe(false);
  });

  it('distinguishes missing configuration from an absent instance without launching', async () => {
    const f = setup();
    const result = await f.run(() => f.service.discovery('p', 't'));
    expect(result.available).toBe(false);
    expect(result.preview).toBeNull();
    expect(result.missingConfiguration).toEqual(
      expect.arrayContaining(['server_disabled', 'project_profile_missing']),
    );
    expect(f.request).toHaveBeenCalledExactlyOnceWith('capabilities', {}, 1500);
  });

  it('advertises a configured environment before its first launch without leaking its recipe', async () => {
    const f = configured();
    const result = await f.run(() =>
      f.service.tool('p', 't', { operation: 'status' }, () => {}),
    );
    expect(result).toMatchObject({
      state: 'available',
      available: true,
      projectConfigured: true,
      projectEnabled: true,
      runtime: 'node',
      updateMode: 'hot',
      preview: null,
      missingConfiguration: [],
      management: {
        identityAllowed: true,
        requiresExplicitHumanRequest: true,
        requiresWritableTurn: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_START_COMMAND|PRIVATE_ENV_VALUE|encryptedProfile/,
    );
    expect(
      f.request.mock.calls.every(([operation]) => operation === 'capabilities'),
    ).toBe(true);
    f.config.set('MERGERON_PREVIEWS_ENABLED', 'false');
    expect(
      (await f.run(() => f.service.discovery('p', 't'))).missingConfiguration,
    ).toContain('server_disabled');
  });

  it('checks domain, viewer and approved runtime instead of trusting tool presence', async () => {
    const f = configured();
    Object.assign(f.service, { gateway: undefined });
    f.request.mockResolvedValue({
      enabled: true,
      domain: 'other.example.org',
      runtimes: [],
    });
    const result = await f.run(() => f.service.discovery('p', 't'));
    expect(result.available).toBe(false);
    expect(result.missingConfiguration).toEqual(
      expect.arrayContaining([
        'viewer_not_ready',
        'preview_domain_mismatch',
        'runtime_not_allowed',
      ]),
    );
  });

  it('reports disabled project, missing start command, disallowed services and protected sources', async () => {
    const f = configured();
    f.run(() =>
      f.service.saveSettings('p', {
        expectedRevision: f.rows.get(projectPreviewProfiles)?.revision,
        profile: {
          enabled: false,
          services: [
            {
              name: 'database',
              runtime: 'postgres',
              command: 'PRIVATE_SERVICE_COMMAND',
            },
          ],
        },
      }),
    );
    f.rows.set(projectAgentThreads, {
      projectId: 'p',
      threadId: 't',
      workspacePath: '/workspaces/.mergeron-system/p',
    });
    const result = await f.run(() => f.service.discovery('p', 't'));
    expect(result.missingConfiguration).toEqual(
      expect.arrayContaining([
        'project_disabled',
        'start_command_missing',
        'service_runtime_not_allowed',
        'working_directory_protected',
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SERVICE_COMMAND');
  });

  it('keeps an unavailable Manager distinct from an environment ready to use', async () => {
    const f = configured();
    f.request.mockRejectedValue(new Error('PRIVATE_MANAGER_DIAGNOSTIC'));
    const result = await f.run(() => f.service.discovery('p', 't'));
    expect(result).toMatchObject({
      state: 'unavailable',
      available: false,
      preview: null,
    });
    expect(result.missingConfiguration).toContain('manager_unavailable');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MANAGER_DIAGNOSTIC');
  });

  it('does not confuse configuration availability with the caller’s execution permission', async () => {
    const f = configured('standard');
    const result = await f.run(() => f.service.discovery('p', 't'));
    expect(result.available).toBe(true);
    expect(result.management.identityAllowed).toBe(false);
    expect(result.management.requiresWritableTurn).toBe(true);
    expect(
      f.request.mock.calls.every(([operation]) => operation === 'capabilities'),
    ).toBe(true);
  });

  it('includes only a scoped public URL and bounded instance metadata, never grants or transport', async () => {
    const f = configured();
    const previewId = '11111111-1111-4111-8111-111111111111';
    const runId = '22222222-2222-4222-8222-222222222222';
    f.rows.set(agentPreviews, {
      agentId: 't',
      threadId: 't',
      projectId: 'p',
      previewId,
      runId,
      state: 'running',
      sourcePath: '/private/source',
      createdAt: 1,
      updatedAt: 1,
      profileRevision: f.rows.get(projectPreviewProfiles)!.revision,
    });
    let url = `https://${runId}.preview.example.org/`;
    f.request.mockImplementation((operation) =>
      Promise.resolve(
        operation === 'capabilities'
          ? {
              enabled: true,
              domain: 'preview.example.org',
              runtimes: [{ id: 'node', image: 'PRIVATE_IMAGE_VALUE' }],
            }
          : {
              projectId: 'p',
              agentId: 't',
              runId,
              state: 'running',
              ready: true,
              httpStatus: 200,
              url,
              endpoint: 'PRIVATE_ENDPOINT',
              token: 'PRIVATE_TOKEN',
              expiresAt: 12345,
            },
      ),
    );
    const result = await f.run(() => f.service.discovery('p', 't'));
    expect(result.preview).toMatchObject({
      state: 'running',
      url,
      expiresAt: 12345,
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private\/source/);
    url += '?token=PRIVATE_GRANT';
    expect(
      (await f.run(() => f.service.discovery('p', 't'))).preview?.url,
    ).toBeNull();
    url = 'https://foreign.example.org/';
    expect(
      (await f.run(() => f.service.discovery('p', 't'))).preview?.url,
    ).toBeNull();
  });

  it('rechecks access after asynchronous capability discovery', async () => {
    const f = configured();
    f.request.mockImplementation(() => {
      f.identity.active = false;
      return Promise.resolve({
        enabled: true,
        domain: 'preview.example.org',
        runtimes: [{ id: 'node' }],
      });
    });
    await expect(f.run(() => f.service.discovery('p', 't'))).rejects.toThrow();
  });
  it('denies missing request identity and cross-project or cross-agent access', async () => {
    const f = setup();
    await expect(f.service.settings('p')).rejects.toThrow();
    await expect(f.run(() => f.service.settings('other'))).rejects.toThrow();
    await expect(f.run(() => f.service.status('p', 'other'))).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('encrypts project test configuration, redacts values and preserves stored placeholders', async () => {
    const f = setup();
    const saved = f.run(() =>
      f.service.saveSettings('p', {
        expectedRevision: null,
        profile: { env: { TEST_PASSWORD: 'private-test-value' } },
      }),
    );
    expect(f.rows.get(projectPreviewProfiles)?.encryptedProfile).not.toContain(
      'private-test-value',
    );
    expect(saved.profile.env.TEST_PASSWORD).toBe('[stored]');
    const second = f.run(() =>
      f.service.saveSettings('p', {
        expectedRevision: saved.revision,
        profile: { env: { TEST_PASSWORD: '[stored]' } },
      }),
    );
    expect(second.profile.env.TEST_PASSWORD).toBe('[stored]');
    expect(() =>
      f.run(() =>
        f.service.saveSettings('p', {
          expectedRevision: saved.revision,
          profile: {},
        }),
      ),
    ).toThrow('PREVIEW_CONFIGURATION_CHANGED');
    expect(
      (await f.run(() => f.service.settings('p'))).profile.env.TEST_PASSWORD,
    ).toBe('[stored]');
  });
  it('refuses cross-project ciphertext substitution and unapproved Docker configuration', () => {
    const f = setup();
    f.run(() =>
      f.service.saveSettings('p', {
        expectedRevision: null,
        profile: { env: { TEST_SECRET: 'test' } },
      }),
    );
    const encrypted = String(
      f.rows.get(projectPreviewProfiles)?.encryptedProfile,
    );
    expect(() => f.service['decrypt'](encrypted, 'other')).toThrow();
    expect(() =>
      f.run(() =>
        f.service.saveSettings('p', {
          expectedRevision: f.rows.get(projectPreviewProfiles)?.revision,
          profile: { privileged: true },
        }),
      ),
    ).toThrow('PREVIEW_INVALID_CONFIGURATION');
  });
  it('standard project members cannot change recipes or launch processes', async () => {
    const f = setup('standard');
    expect(() =>
      f.run(() =>
        f.service.saveSettings('p', { expectedRevision: null, profile: {} }),
      ),
    ).toThrow();
    await expect(
      f.run(() => f.service.start('p', 't', 'request')),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('does not start an unconfigured gateway or grant arbitrary tool operations', async () => {
    const f = setup();
    await expect(
      f.run(() => f.service.start('p', 't', 'request')),
    ).rejects.toThrow('PREVIEW_NOT_CONFIGURED');
    await expect(
      f.run(() =>
        f.service.tool(
          'p',
          't',
          { operation: 'start', image: 'unsafe' },
          () => {},
        ),
      ),
    ).rejects.toThrow('PREVIEW_INVALID_REQUEST');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('allows scoped viewing but never returns transport secrets from status', async () => {
    const f = setup('standard'),
      previewId = '11111111-1111-4111-8111-111111111111',
      runId = '22222222-2222-4222-8222-222222222222';
    f.identity.role = 'administrator';
    f.run(() =>
      f.service.saveSettings('p', {
        expectedRevision: null,
        profile: { enabled: true, start: 'npm run dev' },
      }),
    );
    f.identity.role = 'standard';
    f.rows.set(agentPreviews, {
      agentId: 't',
      threadId: 't',
      projectId: 'p',
      previewId,
      runId,
      state: 'running',
      sourcePath: '/workspaces/source',
      createdAt: 1,
      updatedAt: 1,
      profileRevision: f.rows.get(projectPreviewProfiles)!.revision,
    });
    f.request.mockImplementation(() =>
      Promise.resolve({
        projectId: 'p',
        agentId: 't',
        runId,
        state: 'running',
        ready: true,
        url: 'https://' + runId + '.preview.example.org/',
        endpoint: 'http://pv-' + runId.replaceAll('-', '') + '-relay:8180',
        token: 'a'.repeat(64),
        publicHost: runId + '.preview.example.org',
        expiresAt: Date.now() + 60000,
      }),
    );
    const status = await f.run(() => f.service.status('p', 't'));
    expect(JSON.stringify(status)).not.toContain('endpoint');
    expect(JSON.stringify(status)).not.toContain('a'.repeat(64));
    const gateway = new PreviewGateway({
      domain: 'preview.example.org',
      authorize: (g) => f.service['authorizePreview'](g),
    });
    Object.assign(f.service, { gateway });
    const opened = await f.run(() => f.service.open('p', 't'));
    expect(opened.url).toContain('https://' + runId + '.preview.example.org/');
    f.identity.active = false;
    await expect(f.run(() => f.service.open('p', 't'))).rejects.toThrow();
    await gateway.close();
  });
});
