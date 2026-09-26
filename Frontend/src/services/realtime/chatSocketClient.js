// PHASE 33.8 — CHAT SOCKET CLIENT (socket.io-client singleton)
// 33.14 — the handshake now carries a TICKET, not the customer JWT.
//
// Connects to the SAME ORIGIN through the dev/preview proxy
// (vite server.proxy['/socket.io'] -> backend), so browser code never
// hard-codes a host and never carries Redis knowledge.
//
// WHY A TICKET: the customer access token is an HttpOnly cookie now — no
// JavaScript can read it — and the socket handshake deliberately refuses
// cookies (33.1: a browser attaches a cookie automatically, which is exactly
// the cross-site WebSocket-hijacking surface this handshake must not have).
// So the page exchanges its cookie session for a 60-second ticket over
// ordinary authenticated HTTP, and presents THAT in the auth payload. A
// leaked ticket is worth nothing a minute later. The secret never rides the
// query string; the socket server still reads the auth payload only.
//
// Failure behaviour is bounded: a refused handshake (FEATURE_UNAVAILABLE =
// Redis down / chat disabled) closes the socket instead of retrying forever;
// an UNAUTHORIZED handshake (ticket outlived its minute, or the session was
// revoked) mints exactly ONE fresh ticket and lets the socket's own bounded
// retry use it. The UI shows the "realtime unavailable" banner and keeps
// working read-only through REST (33.4).

import { io } from 'socket.io-client';

import api from '../api.js';
import store from '../../redux/store.js';
import {
  realtimeStatusSet,
  messageCreated,
  messageUpdated,
  messageDeleted,
  reactionsUpdated,
  conversationsNudged,
} from '../../redux/slices/chatSlice.js';

const CHAT_TICKET_PATH = '/realtime/chat-ticket';

let socket = null;

/*
 * Lifecycle generation. The ticket is fetched over the network, so a page
 * that unmounts mid-fetch (or is remounted, as React StrictMode does) must
 * not be handed a socket nobody owns. Every connect records the generation it
 * started in and drops its result if the generation moved on.
 */
let lifecycleEpoch = 0;

/** One authenticated REST call → one short-lived ticket (or '' on refusal). */
const fetchChatTicket = async () => {
  try {
    const response = await api.post(CHAT_TICKET_PATH);

    // api.js already unwraps `data`; accept both shapes defensively so a
    // response-shape change cannot silently kill realtime.
    return (
      response?.ticket ||
      response?.data?.ticket ||
      response?.data?.data?.ticket ||
      ''
    );
  } catch {
    // Redis down, chat disabled, session gone — the caller shows the banner
    // and the page keeps working over REST.
    return '';
  }
};

export const connectChatSocket = async () => {
  if (socket) return socket;

  // The cookie is the session; the profile in the store is the only local
  // proof that there IS a signed-in user to open a socket for.
  if (!store.getState().auth?.user) return null;

  const epoch = lifecycleEpoch;

  const ticket = await fetchChatTicket();

  if (epoch !== lifecycleEpoch) return null; // unmounted while fetching
  if (socket) return socket; // a parallel call won the race

  if (!ticket) {
    store.dispatch(realtimeStatusSet('unavailable'));

    return null;
  }

  socket = io({
    path: '/socket.io',
    auth: { token: ticket },
    withCredentials: true,
    reconnectionAttempts: 6,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  // At most one ticket re-mint per connection cycle: a refused handshake
  // must never become an unbounded ticket-minting loop.
  let reminted = false;

  socket.on('connect', () => {
    reminted = false;
    store.dispatch(realtimeStatusSet('connected'));
  });

  socket.on('disconnect', () => store.dispatch(realtimeStatusSet('idle')));

  socket.on('connect_error', async (err) => {
    const message = String(err?.message ?? '');

    if (message.includes('FEATURE_UNAVAILABLE')) {
      store.dispatch(realtimeStatusSet('unavailable'));
      socket?.close(); // refused handshake: no infinite retry loop

      return;
    }

    if (message.includes('UNAUTHORIZED')) {
      /*
       * The ticket expired (60s) before the reconnect landed, or the session
       * was revoked. One fresh ticket is cheap and fixes the common case;
       * anything else is a real refusal and closes the socket.
       */
      if (!reminted) {
        reminted = true;

        const fresh = await fetchChatTicket();

        if (fresh && socket) {
          socket.auth = { token: fresh };

          return; // socket.io's own bounded retry re-handshakes with it
        }
      }

      store.dispatch(realtimeStatusSet('unavailable'));
      socket?.close();

      return;
    }

    // Transport-level outage: socket.io retries a bounded number of times.
    store.dispatch(realtimeStatusSet('unavailable'));
  });

  socket.on('chat:message:created', (payload) => store.dispatch(messageCreated(payload)));
  socket.on('chat:message:updated', (payload) => store.dispatch(messageUpdated(payload)));
  socket.on('chat:message:deleted', (payload) => store.dispatch(messageDeleted(payload)));

  // 34.1 — reactions arrive VIEWER-NEUTRAL (counts + who acted): one room
  // broadcast cannot carry a different `mine` for every member, so `mine` is
  // derived in the reducer from the actor id. The 60s ticket socket already
  // implies a signed-in profile, so the id is read defensively, never assumed.
  socket.on('chat:message:reactionsUpdated', (payload) => {
    const me = store.getState().auth?.user ?? null;

    store.dispatch(
      reactionsUpdated({
        ...payload,
        meId: me?._id ?? me?.id ?? null,
      })
    );
  });

  // 33.8-fix: data-less nudge — the conversation list changed server-side
  // (created/added/removed elsewhere). ChatPage refetches; Mongo stays truth.
  socket.on('chat:conversations:changed', () => store.dispatch(conversationsNudged()));

  return socket;
};

// 33.8-fix — bounded manual recovery. A refused handshake closes the socket
// by design (no infinite retry loop); once Redis / the API recovers, the
// banner's Retry button re-handshakes exactly once per click.
export const retryChatSocket = async () => {
  lifecycleEpoch += 1;

  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }

  return connectChatSocket();
};

export const disconnectChatSocket = () => {
  lifecycleEpoch += 1;

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
      if (settled) return;
      settled = true;

      // A half-dead transport (Redis lost server-side, laptop slept) looks
      // "connected" for a moment but never answers. Say what is true.
      if (!socket?.connected) {
        resolve({
          ok: false,
          code: 'FEATURE_UNAVAILABLE',
          message: 'Chat realtime is not connected.',
        });
        return;
      }

      resolve({ ok: false, code: 'RETRYABLE', message: 'The chat server did not answer. Try again.' });
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
  // 33.10 — FILE messages ride the same ACK contract as text; the ids were
  // already uploaded over REST, so nothing but references goes over the wire.
  sendFile: (payload) => ackOf('chat:message:sendFile', payload),
  edit: (payload) => ackOf('chat:message:edit', payload),
  remove: (payload) => ackOf('chat:message:delete', payload),
  readUpTo: (payload) => ackOf('chat:readUpTo', payload),
  // 34.1 — reactions ride the same ACK contract. The ACK carries the caller's
  // OWN state ({type,count,mine}) so a retry that changes nothing can still be
  // applied without waiting for a broadcast that will not come.
  react: (payload) => ackOf('chat:message:react', payload),
  unreact: (payload) => ackOf('chat:message:unreact', payload),
  isConnected: () => Boolean(socket?.connected),
};
