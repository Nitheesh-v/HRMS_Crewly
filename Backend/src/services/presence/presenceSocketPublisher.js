// ═══════════════════════════════════════════════════════════════════════════
// PHASE 37 — PRESENCE SOCKET PUBLISHER
//
// Presence product events use the authenticated /presence Socket.IO
// namespace and its dedicated Redis adapter. They deliberately do not use
// the infrastructure-only SSE gateway (whose allowlist excludes product
// events). The publisher is a small lifecycle seam so REST mutations and
// socket-driven transitions share one transport without importing the
// Socket.IO server into the domain bus.
// ═══════════════════════════════════════════════════════════════════════════

import { presenceUserRoom } from '../../utils/presenceKeys.js';

let namespace = null;

export const bindPresenceSocketNamespace = (nextNamespace) => {
  namespace = nextNamespace || null;
};

export const unbindPresenceSocketNamespace = (expectedNamespace = null) => {
  if (!expectedNamespace || namespace === expectedNamespace) namespace = null;
};

export const isPresenceSocketPublisherReady = () =>
  Boolean(namespace && typeof namespace.to === 'function');

/**
 * Deliver a validated presence envelope to the server-derived user room.
 * Presence is private to the authenticated subject; the bounded team-page
 * REST refresh supplies authorized team rows without exposing out-of-scope
 * users through a tenant-wide socket room. Redis provides cross-instance
 * fan-out. No identity is taken from a client payload.
 */
export const emitPresenceSocketEvent = ({ event, companyId, envelope } = {}) => {
  if (!isPresenceSocketPublisherReady()) {
    return { ok: false, delivered: 'none', error: 'presence socket unavailable' };
  }
  if (
    typeof event !== 'string' ||
    !event ||
    !companyId ||
    !envelope ||
    !envelope.userId ||
    String(envelope.companyId) !== String(companyId)
  ) {
    return { ok: false, delivered: 'none', error: 'invalid presence event' };
  }

  try {
    namespace
      .to(presenceUserRoom(String(companyId), String(envelope.userId)))
      .emit(event, envelope);
    return { ok: true, delivered: 'socket.io', error: null };
  } catch {
    return { ok: false, delivered: 'none', error: 'presence socket publish failed' };
  }
};

// Narrow test seam. Tests inject a fake namespace; production only binds
// through createPresenceSocketServer.attach().
export const __setPresenceSocketNamespaceForTests = (nextNamespace) => {
  namespace = nextNamespace || null;
};

export const __resetPresenceSocketNamespaceForTests = () => {
  namespace = null;
};
