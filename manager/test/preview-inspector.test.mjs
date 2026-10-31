import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { PreviewInspector } from '../src/preview-inspector.mjs';

function fixture() {
  const r = {
    runId: 'run',
    state: 'running',
    expiresAt: null,
    transportToken: 'transport-secret',
    objects: [
      { id: 'app-id', component: 'preview-app' },
      { id: 'relay-id', component: 'preview-relay' },
      { id: 'db-id', component: 'preview-database' },
    ],
  };
  const writes = [];
  let calls = 0;
  const manager = {
    ready: Promise.resolve(),
    records: new Map([['run', r]]),
    owned: async (id) => ({
      Config: {
        User: '11002:11002',
        Image: 'example@sha256:abc',
        Env: ['PASSWORD=test-secret'],
      },
      State: { Running: true, Status: 'running' },
    }),
    docker: {
      request: async () => ({
        memory_stats: { usage: 400, stats: { inactive_file: 100 } },
        cpu_stats: {
          cpu_usage: { total_usage: 50 },
          system_cpu_usage: 200,
          online_cpus: 2,
        },
        precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100 },
      }),
      containerLogs: async () =>
        '<script>test-secret transport-secret</script>',
      openTerminal: async () => {
        calls++;
        const stream = new PassThrough();
        stream.resize = async () => {};
        const write = stream.write.bind(stream);
        stream.write = (data) => {
          writes.push(data);
          return write(data);
        };
        return stream;
      },
    },
  };
  return {
    inspector: new PreviewInspector(manager),
    manager,
    r,
    writes,
    calls: () => calls,
  };
}
test('only journaled, label-checked containers are listed, no environment or Docker ids leak', async () => {
  const f = fixture();
  const list = await f.inspector.containers({ runId: 'run' });
  assert.equal(list.containers.length, 3);
  assert.equal(list.containers[0].cpuPercent, 80);
  assert.equal(list.containers[0].memoryBytes, 300);
  assert.equal(list.containers[1].terminalAvailable, false);
  assert.equal(list.containers[2].terminalAvailable, true);
  assert.ok(!JSON.stringify(list).includes('test-secret'));
  assert.ok(!JSON.stringify(list).includes('app-id'));
  await assert.rejects(
    f.inspector.logs({ runId: 'run', component: 'host' }),
    /CONTAINER_NOT_FOUND/,
  );
  const logs = await f.inspector.logs({
    runId: 'run',
    component: 'preview-app',
  });
  assert.equal(logs.text, '<script>[redacted] [redacted]</script>');
  assert.equal(logs.untrustedContent, true);
  f.manager.owned = async () => {
    throw Error('PREVIEW_OBJECT_CHANGED');
  };
  await assert.rejects(
    f.inspector.containers({ runId: 'run' }),
    /OBJECT_CHANGED/,
  );
});
test('PTY target, owner, run, bounds and sequence are enforced; duplicate input is not replayed', async () => {
  const f = fixture(),
    base = {
      runId: 'run',
      owner: 'person',
      component: 'preview-app',
      cols: 80,
      rows: 24,
    };
  await assert.rejects(
    f.inspector.terminal({
      ...base,
      component: 'preview-relay',
      action: 'open',
    }),
    /UNAVAILABLE/,
  );
  const { sessionId } = await f.inspector.terminal({ ...base, action: 'open' });
  try {
    const exchange = {
      ...base,
      sessionId,
      action: 'exchange',
      data: 'pwd\r',
      sequence: 1,
      offset: 0,
    };
    const first = await f.inspector.terminal(exchange);
    assert.equal(first.text, 'pwd\r');
    await f.inspector.terminal(exchange);
    assert.equal(f.writes.length, 1);
    await assert.rejects(
      f.inspector.terminal({ ...exchange, data: 'rm anything' }),
      /SEQUENCE/,
    );
    await assert.rejects(
      f.inspector.terminal({ ...exchange, owner: 'another' }),
      /EXPIRED/,
    );
    await assert.rejects(
      f.inspector.terminal({ ...exchange, cols: 5000 }),
      /INVALID_REQUEST/,
    );
    await assert.rejects(
      f.inspector.terminal({ ...exchange, data: 'x'.repeat(8193) }),
      /INVALID_REQUEST/,
    );
    f.r.state = 'stopped';
    await assert.rejects(f.inspector.terminal(exchange), /NOT_RUNNING/);
  } finally {
    f.inspector.closeRun('run');
  }
  assert.equal(f.inspector.sessions.size, 0);
});
test('opening cannot attach a session after the environment stops', async () => {
  const f = fixture();
  const original = f.manager.docker.openTerminal;
  f.manager.docker.openTerminal = async () => {
    const stream = await original();
    f.r.state = 'stopped';
    return stream;
  };
  await assert.rejects(
    f.inspector.terminal({
      runId: 'run',
      owner: 'person',
      component: 'preview-app',
      action: 'open',
      cols: 80,
      rows: 24,
    }),
    /NOT_RUNNING/,
  );
  assert.equal(f.inspector.sessions.size, 0);
});
test('missing metrics are null and root shells are refused', async () => {
  const f = fixture();
  f.manager.docker.request = async () => {
    throw Error();
  };
  f.manager.owned = async () => ({
    Config: { User: '0:0' },
    State: { Running: true },
  });
  const list = await f.inspector.containers({ runId: 'run' });
  assert.equal(list.containers[0].cpuPercent, null);
  assert.equal(list.containers[0].memoryBytes, null);
  await assert.rejects(
    f.inspector.terminal({
      runId: 'run',
      owner: 'person',
      component: 'preview-app',
      action: 'open',
      cols: 80,
      rows: 24,
    }),
    /UNAVAILABLE/,
  );
});
test('busy, expired and quota-limited runs cannot create extra terminals; output is bounded', async () => {
  const f = fixture();
  const base = {
    runId: 'run',
    owner: 'person',
    component: 'preview-app',
    action: 'open',
    cols: 80,
    rows: 24,
  };
  f.manager.busy = true;
  await assert.rejects(f.inspector.terminal(base), /BUSY/);
  f.manager.busy = false;
  f.r.expiresAt = Date.now() - 1;
  await assert.rejects(f.inspector.terminal(base), /NOT_RUNNING/);
  f.r.expiresAt = null;
  try {
    for (let index = 0; index < 8; index++)
      await f.inspector.terminal({ ...base, owner: 'person' + index });
    await assert.rejects(f.inspector.terminal(base), /LIMIT/);
    const session = [...f.inspector.sessions.values()][0];
    session.stream.emit('data', 'x'.repeat(300000));
    assert.equal(session.text.length, 262144);
    const result = await f.inspector.terminal({
      ...base,
      owner: session.owner,
      action: 'exchange',
      sessionId: session.id,
      data: '',
      sequence: 0,
      offset: 0,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 16384);
    session.deadline = Date.now() - 1;
    await assert.rejects(
      f.inspector.terminal({
        ...base,
        owner: session.owner,
        action: 'exchange',
        sessionId: session.id,
      }),
      /EXPIRED/,
    );
  } finally {
    f.inspector.closeRun('run');
  }
  assert.equal(f.inspector.sessions.size, 0);
});
