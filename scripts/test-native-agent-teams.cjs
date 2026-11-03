/** Real CLI protocol contract against a local deterministic Responses provider.
 * No account, credentials, external inference, repository commands or file edits.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mergeron-team-contract-'));
let child,
  sequence = 0,
  rootRequests = 0,
  rootId;
const pending = new Map(),
  held = [],
  spawns = [];
let complete;
const done = new Promise((resolve) => {
  complete = resolve;
});
function answer(response, item) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(
    'event: response.output_item.done\ndata: ' +
      JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item,
      }) +
      '\n\nevent: response.completed\ndata: ' +
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: `fixture_${sequence}_${rootRequests}`,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }) +
      '\n\n',
  );
}
const final = () => ({
  id: 'fixture_message',
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text: 'Fixture complete', annotations: [] }],
});
const server = http.createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const latestUser = (body.input || [])
      .filter((item) => item.role === 'user')
      .at(-1);
    if (JSON.stringify(latestUser).includes('CHILD_FIXTURE')) {
      held.push(response);
      return;
    }
    rootRequests++;
    if (rootRequests <= 3)
      answer(response, {
        id: `fc_${rootRequests}`,
        type: 'function_call',
        call_id: `call_${rootRequests}`,
        namespace: 'multi_agent_v1',
        name: 'spawn_agent',
        arguments: JSON.stringify({
          message: `CHILD_FIXTURE ${rootRequests}`,
          fork_context: false,
        }),
      });
    else answer(response, final());
  } catch {
    response.writeHead(500);
    response.end();
  }
});
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `model="fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n[features]\napps=false\nplugins=false\n`,
  );
  child = spawn(
    path.resolve(process.argv[2] || 'node_modules/.bin/codex'),
    ['app-server'],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: home,
        TMPDIR: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stderr.resume();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (
      message.method === 'item/completed' &&
      message.params?.item?.type === 'collabAgentToolCall'
    )
      spawns.push(message.params.item);
    if (
      message.method === 'turn/completed' &&
      message.params.threadId === rootId
    )
      complete();
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      message.error
        ? waiter.reject(Error(message.error.message))
        : waiter.resolve(message.result);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  await rpc('initialize', {
    clientInfo: { name: 'mergeron-native-team-contract', version: '1' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  const { thread } = await rpc('thread/start', {
    cwd: home,
    config: { agents: { max_threads: 2 } },
  });
  rootId = thread.id;
  await rpc('turn/start', {
    threadId: rootId,
    input: [
      {
        type: 'text',
        text: 'ROOT_FIXTURE [mergeron-team:fixture]: delegate independent tasks using native subagents.',
        text_elements: [],
      },
    ],
  });
  await done;
  const history = await rpc('thread/turns/list', {
    threadId: rootId,
    limit: 1,
    sortDirection: 'desc',
    itemsView: 'full',
  });
  assert.equal(
    history.data.filter((turn) =>
      turn.items.some(
        (item) =>
          item.type === 'userMessage' &&
          item.content.some(
            (block) =>
              block.type === 'text' &&
              block.text.includes('[mergeron-team:fixture]'),
          ),
      ),
    ).length,
    1,
    'An uncertain dispatch must be correlatable without replay',
  );
  assert.equal(rootRequests, 4);
  const successful = spawns.filter(
    (item) => item.tool === 'spawnAgent' && item.status === 'completed',
  );
  assert.equal(
    successful.length,
    2,
    'Native concurrency cap must refuse the third open child',
  );
  assert.equal(
    spawns.filter(
      (item) => item.tool === 'spawnAgent' && item.status === 'failed',
    ).length,
    1,
  );
  for (const id of successful.flatMap((item) => item.receiverThreadIds)) {
    const result = await rpc('thread/read', {
      threadId: id,
      includeTurns: false,
    });
    assert.equal(result.thread.parentThreadId, rootId);
    assert.equal(result.thread.historyMode, 'paginated');
  }
  console.log(
    'Native agent teams: cap=2, third child refused, parent evidence and paginated history verified.',
  );
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    child?.kill();
    server.closeAllConnections();
    server.close();
    clearTimeout(timeout);
    setTimeout(() => {
      fs.rmSync(home, { recursive: true, force: true });
      process.exit(process.exitCode || 0);
    }, 200);
  });
const timeout = setTimeout(() => {
  console.error('Native team contract timed out');
  child?.kill();
  server.closeAllConnections();
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(1);
}, 30000);
