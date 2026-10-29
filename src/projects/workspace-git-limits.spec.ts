/** Runner limits stay bounded and return stable codes, not raw diagnostics. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceGitService } from './workspace-git.service';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

function child() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      process.emit('close', null, 'SIGKILL');
      return true;
    }),
  });
  return process;
}

describe('Git command limits', () => {
  const service = new WorkspaceGitService(null as never, null as never);
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.spawn.mockReset();
    // git() first reads filter names; this refusal means no filter configured.
    mocks.spawn.mockImplementationOnce(() => {
      const process = child();
      queueMicrotask(() => process.emit('close', 1));
      return process;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts exactly 1 MiB without extending the limit', async () => {
    const process = child();
    mocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        process.stdout.write(Buffer.alloc(1024 * 1024, 'a'));
        process.emit('close', 0);
      });
      return process;
    });
    expect(await service.git('/copy', ['status'])).toHaveLength(1024 * 1024);
    expect(process.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kills output above 1 MiB and distinguishes it from a timeout', async () => {
    const process = child();
    mocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => process.stdout.write(Buffer.alloc(1024 * 1024 + 1)));
      return process;
    });
    await expect(service.git('/copy', ['status'])).rejects.toThrow(
      'GIT_OUTPUT_LIMIT_EXCEEDED',
    );
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a timeout code and cleans its timer when a command stalls', async () => {
    const process = child();
    mocks.spawn.mockReturnValueOnce(process);
    const request = service.git('/copy', ['status'], {}, 25);
    const rejected = expect(request).rejects.toThrow('GIT_COMMAND_TIMEOUT');
    await vi.advanceTimersByTimeAsync(26);
    await rejected;
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps unknown stderr private rather than treating every failure as a limit', async () => {
    const process = child();
    mocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        process.stderr.write('secret-private-diagnostic');
        process.emit('close', 128);
      });
      return process;
    });
    await expect(service.git('/copy', ['status'])).rejects.toThrow(
      'Git inspection failed or exceeded its limit',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
