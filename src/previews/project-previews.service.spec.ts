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
} from '../database/schema';
import type { ActiveFoldersService } from '../active-folders/active-folders.service';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';
import { ProjectPreviewsService } from './project-previews.service';
import type { PreviewManagerClient } from './preview-manager-client';
import { PreviewGateway } from '../../runtime/preview-gateway.cjs';
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
  } as unknown as IdentityService;
  const request = vi.fn(
    (
      ...args: [string, Record<string, unknown>?]
    ): Promise<Record<string, unknown>> => {
      void args;
      return Promise.resolve({
        enabled: true,
        domain: 'preview.example.org',
        runtimes: [],
      });
    },
  );
  const config = new ConfigService({
    WEBUI_CONNECTION_SECRET_KEY: 'isolated-test-encryption-key',
    MERGERON_PREVIEW_DOMAIN: 'preview.example.org',
  });
  const service = new ProjectPreviewsService(
    db as unknown as AppDatabase,
    config,
    {} as ActiveFoldersService,
    { request } as unknown as PreviewManagerClient,
    identities,
  );
  const run = <T>(fn: () => T) =>
    accessContext.run({ identity, identities }, fn);
  return { service, rows, identity, run, request };
}
describe('project-scoped generic preview service', () => {
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
      f.service.saveSettings('p', { expectedRevision: null, profile: {} }),
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
    });
    f.request.mockImplementation(() =>
      Promise.resolve({
        projectId: 'p',
        agentId: 't',
        runId,
        state: 'running',
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
