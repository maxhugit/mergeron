import { existsSync, rmSync } from 'node:fs';
import { catalogFixture } from './catalog.testing';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

describe('disposable catalog home cleanup', () => {
  it('bounds retries for transient upstream Git cleanup races without hiding errors', () => {
    const fixture = catalogFixture();
    expect(existsSync(fixture.home)).toBe(true);
    fixture.cleanup();
    expect(rmSync).toHaveBeenLastCalledWith(fixture.home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    expect(existsSync(fixture.home)).toBe(false);
    fixture.cleanup();
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('persistent cleanup failure'), {
        code: 'ENOTEMPTY',
      });
    });
    expect(() => fixture.cleanup()).toThrow('persistent cleanup failure');
  });
});
