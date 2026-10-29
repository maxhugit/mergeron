import { describe, expect, it, vi } from 'vitest';
import { accessContext } from '../auth/access-context';
import { AgentTestProfileController } from './agent-test-profile.controller';

describe('test profile observation boundary', () => {
  it('does not query or mutate the engine without an administrator identity', async () => {
    const request = vi.fn();
    const controller = new AgentTestProfileController({ request } as never);
    expect(await controller.read('agent')).toEqual({ available: false });
    expect(request).not.toHaveBeenCalled();
  });
  it('checks identity/thread access and reads requirements only, never resumes or updates the conversation', async () => {
    const request = vi.fn().mockResolvedValue({ requirements: null });
    const requireActive = vi.fn(),
      requireThread = vi.fn();
    const controller = new AgentTestProfileController({ request } as never);
    await accessContext.run(
      {
        identity: { role: 'administrator' },
        identities: { requireActive, requireThread },
      } as never,
      () => controller.read('agent'),
    );
    expect(requireActive).toHaveBeenCalledOnce();
    expect(requireThread).toHaveBeenCalledWith(
      expect.anything(),
      'agent',
      'agent',
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'configRequirements/read',
      {},
    );
  });
});
