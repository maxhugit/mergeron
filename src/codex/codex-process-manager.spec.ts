/** Unattended startup-failure retry policy, without launching a real Codex binary. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CodexProcessManager,
  CodexStartupError,
  isCliNotInstalledStartupFailure,
} from './codex-process-manager.service';
import { catalogFixture } from './catalog/catalog.testing';
import type { SettingsService } from '../settings/settings.service';
import type { DocumentProtectionService } from '../document-publication/document-protection.service';
import { AGENT_ENVIRONMENT_LAUNCHER } from './agent-environment';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), cacheLauncher: false }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./agent-environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-environment')>();
  return {
    ...actual,
    agentEnvironmentCommand: (binary: string, args: string[]) =>
      actual.agentEnvironmentCommand(binary, args, mocks.cacheLauncher),
  };
});

/**
 * Builds a child stub that dies immediately, the way a transient spawn fault
 * looks: the handshake never completes and the process is gone.
 */
function failingChild(stderr = '') {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => {
    if (stderr) child.stderr.write(stderr);
    child.emit('close', 1, null);
  });
  return child;
}

describe('CodexProcessManager unattended start failures', () => {
  let fixture: ReturnType<typeof catalogFixture>;
  let manager: CodexProcessManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.cacheLauncher = false;
    fixture = catalogFixture();
    manager = new CodexProcessManager(fixture.storage, {
      getStringSetting: vi.fn(() => null),
    } as unknown as SettingsService);
    mocks.spawn.mockImplementation(() => failingChild());
  });

  it('recognizes an intentionally missing CLI as a non-transient startup state', () => {
    expect(
      isCliNotInstalledStartupFailure(
        new CodexStartupError(
          'Codex app-server exited before initialization',
          'Codex CLI is not installed. Open Administration > Codex CLI to install it.',
        ),
      ),
    ).toBe(true);
  });

  it('overrides a stale persisted MCP callback with the configured public URL', async () => {
    manager = new CodexProcessManager(fixture.storage, {
      getStringSetting: vi.fn(() => 'https://mergeron.example.com/'),
    } as unknown as SettingsService);

    await manager.onModuleInit();

    expect(mocks.spawn).toHaveBeenCalledWith(
      fixture.storage.paths.binary,
      [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'mcp_oauth_callback_url="https://mergeron.example.com/mcp/oauth/callback"',
        '-c',
        'mcp_oauth_callback_port=12345',
      ],
      expect.any(Object),
    );
  });

  afterEach(() => {
    manager.onModuleDestroy();
    vi.useRealTimers();
    fixture.cleanup();
    mocks.spawn.mockReset();
    vi.unstubAllEnvs();
  });

  it('runs the image cache launcher inside isolation with the sanitized environment', async () => {
    mocks.cacheLauncher = true;
    vi.stubEnv('WEBUI_API_KEY', 'private-canary');
    const plan = {
      home: fixture.home,
      databasePath: join(fixture.home, 'application.sqlite'),
      writableRoots: ['/workspaces/p'],
      publishedRoots: ['/workspaces/p/livrables'],
    };
    manager = new CodexProcessManager(
      fixture.storage,
      {
        getStringSetting: vi.fn(() => null),
      } as unknown as SettingsService,
      {
        plan: vi.fn().mockResolvedValue(plan),
      } as unknown as DocumentProtectionService,
    );
    await manager.onModuleInit();
    const [binary, args, options] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(binary).toBe('/usr/bin/bwrap');
    expect(args.slice(-6)).toEqual([
      '--',
      AGENT_ENVIRONMENT_LAUNCHER,
      fixture.storage.paths.binary,
      'app-server',
      '--listen',
      'stdio://',
    ]);
    expect(args.indexOf('/tmp')).toBeLessThan(
      args.indexOf(AGENT_ENVIRONMENT_LAUNCHER),
    );
    expect(options.env.WEBUI_API_KEY).toBeUndefined();
    expect(options.env.CODEX_HOME).toBe(fixture.home);
  });

  it('keeps retrying a transient first-boot failure instead of staying down', async () => {
    await manager.onModuleInit();

    expect(manager.getClient()).toBeNull();
    expect(manager.getStartupError()).not.toBeNull();
    const afterFirst = mocks.spawn.mock.calls.length;
    expect(afterFirst).toBe(1);

    // The 3s self-heal timer is the only thing standing between a late-mounting
    // volume and an app-server that never comes back without human action.
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('does not retry when the administrator must perform the first CLI installation', async () => {
    mocks.spawn.mockImplementation(() =>
      failingChild(
        'Codex CLI is not installed. Open Administration > Codex CLI to install it.',
      ),
    );

    await manager.onModuleInit();

    expect(manager.getStartupError()).toContain('Codex CLI is not installed');
    const attempts = mocks.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn.mock.calls.length).toBe(attempts);
  });

  it('stays down for a rejected catalog so a deterministic failure cannot loop', async () => {
    const catalog = join(fixture.paths.directory, 'catalog-a.json');
    writeFileSync(catalog, '{bad');
    fixture.storage.switchPointer(null, catalog);
    // Make the configured catalog unreadable so startup fails catalog-specifically.
    fixture.storage.switchPointer(catalog, join(fixture.home, 'missing.json'));

    await manager.onModuleInit();

    expect(manager.getStartupError()).toContain('model_catalog_json');
    const attempts = mocks.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn.mock.calls.length).toBe(attempts);
  });

  it('never spawns when pending-activation recovery refuses', async () => {
    // Recovery is what decides which catalog is legitimate after an interrupted
    // publish. Spawning anyway would load whichever file the crash left behind.
    vi.spyOn(fixture.storage, 'recoverPending').mockImplementation(() => {
      throw new Error('Catalog pointer changed externally');
    });

    await manager.onModuleInit();

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(manager.getStartupError()).toContain('changed externally');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('never auto-restarts a child this manager asked to stop', async () => {
    // A controlled stop that times out clears the `controlled` flag in its
    // `finally`. If the later exit were read through that flag it would look
    // like a crash, and the automatic restart would boot a candidate outside
    // the activation transaction — no acceptance, no rollback.
    const children: EventEmitter[] = [];
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      children.push(child);
      return child;
    });

    const started = manager.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    manager.suspendRetries();
    const attempts = mocks.spawn.mock.calls.length;
    children[0]?.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn.mock.calls.length).toBe(attempts);
  });

  it('resumes the withheld retry once the stuck child finally exits', async () => {
    // The gate defers a transient-failure retry while the old process may still
    // be alive. If it simply dropped it, a slow shutdown would turn a
    // self-healing fault into permanent downtime.
    let stuck: EventEmitter | undefined;
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      stuck ??= child;
      return child;
    });

    const started = manager.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    const attempts = mocks.spawn.mock.calls.length;

    stuck?.emit('close', 1, null);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(attempts);
  });

  it('does not replace a child that failed to shut down', async () => {
    // `stop()` timing out means the old process may still be alive; a second
    // app-server on the same Codex home is worse than staying down.
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      // Never emits 'close': destroy() cannot confirm the process is gone.
      return child;
    });

    const started = manager.onModuleInit();
    // The handshake times out first; only then does stop() start its own timer.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    // The shutdown timeout is logged, not promoted over the real cause: the
    // retained diagnostic is what classifies the failure, and replacing it with
    // "did not exit" would lose a catalog rejection and restart the retry loop.
    expect(manager.getStartupError()).toContain('timed out');
    const attempts = mocks.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn.mock.calls.length).toBe(attempts);
  });
});
