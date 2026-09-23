// PHASE 33.8 — CHAT SOCKET CLIENT (socket.io-client singleton)
//
// Connects to the SAME ORIGIN through the dev/preview proxy
// (vite server.proxy['/socket.io'] -> backend), so browser code never
// hard-codes a host and never carries Redis knowledge. The tenant JWT goes
// in the handshake AUTH payload only — never the query string, never a
// header, never a log line.
//
// Failure behaviour is bounded: a refused handshake (FEATURE_UNAVAILABLE =
// Redis down / chat disabled, UNAUTHORIZED = bad token) closes the socket
// instead of retrying forever; the UI shows the "realtime unavailable"
// banner and keeps working read-only through REST (33.4).

import { io } from 'socket.io-client';

import store from '../../redux/store.js';
import {
  realtimeStatusSet,
  messageCreated,
  messageUpdated,
  messageDeleted,
} from '../../redux/slices/chatSlice.js';

let socket = null;

export const connectChatSocket = () => {
  if (socket) return socket;

  const token = store.getState().auth?.token;

  if (!token) return null;

  socket = io({
    path: '/socket.io',
    auth: { token },
    reconnectionAttempts: 6,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect', () => store.dispatch(realtimeStatusSet('connected')));

  socket.on('disconnect', () => store.dispatch(realtimeStatusSet('idle')));

  socket.on('connect_error', (err) => {
    const message = String(err?.message ?? '');

    if (message.includes('FEATURE_UNAVAILABLE') || message.includes('UNAUTHORIZED')) {
      store.dispatch(realtimeStatusSet('unavailable'));
      socket?.close(); // refused handshake: no infinite retry loop

      return;
    }

    // Transport-level outage: socket.io retries a bounded number of times.
    store.dispatch(realtimeStatusSet('unavailable'));
  });

  socket.on('chat:message:created', (payload) => store.dispatch(messageCreated(payload)));
  socket.on('chat:message:updated', (payload) => store.dispatch(messageUpdated(payload)));
  socket.on('chat:message:deleted', (payload) => store.dispatch(messageDeleted(payload)));

  return socket;
};

export const disconnectChatSocket = () => {
  if (!socket) return;

  socket.removeAllListeners();
  socket.close();
  socket = null;
  store.dispatch(realtimeStatusSet('idle'));
};

// ACK-as-promise with a bounded timeout; a silent server can never hang
// the composer. Never logs payload content.
const ackOf = (event, payload, timeoutMs = 10_000) =>
  new Promise((resolve) => {
    if (!socket?.connected) {
      resolve({
        ok: false,
        code: 'FEATURE_UNAVAILABLE',
        message: 'Chat realtime is not connected.',
      });

      return;
    }

    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, code: 'RETRYABLE', message: 'The chat server did not answer. Try again.' });
      }
    }, timeoutMs);

    socket.emit(event, payload, (ack) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ack ?? { ok: false, code: 'RETRYABLE', message: 'Empty acknowledgement.' });
    });
  });

export const chatRealtime = {
  join: (conversationId) => ackOf('chat:join', { conversationId }),
  leave: (conversationId) => ackOf('chat:leave', { conversationId }),
  send: (payload) => ackOf('chat:message:send', payload),
  edit: (payload) => ackOf('chat:message:edit', payload),
  remove: (payload) => ackOf('chat:message:delete', payload),
  readUpTo: (payload) => ackOf('chat:readUpTo', payload),
  isConnected: () => Boolean(socket?.connected),
};
