/** Real Socket.IO buffer, with connection establishment stubbed at the network boundary. */
import { afterEach, expect, it, vi } from 'vitest';
import { Socket } from 'socket.io-client';
import { getSocket, resetSocket } from '@/socket';
import {
  acceptVerifiedSession,
  installSessionRecovery,
  pauseSession,
} from './session-recovery';

let dispose: (() => void) | undefined;
afterEach(() => {
  resetSocket();
  dispose?.();
  vi.restoreAllMocks();
});

it('does not connect while verifying and drops queued emits before the verified connection resumes', () => {
  const connect = vi.spyOn(Socket.prototype, 'connect').mockReturnThis();
  dispose = installSessionRecovery();
  const socket = getSocket();
  expect(connect).not.toHaveBeenCalled();
  socket.emit('do.not.replay', { change: 'old' });
  expect(socket.sendBuffer).toHaveLength(1);
  const identity = {
    kind: 'person' as const,
    personId: 'p',
    name: 'Person',
    role: 'administrator' as const,
    active: true,
  };
  acceptVerifiedSession(identity);
  expect(getSocket()).toBe(socket);
  expect(connect).toHaveBeenCalledOnce();
  expect(socket.sendBuffer).toHaveLength(0);
  pauseSession();
  socket.emit('do.not.replay', { change: 'another' });
  acceptVerifiedSession(identity);
  getSocket();
  expect(socket.sendBuffer).toHaveLength(0);
  expect(connect).toHaveBeenCalledTimes(2);
});
