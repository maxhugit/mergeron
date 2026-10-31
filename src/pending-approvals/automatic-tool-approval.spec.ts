/** Real request ownership, persistence and transport: no remote tools are called. */
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../database/database.testing';
import { pendingServerRequests } from '../database/schema';
import { ThreadExecutionPreferencesService } from '../threads/thread-execution-preferences.service';
import { boundedApprovalPolicy } from '../threads/agent-approval-policy';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { PendingApprovalsService } from './pending-approvals.service';
import { createRequestManager } from './request-owner.testing';
import { executionTurn } from '../threads/thread-execution.testing';
import {
  permissionApprovalFixture,
  fileApprovalFixture,
} from './pending-approvals.testing';

const request = (id = 1, threadId = 'a', turnId = 'turn') => ({
  id,
  method: 'mcpServer/elicitation/request',
  params: {
    threadId,
    turnId,
    serverName: 'mergeron_internal',
    mode: 'form',
    message: 'Allow tool?',
    _meta: { codex_approval_kind: 'mcp_tool_call' },
    requestedSchema: { type: 'object', properties: {} },
  },
});

function fixture() {
  const db = createTestDatabase();
  const transport = createRequestManager();
  const preferences = new ThreadExecutionPreferencesService(db.db);
  const deletion = new ThreadDeletionRegistryService();
  const catalog = new CatalogAdmissionService();
  const service = new PendingApprovalsService(
    db.db,
    transport.manager,
    deletion,
    catalog,
    preferences,
  );
  service.onModuleInit();
  const select = (mode: 'automatic' | 'manual') => {
    const native = boundedApprovalPolicy('on-request');
    preferences
      .beginSecurity(
        'a',
        { approvalPolicy: 'on-request', approvalMode: mode },
        '/cwd',
        {
          observed: true,
          source: 'notification',
          approvalPolicy: native,
          sandboxPolicy: null,
          approvalsReviewer: null,
        },
        { approvalPolicy: native },
      )
      .accept();
  };
  const start = (threadId = 'a', id = 'turn') =>
    transport.notify({
      method: 'turn/started',
      params: { threadId, turn: executionTurn(id) },
    });
  return {
    ...db,
    transport,
    preferences,
    deletion,
    catalog,
    service,
    select,
    start,
    close() {
      transport.close();
      db.sqlite.close();
    },
  };
}

it('automatically accepts only the selected agent turn and persists attribution before sending, once', () => {
  const f = fixture();
  try {
    f.select('automatic');
    f.start();
    const admitted = vi.fn();
    f.service.requests.subscribe(admitted);
    const owned = f.transport.receive(request())!;
    expect(f.transport.wire).toHaveBeenCalledExactlyOnceWith({
      id: 1,
      result: { action: 'accept', content: {}, _meta: null },
    });
    expect(
      f.db
        .select()
        .from(pendingServerRequests)
        .where(eq(pendingServerRequests.instanceId, owned.instanceId))
        .get(),
    ).toMatchObject({
      status: 'submitted',
      resolvedBy: 'automatic:agent-policy',
    });
    expect(admitted).not.toHaveBeenCalled();
    f.transport.receive(request());
    expect(f.transport.wire).toHaveBeenCalledTimes(1);
    f.start('b');
    f.transport.receive(request(2, 'b'));
    f.transport.receive(request(3, 'a', 'old-turn'));
    expect(f.transport.wire).toHaveBeenCalledTimes(1);
    expect(f.service.listPending().map((row) => row.requestId)).toEqual([
      '2',
      '3',
    ]);
  } finally {
    f.close();
  }
});

it('captures consent for the next turn, not retroactively, and does not recapture duplicate starts', () => {
  const f = fixture();
  try {
    f.start();
    f.select('automatic');
    f.start();
    f.transport.receive(request());
    expect(f.transport.wire).not.toHaveBeenCalled();
    f.start('a', 'next');
    f.select('manual');
    f.transport.receive(request(2, 'a', 'next'));
    expect(f.transport.wire).toHaveBeenCalledTimes(1);
    f.start('a', 'last');
    f.transport.receive(request(3, 'a', 'last'));
    expect(f.transport.wire).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
  }
});

it('never fabricates answers, sign-ins, unsupported forms, shell escalations or file permissions', () => {
  const f = fixture();
  try {
    f.select('automatic');
    f.start();
    for (const [index, patch] of [
      { _meta: null },
      { _meta: { codex_approval_kind: 'browser_auth' } },
      {
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          codex_requires_user_input: true,
        },
      },
      {
        requestedSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
      {
        requestedSchema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      },
      { mode: 'url', url: 'https://example.com/login', elicitationId: 'login' },
    ].entries())
      f.transport.receive({
        ...request(10 + index),
        params: { ...request().params, ...patch },
      });
    const permission = permissionApprovalFixture();
    f.transport.receive({
      ...permission,
      params: { ...permission.params, threadId: 'a', turnId: 'turn' },
    });
    const file = fileApprovalFixture().request;
    f.transport.receive({
      ...file,
      params: { ...file.params, threadId: 'a', turnId: 'turn' },
    });
    f.transport.receive({
      id: 41,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'a',
        turnId: 'turn',
        itemId: 'question',
        questions: [
          {
            id: 'name',
            header: 'Name',
            question: 'Which name?',
            isOther: false,
            isSecret: false,
            options: null,
          },
        ],
      },
    });
    expect(f.transport.wire).not.toHaveBeenCalled();
    expect(f.service.listPending()).toHaveLength(9);
  } finally {
    f.close();
  }
});

it('withholds automatic decisions during deletion and after turn completion', () => {
  const f = fixture();
  try {
    f.select('automatic');
    f.start();
    f.deletion.begin(['a']);
    f.transport.receive(request());
    f.deletion.end(['a']);
    f.transport.notify({
      method: 'turn/completed',
      params: { threadId: 'a', turn: executionTurn('turn', 'completed') },
    });
    f.transport.receive(request(2));
    expect(f.transport.wire).not.toHaveBeenCalled();
    expect(f.service.listPending()).toHaveLength(1);
    expect(
      f.db
        .select()
        .from(pendingServerRequests)
        .all()
        .map((row) => row.status),
    ).toEqual(['resolved', 'pending']);
  } finally {
    f.close();
  }
});

it('never retries an ambiguous automatic delivery or reuses approval authority after restart', () => {
  const f = fixture();
  try {
    f.select('automatic');
    f.start();
    f.transport.wire.mockImplementationOnce(() => {
      throw new Error('closed');
    });
    f.transport.receive(request());
    f.transport.receive(request());
    expect(f.transport.wire).toHaveBeenCalledTimes(1);
    expect(f.db.select().from(pendingServerRequests).get()).toMatchObject({
      status: 'failed',
      resolvedBy: 'automatic:agent-policy',
    });
    f.transport.restart();
    f.transport.receive(request());
    expect(f.transport.wire).toHaveBeenCalledTimes(1);
    expect(f.service.listPending()).toHaveLength(1);
  } finally {
    f.close();
  }
});
