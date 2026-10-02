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
import { resolveSocketUrl } from './socketUrl.js';
import {
  realtimeStatusSet,
  messageCreated,
  messageUpdated,
  messageDeleted,
  reactionsUpdated,
  conversationsNudged,
  typingChanged,
  typingExpired,
  typingCleared,
} from '../../redux/slices/chatSlice.js';

const CHAT_TICKET_PATH = '/realtime/chat-ticket';

/*
 * 34.5 — the receiving side of typing.
 *
 * TYPING_TTL_MS is a MISSED-FRAME deadline, not a presence window: if the stop
 * frame never arrives (laptop closed mid-sentence, network died), the indicator
 * must expire on its own rather than claim someone is still typing forever. The
 * sender heartbeats every 3 s (see ChatPage), so a live typist keeps refreshing
 * well inside this window.
 *
 * Nothing here is stored: one timer per (conversation, user) in a module-level
 * map, cleared on every frame for that pair, cleared wholesale on disconnect —
 * and a page reload starts from empty.
 */
const TYPING_TTL_MS = 5000;

const typingTimers = new Map();

const clearTypingTimer = (key) => {
  const timer = typingTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    typingTimers.delete(key);
  }
};

const clearAllTypingTimers = () => {
  for (const timer of typingTimers.values()) clearTimeout(timer);

  typingTimers.clear();
};

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

  // 36.8 — the socket follows the API, not the page. With no URL the client
  // connects to `window.location.origin`, which is right for the Vite proxy
  // and wrong the moment the SPA is served from a different host than the
  // API: the handshake is refused and chat silently becomes read-only. See
  // ./socketUrl.js for why the origin is derived from VITE_API_URL instead
  // of being configured a second time.
  const socketUrl = resolveSocketUrl();

  const socketOptions = {
    path: '/socket.io',
    auth: { token: ticket },

    // 36.9 — NO COOKIES ON THE SOCKET, AND THAT IS NOT ONLY THE 33.1 LAW,
    // IT IS THE CORS CONTRACT TOO.
    //
    // The handshake authenticates from `auth.token` (a 60-second chat
    // ticket minted over authenticated REST). It never reads a cookie —
    // socketAuth.js says so in its header, and the 33.1 "no cookies on
    // sockets" decision is a locked one. So this flag was not merely
    // unnecessary, it was the bug: the server's Engine.IO `cors` option is
    // `credentials: false` (pinned by chatSocketFoundation.test.js), and a
    // request sent with `withCredentials: true` makes the browser DEMAND
    // `Access-Control-Allow-Credentials: true`. A server that refuses to
    // send it means the browser drops every cross-origin polling response.
    //
    // Why this was invisible on localhost: behind the Vite proxy the socket
    // is SAME-ORIGIN, and same-origin requests are never CORS-checked, so a
    // credentials mismatch cannot surface. Deploy the SPA and the API on
    // different hosts and it is the first thing that breaks — a wall of
    // "CORS error" on /socket.io/?EIO=4&transport=polling while every REST
    // call beside it returns 200.
    //
    // False matches every other non-cookie service in this repo
    // (offerService, preOnboardingService, the public portals). The ticket
    // fetch that precedes this still uses the cookie session, because THAT
    // call is an ordinary authenticated REST request.
    withCredentials: false,

    reconnectionAttempts: 6,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  };

  // An explicit URL is passed as the first argument; omitting it keeps the
  // same-origin behaviour the Vite proxy already serves in development.
  socket = socketUrl ? io(socketUrl, socketOptions) : io(socketOptions);

  // At most one ticket re-mint per connection cycle: a refused handshake
  // must never become an unbounded ticket-minting loop.
  let reminted = false;

  socket.on('connect', () => {
    reminted = false;
    store.dispatch(realtimeStatusSet('connected'));
  });

  socket.on('disconnect', () => {
    // 34.5 — a dropped transport invalidates every indicator: they were claims
    // about frames we can no longer receive, and the stop for each one is never
    // coming. Clear them and their timers with the connection.
    clearAllTypingTimers();
    store.dispatch(typingCleared({}));
    store.dispatch(realtimeStatusSet('idle'));
  });

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

  // 34.5 — typing. The frame carries three fields and no content; it is applied
  // to the store and given a TTL so a lost stop cannot strand the indicator.
  socket.on('chat:typing', (payload) => {
    const conversationId = String(payload?.conversationId ?? '');
    const userId = String(payload?.userId ?? '');
    const isTyping = payload?.isTyping === true;

    if (!conversationId || !userId) return;

    const key = `${conversationId}:${userId}`;

    clearTypingTimer(key);

    store.dispatch(typingChanged({ conversationId, userId, isTyping }));

    if (isTyping) {
      typingTimers.set(
        key,
        setTimeout(() => {
          typingTimers.delete(key);
          store.dispatch(typingExpired({ conversationId, userId }));
        }, TYPING_TTL_MS)
      );
    }
  });

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
  // 34.5 — the socket that carried those indicators is gone, so the claims go
  // with it (and no stray timer can fire into a dead page).
  clearAllTypingTimers();
  store.dispatch(typingCleared({}));
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
  // 34.5 — typing. Fire-and-forget in spirit: the ACK is still awaited by the
  // caller (so a refusal is visible in the console during acceptance), but the
  // UI never blocks on it and the server response `{relayed:false}` is a
  // legitimate outcome (throttled frame), not an error.
  typingStart: (payload) => ackOf('chat:typing:start', payload),
  typingStop: (payload) => ackOf('chat:typing:stop', payload),
  isConnected: () => Boolean(socket?.connected),
};
