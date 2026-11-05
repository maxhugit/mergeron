/** Runs the real pinned app-server through the local gateway; all inference is synthetic loopback HTTP. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { createTestDatabase } from '../database/database.testing';
import { SettingsService } from '../settings/settings.service';
import { catalogFixture } from '../codex/catalog/catalog.testing';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification, v2 } from '../codex/codex-schema';
import {
  LOCAL_PROVIDER,
  localModelId,
  LocalAgentsService,
} from './local-agents.service';

it('keeps real native inference on Ollama after a process restart and a fork', async () => {
  const fixture = catalogFixture();
  const database = createTestDatabase();
  const settings = new SettingsService(database.db, new ConfigService());
  let local = new LocalAgentsService(settings, database.db);
  const seen: Array<{ path: string; model?: string; authorization?: string }> =
    [];
  const ollama = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(String(chunk)));
      if (req.url === '/api/show') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            parameters: 'num_ctx 16384',
            capabilities: ['completion', 'tools'],
          }),
        );
        return;
      }
      if (req.url !== '/v1/responses') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string;
      };
      seen.push({
        path: req.url,
        model: body.model,
        authorization: req.headers.authorization,
      });
      const item = {
        type: 'message',
        id: `message-${seen.length}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Local reply.' }],
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        {
          type: 'response.created',
          response: { id: `response-${seen.length}`, status: 'in_progress' },
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: `response-${seen.length}`,
            status: 'completed',
            output: [item],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    })().catch(() => res.destroy());
  });
  await new Promise<void>((done) => ollama.listen(0, '127.0.0.1', done));
  local.configure({
    enabled: true,
    url: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`,
    models: 'gpt-oss:local',
    context: 16384,
  });
  writeFileSync(
    fixture.paths.configFile,
    `model_catalog_json=${JSON.stringify(resolve('docs/upstream/model-catalog-0.153.2.json'))}\n[features]\nplugins=false\n`,
  );
  const manager = new CodexProcessManager(fixture.storage, {
    getStringSetting: () => null,
  } as unknown as SettingsService);
  try {
    await manager.onModuleInit();
    let client = manager.getClient();
    if (!client)
      throw new Error(manager.getStartupError() ?? 'Missing native client');
    const start = await local.request<v2.ThreadStartResponse>(
      client,
      'thread/start',
      {
        model: localModelId('gpt-oss:local'),
        cwd: fixture.home,
        sandbox: 'read-only',
      },
    );
    expect(start.modelProvider).toBe(LOCAL_PROVIDER);
    async function turn(id: string) {
      const activeClient = manager.getClient()!;
      const completed = new Promise<void>((done, reject) => {
        const timer = setTimeout(() => {
          activeClient.off('notification', listener);
          reject(new Error('Native local turn timed out'));
        }, 15000);
        function listener(note: ServerNotification) {
          if (note.method === 'turn/completed' && note.params.threadId === id) {
            clearTimeout(timer);
            activeClient.off('notification', listener);
            if (note.params.turn.status !== 'completed')
              reject(new Error('Local turn failed'));
            else done();
          }
        }
        activeClient.on('notification', listener);
      });
      await local.request(activeClient, 'turn/start', {
        threadId: id,
        input: [{ type: 'text', text: 'Reply locally.', text_elements: [] }],
      });
      await completed;
    }
    await turn(start.thread.id);
    await manager.restartControlled();
    local.onModuleDestroy();
    local = new LocalAgentsService(settings, database.db);
    client = manager.getClient();
    if (!client) throw new Error('Missing restarted client');
    const resumed = await local.request<v2.ThreadResumeResponse>(
      client,
      'thread/resume',
      { threadId: start.thread.id },
    );
    expect(resumed.modelProvider).toBe(LOCAL_PROVIDER);
    const fork = await local.request<v2.ThreadForkResponse>(
      client,
      'thread/fork',
      { threadId: start.thread.id },
    );
    await turn(fork.thread.id);
    expect(local.binding(fork.thread.id)?.model).toBe('gpt-oss:local');
    expect(seen).toHaveLength(2);
    expect(
      seen.every(
        (r) => r.model === 'gpt-oss:local' && r.authorization === undefined,
      ),
    ).toBe(true);
  } finally {
    const client = manager.getClient();
    const closed = client
      ? new Promise<void>((done) => client.once('close', () => done()))
      : Promise.resolve();
    manager.onModuleDestroy();
    await closed;
    local.onModuleDestroy();
    ollama.closeAllConnections();
    await new Promise<void>((done) => ollama.close(() => done()));
    database.sqlite.close();
    fixture.cleanup();
  }
}, 45000);
