import { expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Subject } from 'rxjs';
import { io } from '../../web/node_modules/socket.io-client/build/cjs/index.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../database/database.testing';
import { DRIZZLE_DB } from '../database/database.constants';
import {
  people,
  projects,
  projectParticipants,
  projectAgentThreads,
} from '../database/schema';
import { ThreadsGateway } from '../threads/threads.gateway';
import { FilesGateway } from '../files/files.gateway';
import {
  FileWatchCoordinatorService,
  FileWatchChange,
} from '../files/file-watch-coordinator.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { IdentityService } from './identity.service';
import { AuthService } from './auth.service';
import { identityEvents } from './identity-events';

interface TestSocket {
  id?: string;
  connected: boolean;
  on(event: string, listener: (value: unknown) => void): void;
  once(event: string, listener: () => void): void;
  off(event: string, listener: () => void): void;
  timeout(ms: number): {
    emit(
      event: string,
      payload: unknown,
      callback: (error: Error | null, value: { ok: boolean }) => void,
    ): void;
  };
  disconnect(): void;
}

function request(
  socket: TestSocket,
  event: string,
  payload: unknown,
): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const onException = () => resolve({ ok: false });
    socket.once('exception', onException);
    socket
      .timeout(1500)
      .emit(event, payload, (error: Error | null, value: { ok: boolean }) => {
        socket.off('exception', onException);
        if (error) reject(error);
        else resolve(value);
      });
  });
}

it('isolates live thread and filesystem data and revokes already-connected participants', async () => {
  vi.stubEnv('WEBUI_REQUIRE_IDENTITY', 'true');
  const database = createTestDatabase();
  const directory = mkdtempSync(join(tmpdir(), 'socket-isolation-'));
  const changes = new Subject<void>();
  const requests = new Subject<unknown>();
  const failures = new Subject<unknown>();
  const resolved = new Subject<unknown>();
  const listeners = new Map<string, (value: unknown) => void>();
  let watch: ((change: FileWatchChange) => void) | undefined;
  const releaseSocket = vi.fn().mockResolvedValue(undefined);
  for (const id of ['alice', 'bob', 'admin'])
    database.db
      .insert(people)
      .values({
        id,
        reference: id,
        name: id,
        identitySubject: id,
        email: `${id}@example.com`,
        role: id === 'admin' ? 'administrator' : 'standard',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  for (const id of ['a', 'b']) {
    const path = join(directory, id);
    mkdirSync(path);
    database.db
      .insert(projects)
      .values({ id, name: id, workspacePath: path, createdAt: 1, updatedAt: 1 })
      .run();
    database.db
      .insert(projectParticipants)
      .values({
        projectId: id,
        personId: id === 'a' ? 'alice' : 'bob',
        createdAt: 1,
      })
      .run();
    database.db
      .insert(projectAgentThreads)
      .values({
        threadId: id,
        projectId: id,
        workspacePath: path,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  }
  const module = await Test.createTestingModule({
    imports: [JwtModule.register({})],
    providers: [
      ThreadsGateway,
      FilesGateway,
      IdentityService,
      AuthService,
      {
        provide: ConfigService,
        useValue: new ConfigService({ WEBUI_API_KEY: 'socket-isolation-test' }),
      },
      { provide: DRIZZLE_DB, useValue: database.db },
      {
        provide: CodexProcessManager,
        useValue: {
          getGeneration: () => 1,
          getClient: () => ({}),
          addListener: (event: string, listener: (value: unknown) => void) =>
            listeners.set(event, listener),
        },
      },
      { provide: ThreadMetadataService, useValue: { changes } },
      { provide: ConversationBranchesService, useValue: { changes } },
      { provide: ConversationBranchMutationsService, useValue: { changes } },
      {
        provide: PendingApprovalsService,
        useValue: { changes, requests, failures, resolvedRequests: resolved },
      },
      {
        provide: ThreadDeletionRegistryService,
        useValue: { onRelease: () => () => undefined, isDeleting: () => false },
      },
      {
        provide: FileWatchCoordinatorService,
        useValue: {
          subscribe: (listener: typeof watch) => {
            watch = listener;
            return () => undefined;
          },
          acquire: () => Promise.resolve({ ok: true }),
          releaseSocket,
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication(new FastifyAdapter(), {
    logger: false,
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen(0, '127.0.0.1');
  // Use the actual ephemeral test listener, never a configured deployment URL.
  const url = `${await app.getUrl()}/ws`;
  const actual = ['alice', 'bob', 'admin'].map((id) => {
    const options = {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: {
        authorization: 'Bearer socket-isolation-test',
        'x-webui-auth-source': 'authentik',
        'x-webui-auth-subject': id,
        'x-webui-auth-email': `${id}@example.com`,
      },
    };
    return io(url, options) as unknown as TestSocket;
  });
  const notifications = actual.map(() => [] as unknown[]);
  const fileEvents = actual.map(() => [] as unknown[]);
  actual.forEach((socket, index) => {
    socket.on('codex.notification', (n) => notifications[index].push(n));
    socket.on('fs.changed', (n) => fileEvents[index].push(n));
  });
  try {
    await expect.poll(() => actual.every((s) => s.connected)).toBe(true);
    expect(
      (await request(actual[0], 'thread.subscribe', { threadId: 'a' })).ok,
    ).toBe(true);
    expect(
      (await request(actual[1], 'thread.subscribe', { threadId: 'a' })).ok,
    ).toBe(false);
    expect(
      (await request(actual[2], 'thread.subscribe', { threadId: 'a' })).ok,
    ).toBe(true);
    expect(
      (
        await request(actual[0], 'fs.watch.acquire', {
          path: join(directory, 'a'),
          leaseId: 'own',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await request(actual[1], 'fs.watch.acquire', {
          path: join(directory, 'a'),
          leaseId: 'foreign',
        })
      ).ok,
    ).toBe(false);
    listeners.get('notification')!({
      method: 'item/agentMessage/delta',
      params: { threadId: 'a', itemId: 'i', delta: 'private text' },
    });
    await expect
      .poll(() => notifications.map((n) => n.length))
      .toEqual([1, 0, 1]);
    watch!({
      watchPath: join(directory, 'a'),
      changedPaths: [join(directory, 'a', 'file.txt')],
      socketIds: actual.map((s) => s.id!),
    });
    await expect.poll(() => fileEvents.map((n) => n.length)).toEqual([1, 0, 1]);
    database.db
      .delete(projectParticipants)
      .where(eq(projectParticipants.personId, 'alice'))
      .run();
    // Revocation is enforced even before a stale room subscription is removed.
    listeners.get('notification')!({
      method: 'item/agentMessage/delta',
      params: { threadId: 'a', itemId: 'i', delta: 'after removal' },
    });
    await expect.poll(() => notifications[2].length).toBe(2);
    expect(notifications[0]).toHaveLength(1);
    const revoked = vi.fn();
    actual[0].on('access.revoked', revoked);
    identityEvents.emit('changed', 'alice');
    await expect.poll(() => actual[0].connected).toBe(false);
    expect(revoked).toHaveBeenCalledOnce();
    await expect.poll(() => releaseSocket.mock.calls.length).toBeGreaterThan(0);
  } finally {
    actual.forEach((socket) => socket.disconnect());
    await app.close();
    database.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 15000);
