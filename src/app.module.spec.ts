/**
 * Smoke test that the whole dependency graph resolves.
 *
 * Every other suite mocks its collaborators, so a provider that injects a token
 * its module never imports type-checks, passes unit tests, and only fails when
 * the process actually boots. Compiling AppModule here turns that into a test
 * failure instead of a startup crash.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
import { IdentityService } from './auth/identity.service';
import { CodexProcessManager } from './codex/codex-process-manager.service';
import { PendingApprovalsService } from './pending-approvals/pending-approvals.service';
import { ThreadsGateway } from './threads/threads.gateway';
import { createRequestManager } from './pending-approvals/request-owner.testing';
import { fileApprovalFixture } from './pending-approvals/pending-approvals.testing';

describe('AppModule', () => {
  // Compiling the real module constructs the real DatabaseService, which opens
  // and migrates whatever `WEBUI_DB_PATH` points at. Left unset it would run
  // migrations against the developer's own database.
  let dbDir: string;
  let previousDbPath: string | undefined;
  let previousApiKey: string | undefined;

  beforeAll(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'codex-webui-appmodule-'));
    previousDbPath = process.env.WEBUI_DB_PATH;
    process.env.WEBUI_DB_PATH = join(dbDir, 'test.sqlite');
    previousApiKey = process.env.WEBUI_API_KEY;
    process.env.WEBUI_API_KEY = 'test-only-module-graph-not-a-real-key';
  });

  afterAll(() => {
    if (previousDbPath === undefined) delete process.env.WEBUI_DB_PATH;
    else process.env.WEBUI_DB_PATH = previousDbPath;
    if (previousApiKey === undefined) delete process.env.WEBUI_API_KEY;
    else process.env.WEBUI_API_KEY = previousApiKey;
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('resolves every provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.close();
  });

  it('captures file subjects before the gateway observes their notification under Nest construction', async () => {
    const transport = createRequestManager();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CodexProcessManager)
      .useValue(transport.manager)
      .overrideProvider(AuthService)
      .useValue({ authenticateToken: async () => ({ ok: true }) })
      .overrideProvider(IdentityService)
      .useValue({
        resolve: () => ({ active: true, role: 'administrator' }),
        requireActive: () => undefined,
        requireThread: () => undefined,
        canReadThread: () => true,
      })
      .compile();
    try {
      const service = moduleRef.get(PendingApprovalsService);
      const gateway = moduleRef.get(ThreadsGateway);
      const fixture = fileApprovalFixture();
      const snapshots: unknown[] = [];
      service.onModuleInit();
      gateway.server = {
        to: () => ({
          emit: (event: string) => {
            if (event !== 'codex.notification') return;
            // Re-enter admission at the earliest observable delivery boundary.
            // If the service listener ran later, this card would have no subject.
            transport.receive(fixture.request);
            snapshots.push(service.listPending(['t1'])[0]?.reviewSubject);
          },
        }),
        emit: vi.fn(),
      } as unknown as ThreadsGateway['server'];
      gateway.afterInit();
      const socket = {
        id: 'canary-admin',
        handshake: { headers: {}, auth: { token: 'fixture' } },
        join: () => undefined,
        emit: () => undefined,
        disconnect: () => undefined,
      };
      await gateway.handleConnection(socket as never);
      gateway.handleSubscribe(socket as never, { threadId: 't1' });
      transport.notify(fixture.started);
      expect(snapshots).toEqual([
        { type: 'fileChange', changes: fixture.changes },
      ]);
    } finally {
      transport.close();
      await moduleRef.close();
    }
  });
});
