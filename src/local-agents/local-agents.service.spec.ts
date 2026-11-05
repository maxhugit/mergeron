import { ConfigService } from '@nestjs/config';
import { createTestDatabase } from '../database/database.testing';
import { SettingsService } from '../settings/settings.service';
import { ThreadExecutionPreferencesService } from '../threads/thread-execution-preferences.service';
import { accessContext } from '../auth/access-context';
import type { Mock } from 'vitest';
import {
  LOCAL_PROVIDER,
  localEndpoint,
  localModelId,
  LocalAgentsService,
} from './local-agents.service';

describe('local agent routing', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let config: SettingsService;
  let local: LocalAgentsService;
  let request: Mock<(method: string, params?: unknown) => Promise<unknown>>;
  let fetchMock: Mock<
    (url: string | URL, init?: RequestInit) => Promise<Response>
  >;
  type Sent = {
    config: Record<string, unknown> & {
      model_providers: Record<string, { base_url: string }>;
    };
  };
  const lastRequest = () => request.mock.calls.at(-1)![1] as Sent;
  const nativeFetch = globalThis.fetch;
  const options = {
    enabled: true,
    url: 'http://127.0.0.1:11434',
    models: 'gpt-oss:local',
    context: 16384,
  };
  beforeEach(() => {
    database = createTestDatabase();
    config = new SettingsService(database.db, new ConfigService());
    local = new LocalAgentsService(config, database.db);
    local.configure(options);
    fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/show'))
        return Response.json({
          parameters: 'num_ctx 16384',
          capabilities: ['completion', 'tools'],
        });
      if (String(url).endsWith('/api/tags'))
        return Response.json({ models: [{ name: 'gpt-oss:local' }] });
      if (String(url).endsWith(':11434/v1/responses'))
        return Response.json({ output: [] });
      return nativeFetch(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    request = vi.fn((method: string) =>
      Promise.resolve(
        method === 'thread/read'
          ? { thread: { modelProvider: 'openai' } }
          : {
              thread: { id: method === 'thread/fork' ? 'fork' : 'local' },
              modelProvider: LOCAL_PROVIDER,
            },
      ),
    );
  });
  afterEach(() => {
    local.onModuleDestroy();
    database.sqlite.close();
    vi.unstubAllGlobals();
  });
  const start = () =>
    local.request({ request } as never, 'thread/start', {
      model: localModelId('gpt-oss:local'),
      cwd: '/work',
      sandbox: 'read-only',
    });

  it('preserves normal cloud requests without changing their parameters', async () => {
    await local.request({ request } as never, 'thread/start', {
      model: 'cloud-model',
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('thread/start', {
      model: 'cloud-model',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fixes the local provider, model and review model without loosening the sandbox', async () => {
    await local.request({ request } as never, 'thread/start', {
      model: localModelId('gpt-oss:local'),
      sandbox: 'read-only',
      config: {
        'model_providers.mergeron_ollama.base_url': 'https://external.invalid',
        'features.plugins': true,
      },
    });
    const sent = lastRequest();
    expect(sent).toMatchObject({
      modelProvider: LOCAL_PROVIDER,
      model: 'gpt-oss:local',
      sandbox: 'read-only',
      config: {
        review_model: 'gpt-oss:local',
        web_search: 'disabled',
        features: { plugins: false },
      },
    });
    expect(
      sent.config['model_providers.mergeron_ollama.base_url'],
    ).toBeUndefined();
    expect(sent.config.model_providers[LOCAL_PROVIDER]).toMatchObject({
      requires_openai_auth: false,
      wire_api: 'responses',
      request_max_retries: 0,
    });
    expect(local.binding('local')).toEqual({
      model: 'gpt-oss:local',
      endpoint: options.url,
    });
  });
  it('keeps the provider across a service restart, resume, fork, presets and project model overrides', async () => {
    await start();
    local.onModuleDestroy();
    local = new LocalAgentsService(config, database.db);
    await local.request({ request } as never, 'thread/resume', {
      threadId: 'local',
      model: 'project-cloud-default',
    });
    await local.request({ request } as never, 'thread/fork', {
      threadId: 'local',
    });
    expect(local.binding('fork')?.model).toBe('gpt-oss:local');
    await local.request({ request } as never, 'turn/start', {
      threadId: 'fork',
      model: 'cloud-model',
      input: [],
      collaborationMode: { mode: 'plan', settings: { model: 'cloud-model' } },
    });
    expect(request.mock.calls.at(-1)![1]).toMatchObject({
      model: 'gpt-oss:local',
      effort: 'low',
      serviceTier: null,
      collaborationMode: { settings: { model: 'gpt-oss:local' } },
    });
  });
  it('preserves local identity after a preference save and refuses cross-provider selection', async () => {
    await start();
    const prefs = new ThreadExecutionPreferencesService(database.db, local);
    expect(prefs.read('local')).toMatchObject({
      local: true,
      model: localModelId('gpt-oss:local'),
      localModelName: 'gpt-oss:local',
    });
    expect(
      prefs.set('local', { model: localModelId('gpt-oss:local') }),
    ).toMatchObject({ local: true });
    expect(() => prefs.set('local', { model: 'cloud-model' })).toThrow(
      'another agent',
    );
    expect(() =>
      prefs.set('cloud', { model: localModelId('gpt-oss:local') }),
    ).toThrow('local agent');
  });
  it('fails before dispatch if Ollama disappears, is disabled or its endpoint changes', async () => {
    await start();
    request.mockClear();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(
      local.request({ request } as never, 'turn/start', {
        threadId: 'local',
        input: [],
      }),
    ).rejects.toThrow('no cloud fallback');
    expect(request).not.toHaveBeenCalled();
    local.configure({ ...options, enabled: false });
    await expect(
      local.request({ request } as never, 'turn/start', { threadId: 'local' }),
    ).rejects.toThrow('no cloud fallback');
    local.configure({ ...options, url: 'http://192.168.1.2:11434' });
    await expect(
      local.request({ request } as never, 'turn/start', { threadId: 'local' }),
    ).rejects.toThrow('endpoint changed');
    expect(request).not.toHaveBeenCalled();
  });
  it('inherits local inference for structured work requested through a local agent capability', async () => {
    await start();
    request.mockClear();
    await accessContext.run({ localAgentThreadId: 'local' } as never, () =>
      local.request({ request } as never, 'thread/start', {
        model: 'project-cloud-default',
        ephemeral: true,
      }),
    );
    expect(request.mock.calls.at(-1)![1]).toMatchObject({
      modelProvider: LOCAL_PROVIDER,
      model: 'gpt-oss:local',
      ephemeral: true,
    });
    await expect(
      accessContext.run({ localAgentThreadId: 'missing' } as never, () =>
        local.request({ request } as never, 'thread/start', {
          ephemeral: true,
        }),
      ),
    ).rejects.toThrow('refusing cloud fallback');
  });
  it('fails closed when a persisted local thread loses its binding', async () => {
    request.mockResolvedValue({ thread: { modelProvider: LOCAL_PROVIDER } });
    await expect(
      local.request({ request } as never, 'thread/resume', {
        threadId: 'lost',
      }),
    ).rejects.toThrow('refusing cloud fallback');
    await expect(
      local.request({ request } as never, 'turn/start', { threadId: 'lost' }),
    ).rejects.toThrow('refusing cloud fallback');
    expect(
      request.mock.calls.every(([method]) => method === 'thread/read'),
    ).toBe(true);
  });
  it('rejects an engine that does not acknowledge the local provider, retaining the local binding', async () => {
    request.mockResolvedValue({
      thread: { id: 'bad' },
      modelProvider: 'openai',
    });
    await expect(start()).rejects.toThrow('did not acknowledge');
    expect(local.binding('bad')).not.toBeNull();
  });
  it('does not advertise remote, missing or tool-less models, and never downloads them', async () => {
    expect(await local.catalog()).toMatchObject({
      available: true,
      data: [{ model: localModelId('gpt-oss:local') }],
    });
    for (const info of [
      {
        remote_host: 'https://ollama.com',
        parameters: 'num_ctx 16384',
        capabilities: ['completion', 'tools'],
      },
      { capabilities: ['embedding'] },
    ]) {
      fetchMock.mockImplementation((url) =>
        Promise.resolve(
          Response.json(
            String(url).endsWith('/api/tags')
              ? { models: [{ name: 'gpt-oss:local' }] }
              : info,
          ),
        ),
      );
      expect(await local.catalog()).toMatchObject({
        available: false,
        error: 'LOCAL_OLLAMA_UNAVAILABLE',
        data: [],
      });
    }
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/api/pull')),
    ).toBe(false);
  });
  it('removes ephemeral bindings after successful deletion, even with Ollama disabled', async () => {
    await start();
    local.configure({ ...options, enabled: false });
    await local.request({ request } as never, 'thread/delete', {
      threadId: 'local',
    });
    expect(local.binding('local')).toBeNull();
  });
  it('refuses an implicit or undersized Ollama context rather than silently truncating agent instructions', async () => {
    for (const parameters of ['', 'num_ctx 4096']) {
      fetchMock.mockResolvedValueOnce(
        Response.json({ parameters, capabilities: ['completion', 'tools'] }),
      );
      await expect(start()).rejects.toThrow('no cloud fallback');
      expect(request).not.toHaveBeenCalled();
    }
  });
  it('forwards Responses to Ollama without credentials and blocks unapproved models and web search', async () => {
    await start();
    const base = lastRequest().config.model_providers[LOCAL_PROVIDER].base_url;
    const send = (body: unknown) =>
      nativeFetch(base + '/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer synthetic-secret',
          Cookie: 'synthetic-cookie',
        },
        body: JSON.stringify(body),
      });
    const ok = await send({ model: 'gpt-oss:local', input: [] });
    expect(ok.status).toBe(200);
    await ok.text();
    const forwarded = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith(':11434/v1/responses'),
    )!;
    expect(forwarded[1]?.headers).toEqual({
      'Content-Type': 'application/json',
    });
    for (const body of [
      { model: 'cloud:cloud' },
      { model: 'gpt-oss:local', tools: [{ type: 'web_search' }] },
    ]) {
      const refused = await send(body);
      expect(refused.status).toBe(503);
      await refused.text();
    }
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith(':11434/v1/responses'),
      ),
    ).toHaveLength(1);
  });
  it.each([
    'https://public.example',
    'http://169.254.169.254',
    'http://10.1.2.3/path',
    'http://u:p@10.1.2.3',
    'file:///tmp/model',
    'http://10.1.2.3?x=y',
  ])('rejects unsafe endpoint %s', (url) => {
    expect(() => localEndpoint(url)).toThrow();
    expect(() => local.configure({ ...options, url })).toThrow();
    expect(local.configuration()).toEqual(options);
  });
});
