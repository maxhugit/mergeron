import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { settings } from '../database/schema';
import { SettingsService } from '../settings/settings.service';
import type { CodexJsonRpcClient } from '../codex/codex-jsonrpc-client';
import type { v2 } from '../codex/codex-schema';
import { currentAccess } from '../auth/access-context';

export const LOCAL_PROVIDER = 'mergeron_ollama';
export const LOCAL_MODEL_PREFIX = 'ollama:';
const BINDING_PREFIX = 'local-agent:';
export const LOCAL_KEYS = {
  enabled: 'general.localAgentsEnabled',
  url: 'general.localAgentsUrl',
  models: 'general.localAgentsModels',
  context: 'general.localAgentsContext',
} as const;
export const localModelId = (model: string) =>
  LOCAL_MODEL_PREFIX + Buffer.from(model).toString('base64url');
export const isLocalModel = (model: unknown): model is string =>
  typeof model === 'string' && model.startsWith(LOCAL_MODEL_PREFIX);

export function localEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Invalid Ollama URL');
  }
  const host = url.hostname;
  const parts = host.split('.').map(Number);
  const ipv4 =
    parts.length === 4 &&
    parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  const privateHost =
    host === 'localhost' ||
    host === '[::1]' ||
    (ipv4 &&
      (parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)));
  if (
    !privateHost ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new BadRequestException(
      'Ollama requires a private IP or localhost URL without credentials or path',
    );
  return url.origin;
}
type Binding = { model: string; endpoint: string };
type Catalog = { data: v2.Model[]; available: boolean; error: string | null };

/** Local inference routing. Tool network permissions are a separate boundary. */
@Injectable()
export class LocalAgentsService implements OnModuleDestroy {
  private server?: Server;
  private gateway?: Promise<string>;
  constructor(
    private readonly config: SettingsService,
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
  ) {}

