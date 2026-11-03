import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { AgentProjectObserverService } from './agent-project-observer.service';
import { makeThreadFixture } from './threads.testing';
it('passes native thread creation notifications to the project membership boundary', () => {
  const events = new EventEmitter(),
    observe = vi.fn();
  new AgentProjectObserverService(events as never, { observe } as never);
  const thread = makeThreadFixture({ id: 'new', cwd: '/p' });
  events.emit('notification', { method: 'thread/started', params: { thread } });
  events.emit('notification', {
    method: 'turn/started',
    params: { threadId: 'new' },
  });
  expect(observe).toHaveBeenCalledExactlyOnceWith(thread);
});
