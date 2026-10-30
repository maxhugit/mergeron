import { beforeEach, expect, it, vi } from 'vitest';
import { invalidateThreadEpoch } from '@/lib/thread-recovery-epoch';
const socket = vi.hoisted(() => ({
  connected: true,
  id: 'connection-1',
  emit: vi.fn(),
  timeout: vi.fn(),
}));
vi.mock('@/socket', () => ({ getSocket: () => socket }));
import { useTimelineStore as timeline } from './timeline-store';
import { useAgentViewCacheStore } from './agent-view-cache-store';
const pristine = timeline.getState();
beforeEach(() => {
  timeline.setState(pristine, true);
  useAgentViewCacheStore.getState().clear();
  socket.connected = true;
  socket.id = 'connection-1';
  socket.emit
    .mockReset()
    .mockImplementation((_event, _payload, ack) => ack?.(null, { ok: true }));
  socket.timeout.mockReturnValue(socket);
});
it('retains only opted-in rooms and keeps background output on its own agent', async () => {
  await timeline.getState().setActiveThread('a');
  timeline.getState().setRetainedThreads(['a', 'b']);
  await timeline.getState().setActiveThread('b');
  expect([...timeline.getState().subscribedThreadIds]).toEqual(['a', 'b']);
  timeline
    .getState()
    .addSystemMessageForThread('a', 'background output', 'info');
  expect(timeline.getState().threadId).toBe('b');
  expect(timeline.getState().getThreadRuntime('a')?.timeline).toHaveLength(1);
  expect(timeline.getState().getThreadRuntime('b')?.timeline).toHaveLength(0);
  timeline.getState().setRetainedThreads([]);
  expect([...timeline.getState().subscribedThreadIds]).toEqual(['b']);
  expect([...timeline.getState().confirmedThreadIds]).toEqual(['b']);
});
it('normal navigation leaves the previous room and reuses only confirmed joins', async () => {
  await timeline.getState().setActiveThread('a');
  socket.emit.mockClear();
  await timeline.getState().setActiveThread('a');
  expect(socket.emit).not.toHaveBeenCalled();
  await timeline.getState().setActiveThread('b');
  expect([...timeline.getState().subscribedThreadIds]).toEqual(['b']);
  expect(socket.emit).toHaveBeenCalledWith('thread.unsubscribe', {
    threadId: 'a',
  });
});
it.each(['left', 'connection', 'epoch', 'disconnected'])(
  'rejects a late join acknowledgement after %s changes',
  async (change) => {
    socket.emit.mockImplementation(() => {});
    const joined = timeline.getState().setActiveThread('a');
    const ack = socket.emit.mock.calls[0][2];
    if (change === 'left') timeline.getState().unsubscribeThread('a');
    if (change === 'connection') socket.id = 'connection-2';
    if (change === 'epoch') invalidateThreadEpoch('a');
    if (change === 'disconnected') socket.connected = false;
    ack(null, { ok: true });
    expect(await joined).toBe(false);
    expect(timeline.getState().confirmedThreadIds.has('a')).toBe(false);
  },
);
it('clears confirmations on disconnect and confirms rejoined retained rooms before repair', async () => {
  await timeline.getState().setActiveThread('a');
  timeline.getState().setRetainedThreads(['a']);
  await timeline.getState().setActiveThread('b');
  timeline.getState().clearConfirmedThreads();
  const repaired = vi.fn();
  socket.emit.mockImplementation((_event, _payload, ack) =>
    ack?.({ ok: true }),
  );
  timeline.getState().resubscribeAll(repaired);
  expect([...timeline.getState().confirmedThreadIds]).toEqual(['a', 'b']);
  expect(repaired.mock.calls).toEqual([['a'], ['b']]);
  timeline.getState().forgetThreads(['a']);
  expect(timeline.getState().retainedThreadIds.has('a')).toBe(false);
  expect(timeline.getState().confirmedThreadIds.has('a')).toBe(false);
  expect(timeline.getState().getThreadRuntime('a')).toBeNull();
});

it('rejects an acknowledgement from an old lease even after the same room is desired again', async () => {
  socket.emit.mockImplementation(() => {});
  const first = timeline.getState().setActiveThread('a');
  const oldAck = socket.emit.mock.calls[0][2];
  timeline.getState().unsubscribeThread('a');
  socket.emit.mockClear();
  const second = timeline.getState().setActiveThread('a');
  const newAck = socket.emit.mock.calls[0][2];
  oldAck(null, { ok: true });
  expect(await first).toBe(false);
  expect(timeline.getState().confirmedThreadIds.has('a')).toBe(false);
  newAck(null, { ok: true });
  expect(await second).toBe(true);
});
