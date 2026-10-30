/**
 * Socket.io client singleton for real-time Codex events.
 */
import { io, Socket } from 'socket.io-client';
import { getApiToken } from './auth-token';
import { withBasePath } from './base-path';
import { isSessionPaused } from './lib/session-recovery';

let socket: Socket | null = null;
let suspended = false;

export function getSocket(): Socket {
  if (!socket) {
    socket = io('/ws', {
      path: withBasePath('/socket.io'),
      transports: ['websocket'],
      autoConnect: !isSessionPaused(),
      auth: (callback) => {
        callback({ token: getApiToken() ?? '' });
      },
    });
  }
  if (isSessionPaused()) suspended = true;
  else if (!socket.connected) {
    if (suspended) socket.sendBuffer.length = 0;
    suspended = false;
    socket.connect();
  }
  return socket;
}

window.addEventListener('codex-webui:session-paused', () => {
  if (!socket) return;
  suspended = true;
  socket.disconnect();
  // Disconnected Socket.IO emits must never become delayed user mutations.
  socket.sendBuffer.length = 0;
});

/** Disconnects and recreates the socket (e.g. after login with new token). */
export function resetSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
