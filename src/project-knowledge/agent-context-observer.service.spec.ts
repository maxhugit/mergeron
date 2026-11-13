import { expect, it, vi } from 'vitest';
import { AgentContextObserverService } from './agent-context-observer.service';
import type { AgentContextService } from './agent-context.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';
it('invalidates on observed compaction and runtime replacement without claiming delivery', () => {
  let notify: (notification: ServerNotification) => void = () => {};
  let ready: (event: { type: string }) => void = () => {};
  const context = { invalidated: vi.fn(), invalidateSessions: vi.fn() };
  new AgentContextObserverService(
    {
      addListener: (_event: string, listener: typeof notify) => {
        notify = listener;
      },
      addLifecycleListener: (listener: typeof ready) => {
        ready = listener;
      },
    } as unknown as CodexProcessManager,
    context as unknown as AgentContextService,
  );
  notify({
    method: 'item/completed',
    params: {
      threadId: 'agent',
      turnId: 'turn',
      item: { type: 'contextCompaction', id: 'item' },
    },
  });
  expect(context.invalidated).toHaveBeenCalledWith('agent', 'compaction');
  ready({ type: 'appServerReady' });
  expect(context.invalidateSessions).toHaveBeenCalledOnce();
});
