import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import {
  people,
  projects,
  projectAgentThreads,
  projectParticipants,
} from '../database/schema';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { accessContext } from '../auth/access-context';
import { OnlyOfficeAssistantService } from './onlyoffice-assistant.service';

let database: TestDatabase,
  root: string,
  identities: IdentityService,
  service: OnlyOfficeAssistantService;
let path: string;
let metadata: { read: ReturnType<typeof vi.fn> };
let threads: { runProjectStructuredPrompt: ReturnType<typeof vi.fn> };
let editable = true;
const identity = (id = 'admin'): PlatformIdentity => ({
  kind: 'person',
  personId: id,
  name: id,
  role: id === 'admin' ? 'administrator' : 'standard',
  active: true,
});
const as = <T>(id: string, action: () => T) =>
  accessContext.run({ identity: identity(id), identities }, action);
const body = (extra = {}) => ({
  threadId: 'a',
  action: 'insertText',
  instruction: 'Write an introduction',
  context: 'Existing document',
  selection: '',
  requestId: 'test-request-0001',
  ...extra,
});
beforeEach(() => {
  database = createTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'office-assistant-'));
  editable = true;
  const now = Date.now();
  for (const id of ['admin', 'member', 'other'])
    database.db
      .insert(people)
      .values({
        id,
        reference: id,
        name: id,
        role: id === 'admin' ? 'administrator' : 'standard',
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  for (const id of ['p', 'q']) {
    const workspacePath = join(root, id);
    mkdirSync(workspacePath);
    database.db
      .insert(projects)
      .values({ id, name: id, workspacePath, createdAt: now, updatedAt: now })
      .run();
  }
  path = join(root, 'p', 'report.docx');
  writeFileSync(path, 'fixture');
  database.db
    .insert(projectParticipants)
    .values({ projectId: 'p', personId: 'member', createdAt: now })
    .run();
  for (const [id, projectId, archivedAt] of [
    ['a', 'p', null],
    ['b', 'q', null],
    ['archived', 'p', now],
  ] as const)
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: id,
        projectId,
        workspacePath: join(root, projectId),
        archivedAt,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  identities = new IdentityService(database.db);
  metadata = {
    read: vi.fn().mockResolvedValue({
      entries: ['a', 'b', 'archived'].map((id) => ({
        archived: id === 'archived',
        thread: { id, name: 'Agent ' + id },
      })),
    }),
  };
  threads = {
    runProjectStructuredPrompt: vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ text: 'New introduction', title: '' }),
      ),
  };
  service = new OnlyOfficeAssistantService(
    database.db,
    identities,
    { getMetadata: vi.fn().mockResolvedValue({ path }) } as never,
    { onlyOfficeAccess: () => ({ editable }) } as never,
    metadata as never,
    { listTurns: vi.fn().mockResolvedValue({ data: [] }) } as never,
    threads as never,
  );
});
afterEach(() => {
  database.sqlite.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

it('binds an editor session to the project and excludes other-project and archived agents', async () => {
  await as('admin', async () => {
    const grant = service.create(path, 'word')!;
    expect((await service.context(grant.sessionId)).agents).toEqual([
      { id: 'a', name: 'Agent a' },
    ]);
    await expect(
      service.propose(grant.sessionId, body({ threadId: 'b' })),
    ).rejects.toThrow('outside');
    await expect(
      service.propose(grant.sessionId, body({ threadId: 'archived' })),
    ).rejects.toThrow('outside');
  });
  expect(threads.runProjectStructuredPrompt).not.toHaveBeenCalled();
});
it('refuses stolen sessions, membership revocation and expired document sessions', async () => {
  const grant = as('member', () => service.create(path, 'word'))!;
  await as('other', () =>
    expect(service.context(grant.sessionId)).rejects.toThrow(),
  );
  database.db
    .delete(projectParticipants)
    .where(eq(projectParticipants.personId, 'member'))
    .run();
  await as('member', () =>
    expect(service.context(grant.sessionId)).rejects.toThrow(),
  );
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
  await as('admin', () =>
    expect(service.context(grant.sessionId)).rejects.toThrow(),
  );
});
it('keeps execution restricted to administrators and rechecks document editability', async () => {
  const grant = as('member', () => service.create(path, 'word'))!;
  await as('member', async () => {
    expect((await service.context(grant.sessionId)).canRun).toBe(false);
    await expect(service.propose(grant.sessionId, body())).rejects.toThrow(
      'Administrator',
    );
  });
  editable = false;
  await as('member', () =>
    expect(service.context(grant.sessionId)).rejects.toThrow('editing access'),
  );
});
it('uses isolated project planning, deduplicates sends and revalidates agent membership before application', async () => {
  await as('admin', async () => {
    const grant = service.create(path, 'word')!;
    const first = await service.propose(grant.sessionId, body());
    expect((await service.propose(grant.sessionId, body())).id).toBe(first.id);
    await vi.waitFor(() =>
      expect(threads.runProjectStructuredPrompt).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(async () =>
      expect(await service.read(grant.sessionId, first.id)).toMatchObject({
        status: 'ready',
        text: 'New introduction',
      }),
    );
    expect(threads.runProjectStructuredPrompt.mock.calls[0][0]).toMatchObject({
      cwd: join(root, 'p'),
    });
    expect(
      (
        threads.runProjectStructuredPrompt.mock.calls[0][0] as {
          prompt: string;
        }
      ).prompt,
    ).toContain('Agent a');
    database.db
      .update(projectAgentThreads)
      .set({ projectId: 'q' })
      .where(eq(projectAgentThreads.threadId, 'a'))
      .run();
    await expect(service.read(grant.sessionId, first.id)).rejects.toThrow(
      'outside',
    );
  });
});
it('refuses cross-document proposal reads, unsupported operations and unsafe output', async () => {
  await as('admin', async () => {
    const a = service.create(path, 'word')!,
      b = service.create(path, 'word')!;
    await expect(
      service.propose(a.sessionId, body({ action: 'addSlide' })),
    ).rejects.toThrow();
    await expect(
      service.propose(a.sessionId, body({ action: 'replaceSelection' })),
    ).rejects.toThrow();
    threads.runProjectStructuredPrompt.mockResolvedValue(
      'private upstream error /secret/token',
    );
    const result = await service.propose(a.sessionId, body());
    await vi.waitFor(async () =>
      expect(await service.read(a.sessionId, result.id)).toMatchObject({
        status: 'failed',
      }),
    );
    await expect(service.read(b.sessionId, result.id)).rejects.toThrow(
      'unavailable',
    );
    expect(
      JSON.stringify(await service.read(a.sessionId, result.id)),
    ).not.toContain('secret');
  });
});
it('does not enable the plugin in spreadsheets or unowned paths', () => {
  as('admin', () => {
    expect(service.create(path, 'cell')).toBeUndefined();
    expect(service.create(join(root, 'unowned.docx'), 'word')).toBeUndefined();
  });
});
