/** Real pinned-engine round trip. Only a loopback provider returning 401 is used. */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { v2 } from '../src/codex/codex-schema';
import { AppServer } from './harness';
import { result, shell, storedItems } from './history-window-fixture';
import { resolveCodexBin, codexVersion } from './run';

async function main() {
  const archived = process.env.ARCHIVE_PROBE_ARCHIVED === '1';
  const base = await mkdtemp(join(tmpdir(), 'mergeron-native-archive-'));
  const sourceHome = join(base, 'source-home');
  const targetHome = join(base, 'target-home');
  const workspace = join(base, 'source-workspace');
  const targetRoot = join(base, 'target-workspaces');
  for (const path of [sourceHome, targetHome, workspace, targetRoot])
    await mkdir(path);
  let providerRequests = 0;
  const provider = createServer((_request, response) => {
    providerRequests++;
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { message: 'No model calls in the archive transport test' },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const config = `model_provider = "probe"\nmodel = "probe"\n[model_providers.probe]\nname = "probe"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
  await writeFile(join(sourceHome, 'config.toml'), config);
  await writeFile(join(targetHome, 'config.toml'), config);
  let source: AppServer | undefined;
  let destination: AppServer | undefined;
  let passed = false;
  try {
    const bin = resolveCodexBin();
    assert.equal(codexVersion(bin), 'codex-cli 0.153.2');
    source = await AppServer.start({ bin, home: sourceHome, cwd: workspace });
    destination = await AppServer.start({
      bin,
      home: targetHome,
      cwd: targetRoot,
    });
    const started = result(
      await source.request<v2.ThreadStartResponse>({
        method: 'thread/start',
        params: {
          cwd: workspace,
          sandbox: 'read-only',
          approvalPolicy: 'never',
        },
      }),
    ).thread;
    assert.equal(started.historyMode, 'paginated');
    const turn = await source.runTurn(
      started.id,
      'Project archive fixture. No external provider is permitted.',
      { timeoutMs: 20_000 },
    );
    assert.equal(turn.completed, true);
    result(
      await source.request({
        method: 'thread/name/set',
        params: { threadId: started.id, name: 'Portable native history' },
      }),
    );
    const originalList = result(
      await source.request<v2.ThreadListResponse>({
        method: 'thread/list',
        params: { modelProviders: [], limit: 100 },
      }),
    ).data;
    assert.equal(
      originalList.length,
      1,
      'Source fixture must be discoverable before export',
    );
    const shellTurn = await shell(
      source,
      started.id,
      'printf ARCHIVE_NATIVE_HISTORY_OK',
    );
    if (archived)
      result(
        await source.requestRaw('thread/archive', { threadId: started.id }),
      );
    await source.kill('SIGTERM');
    source = undefined;
    await destination.requestRaw('thread/turns/list', {
      threadId: started.id,
      limit: 1,
      sortDirection: 'asc',
      itemsView: 'notLoaded',
    });
    await destination.kill('SIGTERM');
    destination = undefined;

    const setup = String.raw`
import json, pathlib, sqlite3, sys
root, base, workspace, thread = sys.argv[1:]
for filename in ['source.sqlite', 'target.sqlite']:
 db = sqlite3.connect(pathlib.Path(base)/filename)
 for migration in json.loads((pathlib.Path(root)/'drizzle/meta/_journal.json').read_text())['entries']:
  db.executescript((pathlib.Path(root)/'drizzle'/(migration['tag']+'.sql')).read_text())
 if filename == 'source.sqlite':
  db.execute("INSERT INTO projects(id,name,workspace_path,workspace_layout_version,created_at,updated_at) VALUES('source-project','Native fixture',?,2,1,1)",(workspace,))
  db.execute("INSERT INTO project_workspaces(id,project_id,name,path,is_primary,created_at,updated_at) VALUES('source-workspace','source-project','Main',?,1,1,1)",(workspace,))
  db.execute("INSERT INTO project_agent_threads(thread_id,project_id,workspace_path,created_at,updated_at) VALUES(?,'source-project',?,1,1)",(thread,workspace))
 db.commit(); db.close()
`;
    const initialized = spawnSync(
      'python3',
      ['-c', setup, resolve('.'), base, workspace, started.id],
      { encoding: 'utf8' },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    const archive = join(base, 'project.zip');
    const invoke = (
      options: Record<string, unknown>,
    ): Record<string, unknown> => {
      const operation = spawnSync('python3', ['scripts/project_archive.py'], {
        input: JSON.stringify(options),
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(operation.status, 0, operation.stdout + operation.stderr);
      const parsed = JSON.parse(operation.stdout) as {
        ok: boolean;
        result: Record<string, unknown>;
      };
      assert.equal(parsed.ok, true);
      return parsed.result;
    };
    invoke({
      action: 'export',
      database: join(base, 'source.sqlite'),
      workspaceRoot: workspace,
      codexHome: sourceHome,
      codexVersion: '0.153.2',
      projectId: 'source-project',
      version: '0.1.0',
      archive,
    });
    const target = {
      codexBin: bin,
      database: join(base, 'target.sqlite'),
      workspaceRoot: targetRoot,
      codexHome: targetHome,
      codexVersion: '0.153.2',
      version: '0.2.0',
      archive,
    };
    assert.equal(invoke({ ...target, action: 'preview' }).compatible, true);
    const imported = invoke({ ...target, action: 'import' });
    const requestsBeforeRead = providerRequests;
    destination = await AppServer.start({
      bin,
      home: targetHome,
      cwd: targetRoot,
    });
    const list = result(
      await destination.request<v2.ThreadListResponse>({
        method: 'thread/list',
        params: { modelProviders: [], limit: 100, archived },
      }),
    ).data;
    if (list.length !== 1) {
      const stateOnly = await destination.requestRaw<v2.ThreadListResponse>(
        'thread/list',
        { modelProviders: [], limit: 100, useStateDbOnly: true },
      );
      console.error(
        'Isolated native diagnostic',
        JSON.stringify({
          stateOnly: stateOnly.result?.data.map((entry) => ({
            id: entry.id,
            name: entry.name,
          })),
          stderr: destination.stderr().slice(-4000),
        }),
      );
    }
    assert.equal(
      list.length,
      1,
      'Imported history must be discoverable by the actual app-server',
    );
    const restored = list[0];
    assert.notEqual(restored.id, started.id);
    assert.equal(restored.historyMode, 'paginated');
    assert.ok(
      restored.cwd.startsWith(
        join(await realpath(targetRoot), imported.projectId as string),
      ),
    );
    const items = await storedItems(destination, restored.id, shellTurn);
    assert.ok(JSON.stringify(items).includes('ARCHIVE_NATIVE_HISTORY_OK'));
    if (archived)
      result(
        await destination.requestRaw('thread/unarchive', {
          threadId: restored.id,
        }),
      );
    const resumed = result(
      await destination.requestRaw<v2.ThreadResumeResponse>('thread/resume', {
        threadId: restored.id,
        excludeTurns: true,
        initialTurnsPage: {
          limit: 20,
          sortDirection: 'desc',
          itemsView: 'summary',
        },
      }),
    );
    assert.equal(resumed.thread.id, restored.id);
    assert.equal(resumed.approvalPolicy, 'on-request');
    assert.equal(resumed.sandbox.type, 'readOnly');
    assert.equal(
      providerRequests,
      requestsBeforeRead,
      'Import/read/resume must not execute a model turn',
    );
    console.log(
      JSON.stringify({
        case: 'project-archive-native-round-trip',
        passed: true,
        engine: '0.153.2',
        archived,
        distinctApplicationVersions: true,
        nativePagedItemsReadable: true,
        importedAgentResumable: true,
        noModelExecutionOnImport: true,
      }),
    );
    passed = true;
  } finally {
    await source?.kill('SIGTERM');
    await destination?.kill('SIGTERM');
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (passed) await rm(base, { recursive: true, force: true });
    else console.error('Isolated diagnostic fixture retained at', base);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