  configuration() {
    return {
      enabled: this.config.getSetting(LOCAL_KEYS.enabled).value === true,
      url: this.config.getStringSetting(LOCAL_KEYS.url) ?? '',
      models: this.config.getStringSetting(LOCAL_KEYS.models) ?? '',
      context: this.config.getNumberSetting(LOCAL_KEYS.context),
    };
  }
  configure(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Invalid local agent configuration');
    const c = input as ReturnType<LocalAgentsService['configuration']>;
    if (
      Object.keys(c).some(
        (k) => !['enabled', 'url', 'models', 'context'].includes(k),
      ) ||
      typeof c.enabled !== 'boolean' ||
      typeof c.url !== 'string' ||
      typeof c.models !== 'string' ||
      c.models.length > 4000 ||
      !Number.isInteger(c.context) ||
      c.context < 8192 ||
      c.context > 131072
    )
      throw new BadRequestException('Invalid local agent configuration');
    const canonicalUrl = c.enabled || c.url ? localEndpoint(c.url) : '';
    const allowed = this.allowed(c.models);
    if (c.enabled && !allowed.length)
      throw new BadRequestException(
        'Select at least one installed local model',
      );
    const previousUrl = this.configuration().url;
    this.config.updateSettings(
      Object.entries(LOCAL_KEYS).map(([field, key]) => ({
        key,
        value: field === 'url' ? canonicalUrl : c[field as keyof typeof c],
      })),
    );
    if (previousUrl !== canonicalUrl) {
      this.onModuleDestroy();
      this.gateway = undefined;
      this.server = undefined;
    }
    return this.configuration();
  }
  private allowed(value = this.configuration().models) {
    const models = [
      ...new Set(
        value
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
      ),
    ];
    if (
      models.length > 20 ||
      models.some(
        (m) =>
          m.length > 140 ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(m) ||
          /(?:^|[:/-])cloud(?:$|[:/-])/i.test(m),
      )
    )
      throw new BadRequestException(
        'Only explicitly allowed local Ollama models are supported',
      );
    return models;
  }
  private endpoint() {
    const c = this.configuration();
    if (!c.enabled)
      throw new ServiceUnavailableException(
        'Local agents are disabled; no cloud fallback',
      );
    return localEndpoint(c.url);
  }
  private async json(
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const r = await fetch(this.endpoint() + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok || !r.body) throw new Error('Ollama unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > 2_000_000) {
        await r.body.cancel().catch(() => {});
        throw new Error('Ollama response too large');
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<
      string,
      unknown
    >;
  }
  private async check(model: string) {
    if (!this.allowed().includes(model))
      throw new BadRequestException('Local model is not allowed');
    const info = await this.json('/api/show', { model });
    if (
      info.remote_host ||
      info.remote_model ||
      !Array.isArray(info.capabilities) ||
      !info.capabilities.includes('completion') ||
      !info.capabilities.includes('tools')
    )
      throw new BadRequestException(
        'The model must be installed locally and support tools',
      );
    const context =
      typeof info.parameters === 'string'
        ? /^num_ctx\s+(\d+)\s*$/m.exec(info.parameters)
        : null;
    if (!context || Number(context[1]) < this.configuration().context)
      throw new BadRequestException(
        'Configure an explicit num_ctx at least as large as the agent context in the Ollama model',
      );
  }
  async catalog(): Promise<Catalog> {
    if (!this.configuration().enabled)
      return { data: [], available: false, error: null };
    try {
      const tags = await this.json('/api/tags');
      const installed = new Set(
        (Array.isArray(tags.models) ? tags.models : []).map(
          (m: { name?: string }) => m.name,
        ),
      );
      const models = this.allowed();
      for (const model of models) {
        if (!installed.has(model)) throw new Error('Local model not installed');
        await this.check(model);
      }
      return {
        available: true,
        error: null,
        data: models.map((model) => ({
          id: localModelId(model),
          model: localModelId(model),
          displayName: `Ollama · ${model}`,
          description: 'Local inference · tool network permissions still apply',
          hidden: false,
          isDefault: false,
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          modelSpecialty: null,
          multiAgentVersion: null,
          additionalSpeedTiers: [],
          supportedReasoningEfforts: [
            {
              reasoningEffort: model.startsWith('gpt-oss:') ? 'low' : 'none',
              description: '',
            },
          ],
          defaultReasoningEffort: model.startsWith('gpt-oss:') ? 'low' : 'none',
          inputModalities: ['text'],
          supportsPersonality: false,
          serviceTiers: [],
          defaultServiceTier: null,
        })),
      };
    } catch {
      return { data: [], available: false, error: 'LOCAL_OLLAMA_UNAVAILABLE' };
    }
  }
  binding(threadId: string): Binding | null {
    const raw = this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, BINDING_PREFIX + threadId))
      .get()?.value;
    if (!raw) return null;
    const binding = JSON.parse(raw) as Binding;
    if (
      typeof binding.model !== 'string' ||
      typeof binding.endpoint !== 'string'
    )
      throw new ConflictException(
        'Invalid local agent binding; refusing cloud fallback',
      );
    return binding;
  }
  accessForThread(threadId: string) {
    const access = currentAccess();
    return access && this.binding(threadId)
      ? { ...access, localAgentThreadId: threadId }
      : access;
  }
  private bind(threadId: string, binding: Binding) {
    const value = JSON.stringify(binding);
    this.db
      .insert(settings)
      .values({
        key: BINDING_PREFIX + threadId,
        value,
        type: 'string',
        category: 'local-agent-binding',
        description: 'Local inference provider fixed at agent creation',
        defaultValue: '{}',
        constraints: '{}',
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: Date.now() },
      })
      .run();
  }
  validateChoice(threadId: string, model: unknown) {
    const binding = this.binding(threadId);
    if (binding && model != null && !isLocalModel(model))
      throw new BadRequestException(
        'Create another agent to use a cloud model',
      );
    if (!binding && isLocalModel(model))
      throw new BadRequestException(
        'Create a local agent to use Ollama; existing history is not transferred',
      );
    if (isLocalModel(model)) this.decode(model);
  }
  private decode(id: string) {
    const model = Buffer.from(
      id.slice(LOCAL_MODEL_PREFIX.length),
      'base64url',
    ).toString();
    if (localModelId(model) !== id || !this.allowed().includes(model))
      throw new BadRequestException('Invalid local model');
    return model;
  }

  /** A credential-free, loopback-only Responses gateway also bounds models used by subagents. */
  private gatewayUrl(): Promise<string> {
    const endpoint = this.endpoint();
    return (this.gateway ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const abort = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) abort.abort();
        });
        void (async () => {
          if (req.method !== 'POST' || req.url !== '/v1/responses') {
            res.writeHead(404).end();
            return;
          }
          let size = 0;
          const chunks: Uint8Array[] = [];
          for await (const value of req as AsyncIterable<unknown>) {
            const chunk =
              typeof value === 'string'
                ? Buffer.from(value)
                : Buffer.isBuffer(value)
                  ? Uint8Array.from(value.values())
                  : null;
            if (!chunk) throw new Error('Invalid request body');
            size += chunk.byteLength;
            if (size > 4_000_000) {
              res.writeHead(413).end();
              return;
            }
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks);
          if (this.endpoint() !== endpoint)
            throw new Error('Local endpoint changed');
          const data = JSON.parse(body.toString()) as {
            model?: string;
            tools?: Array<{ type?: string }>;
          };
          if (!data.model) throw new Error('Missing model');
          await this.check(data.model);
          if (data.tools?.some((tool) => tool.type?.startsWith('web_search')))
            throw new Error('Web search is disabled for local inference');
          const response = await fetch(endpoint + '/v1/responses', {
            method: 'POST',
            redirect: 'error',
            body,
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.any([
              abort.signal,
              AbortSignal.timeout(180_000),
            ]),
          });
          if (!response.ok || !response.body)
            throw new Error('Local inference unavailable');
          res.writeHead(200, {
            'Content-Type':
              response.headers.get('content-type') ?? 'application/json',
            'Cache-Control': 'no-store',
          });
          await pipeline(Readable.fromWeb(response.body as never), res);
        })().catch(() => {
          if (!res.headersSent)
            res.writeHead(503, { 'Content-Type': 'application/json' }).end(
              JSON.stringify({
                error: {
                  message: 'Local inference unavailable; no cloud fallback',
                  type: 'local_inference_unavailable',
                },
              }),
            );
          else res.destroy();
        });
      });
      this.server = server;
      server.maxConnections = 32;
      server.requestTimeout = 190_000;
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Local gateway unavailable'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}/v1`);
      });
    }));
  }

  async request<T>(
    client: Pick<CodexJsonRpcClient, 'request'>,
    method: string,
    raw?: unknown,
  ): Promise<T> {
    let params =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const threadId =
      typeof params.threadId === 'string' ? params.threadId : null;
    let binding = threadId ? this.binding(threadId) : null;
    if (method === 'thread/delete') {
      const result = await client.request<T>(method, raw);
      if (threadId)
        this.db
          .delete(settings)
          .where(eq(settings.key, BINDING_PREFIX + threadId))
          .run();
      return result;
    }
    const start = method === 'thread/start';
    const origin = currentAccess()?.localAgentThreadId;
    if (start && origin) {
      const source = this.binding(origin);
      if (!source)
        throw new ConflictException(
          'Local origin missing; refusing cloud fallback',
        );
      if (source.endpoint !== this.endpoint())
        throw new ConflictException('Local origin endpoint changed');
      params = { ...params, model: localModelId(source.model) };
    }
    const reopen = method === 'thread/resume' || method === 'thread/fork';
    const execution = [
      'turn/start',
      'thread/settings/update',
      'review/start',
      'thread/compact/start',
      'thread/queue/start',
    ].includes(method);
    if (!(start || reopen || execution)) return client.request<T>(method, raw);
    if ((reopen || execution) && !binding && threadId) {
      const metadata = await client.request<{
        thread: { modelProvider: string };
      }>('thread/read', { threadId, includeTurns: false });
      if (metadata.thread.modelProvider === LOCAL_PROVIDER)
        throw new ConflictException(
          'Local agent configuration missing; refusing cloud fallback',
        );
    }
    if (!binding && !start && isLocalModel(params.model))
      throw new BadRequestException('Create a new local agent to use Ollama');
    if (start && isLocalModel(params.model))
      binding = { model: this.decode(params.model), endpoint: this.endpoint() };
    if (!binding) {
      if (params.modelProvider === LOCAL_PROVIDER)
        throw new BadRequestException('Select an allowed local model');
      return client.request<T>(method, raw);
    }
    if (binding.endpoint !== this.endpoint())
      throw new ConflictException(
        'Ollama endpoint changed; create a new local agent',
      );
    const model = isLocalModel(params.model)
      ? this.decode(params.model)
      : binding.model;
    try {
      await this.check(model);
    } catch {
      throw new ServiceUnavailableException(
        'Local model unavailable; no cloud fallback',
      );
    }
    const next: Record<string, unknown> = {
      ...params,
      model,
      serviceTier: null,
    };
    if (method === 'turn/start')
      next.effort = model.startsWith('gpt-oss:') ? 'low' : 'none';
    if (
      params.collaborationMode &&
      typeof params.collaborationMode === 'object'
    ) {
      const mode = params.collaborationMode as {
        settings?: Record<string, unknown>;
      };
      next.collaborationMode = {
        ...mode,
        settings: {
          ...mode.settings,
          model,
          reasoning_effort: model.startsWith('gpt-oss:') ? 'low' : 'none',
        },
      };
    }
    if (start || reopen) {
      next.modelProvider = LOCAL_PROVIDER;
      const inherited = Object.fromEntries(
        Object.entries((params.config as Record<string, unknown>) ?? {}).filter(
          ([key]) =>
            ![
              'model',
              'model_provider',
              'model_providers',
              'review_model',
              'web_search',
              'openai_base_url',
              'chatgpt_base_url',
              'features.plugins',
              'features.apps',
            ].some(
              (reserved) => key === reserved || key.startsWith(reserved + '.'),
            ),
        ),
      );
      next.config = {
        ...inherited,
        model_provider: LOCAL_PROVIDER,
        model_context_window: this.configuration().context,
        model_providers: {
          [LOCAL_PROVIDER]: {
            name: 'Mergeron local Ollama',
            base_url: await this.gatewayUrl(),
            wire_api: 'responses',
            requires_openai_auth: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
        model_reasoning_effort: model.startsWith('gpt-oss:') ? 'low' : 'none',
        review_model: model,
        web_search: 'disabled',
        features: {
          ...((params.config as { features?: object })?.features ?? {}),
          plugins: false,
          apps: false,
        },
      };
    }
    const response = await client.request<T>(method, next);
    const result = response as {
      thread?: { id: string };
      modelProvider?: string;
    };
    const id = start || method === 'thread/fork' ? result.thread?.id : threadId;
    if (id) this.bind(id, { ...binding, model });
    if ((start || reopen) && result.modelProvider !== LOCAL_PROVIDER)
      throw new ConflictException(
        'The engine did not acknowledge the local provider',
      );
    return response;
  }
  onModuleDestroy() {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
