import { ConfigService } from '@nestjs/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestDatabase } from '../../database/database.testing';
import { SettingsService } from '../../settings/settings.service';
import {
  LocalAgentsService,
  localModelId,
} from '../../local-agents/local-agents.service';
import { LocalModelMetadataState } from '../../local-agents/local-model-metadata-state';
import { catalogFixture } from './catalog.testing';
import { CatalogNativeService, parseCatalog } from './catalog-native.service';
import {
  LocalModelCatalogService,
  type LocalCatalogPlan,
} from './local-model-catalog.service';
import { CodexProcessManager } from '../codex-process-manager.service';
import { CatalogService } from './catalog.service';
import { CatalogActivityService } from './catalog-activity.service';
import { CatalogAdmissionService } from './catalog-admission.service';
import type { v2 } from '../codex-schema';

const baseline = readFileSync(
  resolve('docs/upstream/model-catalog-0.153.2.json'),
  'utf8',
);
describe('local model runtime catalogs', () => {
  let fixture: ReturnType<typeof catalogFixture>,
    db: ReturnType<typeof createTestDatabase>,
    settings: SettingsService,
    state: LocalModelMetadataState,
    local: LocalAgentsService,
    native: CatalogNativeService,
    runtime: LocalModelCatalogService;
  beforeEach(() => {
    fixture = catalogFixture();
    db = createTestDatabase();
    settings = new SettingsService(db.db, new ConfigService());
    state = new LocalModelMetadataState(settings);
    local = new LocalAgentsService(settings, db.db, state);
    native = new CatalogNativeService(fixture.paths);
    runtime = new LocalModelCatalogService(fixture.storage, native, state);
    writeFileSync(join(fixture.home, 'selected.json'), baseline);
    writeFileSync(
      fixture.paths.configFile,
      'model_catalog_json="selected.json"\n[features]\nplugins=false\n',
    );
  });
  afterEach(() => {
    local.onModuleDestroy();
    db.sqlite.close();
    fixture.cleanup();
  });
  const configure = (models = 'gpt-oss:mergeron-dev-20b', context = 16384) =>
    local.configure({
      enabled: true,
      url: 'http://127.0.0.1:11434',
      models,
      context,
    });
  it('does not export or write a runtime catalog when local inference is disabled', async () => {
    const effective = vi.spyOn(native, 'effective');
    expect(await runtime.prepare()).toBeNull();
    expect(effective).not.toHaveBeenCalled();
  });
  it('validates exact local names and conservative capabilities without changing the source or cloud entries', async () => {
    configure('gpt-oss:mergeron-dev-20b,qwen3:local');
    const user = readFileSync(fixture.paths.configFile, 'utf8');
    const source = readFileSync(join(fixture.home, 'selected.json'), 'utf8');
    const plan = (await runtime.prepare())!;
    const output = parseCatalog(plan.content);
    const base = parseCatalog(plan.baseContent);
    expect(output.models.slice(0, base.models.length)).toEqual(base.models);
    const entry = output.models.find(
      (m) => m.slug === 'gpt-oss:mergeron-dev-20b',
    )!;
    expect(entry).toMatchObject({
      context_window: 16384,
      max_context_window: 16384,
      input_modalities: ['text'],
      supports_search_tool: false,
      use_responses_lite: false,
      node_repl_disabled: true,
      apply_patch_tool_type: null,
      visibility: 'hide',
    });
    expect(
      output.models.find((m) => m.slug === 'qwen3:local')
        ?.default_reasoning_level,
    ).toBe('none');
    expect(readFileSync(fixture.paths.configFile, 'utf8')).toBe(user);
    expect(readFileSync(join(fixture.home, 'selected.json'), 'utf8')).toBe(
      source,
    );
    expect((await runtime.prepare())?.path).toBe(plan.path);
  }, 20000);
  it('honors an explicit administrator model entry rather than replacing its instructions', async () => {
    configure();
    const custom = parseCatalog(baseline);
    custom.models.push({
      ...custom.models[0],
      slug: 'gpt-oss:mergeron-dev-20b',
      base_instructions: 'Administrator instructions',
    });
    const source = JSON.stringify(custom);
    writeFileSync(join(fixture.home, 'selected.json'), source);
    expect(await runtime.prepare()).toBeNull();
    expect(readFileSync(join(fixture.home, 'selected.json'), 'utf8')).toBe(
      source,
    );
  }, 15000);
  it('blocks a local request after metadata changes without changing cloud routing or starting inference', async () => {
    configure();
    state.accept(state.signature(), ['gpt-oss:mergeron-dev-20b']);
    configure('gpt-oss:mergeron-dev-20b', 32768);
    const request = vi.fn().mockResolvedValue({});
    await expect(
      local.request({ request } as never, 'thread/start', {
        model: localModelId('gpt-oss:mergeron-dev-20b'),
      }),
    ).rejects.toThrow('Restart Codex');
    expect(request).not.toHaveBeenCalled();
    await local.request({ request } as never, 'thread/start', {
      model: 'cloud-model',
    });
    expect(request).toHaveBeenCalledWith('thread/start', {
      model: 'cloud-model',
    });
  });
  it('keeps generated native slugs out of the normal model selector', async () => {
    configure();
    state.accept(state.signature(), ['gpt-oss:mergeron-dev-20b']);
    const request = vi.fn().mockResolvedValue({
      data: [{ model: 'cloud' }, { model: 'gpt-oss:mergeron-dev-20b' }],
      nextCursor: 'cursor',
    });
    expect(await local.request({ request } as never, 'model/list', {})).toEqual(
      { data: [{ model: 'cloud' }], nextCursor: 'cursor' },
    );
  });
  it('preserves higher-precedence source origins when masking only its generated startup leaf', () => {
    const plan = { path: '/runtime.json' } as LocalCatalogPlan;
    const response = {
      config: { model_catalog_json: '/runtime.json' },
      origins: {
        model_catalog_json: {
          name: { type: 'sessionFlags' },
          version: 'runtime',
        },
      },
      layers: [
        {
          name: { type: 'sessionFlags' },
          version: 'runtime',
          config: { model_catalog_json: '/runtime.json', other: 'keep' },
          disabledReason: null,
        },
        {
          name: { type: 'project', dotCodexFolder: '/project/.codex' },
          version: 'project',
          config: { model_catalog_json: 'models.json' },
          disabledReason: null,
        },
        {
          name: {
            type: 'user',
            file: '/home/codex/.codex/config.toml',
            profile: null,
          },
          version: 'user',
          config: { model_catalog_json: 'user.json' },
          disabledReason: null,
        },
      ],
    } as unknown as v2.ConfigReadResponse;
    const result = runtime.sourceConfig(response, plan);
    expect(result.config.model_catalog_json).toBe(
      '/project/.codex/models.json',
    );
    expect(result.origins.model_catalog_json?.name.type).toBe('project');
    expect(result.layers?.[0].config).toEqual({ other: 'keep' });
    expect(response.config.model_catalog_json).toBe('/runtime.json');
  });
  it('retains catalog activation, default restoration and pointer diagnostics with the native runtime overlay', async () => {
    configure();
    const original = readFileSync(fixture.paths.configFile, 'utf8');
    const manager = new CodexProcessManager(
      fixture.storage,
      settings,
      undefined,
      runtime,
    );
    try {
      await manager.onModuleInit();
      expect(manager.getClient()).not.toBeNull();
      const admission = new CatalogAdmissionService();
      const catalogs = new CatalogService(
        fixture.storage,
        native,
        manager,
        new CatalogActivityService(manager, admission),
        admission,
        runtime,
      );
      expect(catalogs.state().pointerApplied).toBe(true);
      expect(readFileSync(fixture.paths.configFile, 'utf8')).toBe(original);
      const draft = await catalogs.seed('bundled', null);
      await catalogs.apply(draft.content!, 'selected.json');
      expect(catalogs.state().pointerApplied).toBe(true);
      expect(state.requiresRestart()).toBe(false);
      const pointer = fixture.storage.pointer();
      await catalogs.useDefault(pointer);
      expect(fixture.storage.pointer()).toBeNull();
      expect(catalogs.state().pointerApplied).toBe(true);
      expect(fixture.storage.runtimePaths.size).toBe(1);
    } finally {
      const client = manager.getClient();
      const closed = client
        ? new Promise<void>((done) => client.once('close', () => done()))
        : Promise.resolve();
      manager.onModuleDestroy();
      await closed;
    }
  }, 45000);
});
