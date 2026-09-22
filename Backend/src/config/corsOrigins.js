// ============================================================
//  SHARED CORS ORIGIN ALLOWLIST (Express app + Socket.IO gateway)
//
//  ONE source of truth for "which browser origins may talk to this
//  API instance". The Express CORS layer and the Socket.IO handshake
//  must agree: two divergent allowlists would let a socket connect
//  from an origin the REST API refuses (or the reverse).
//
//  Rules (unchanged from the original app.js implementation):
//   - no Origin header  → allowed (Postman, mobile apps, server-to-server)
//   - configured CLIENT_URL entries (comma-separated) → allowed
//   - Arena live-preview hostnames in NON-production only
//   - everything else   → refused
//
//  Extracted (Phase 33.1A) so the socket gateway reuses the exact same
//  decision instead of copying it. Behaviour is byte-identical.
// ============================================================
import env from './env.js';

export const configuredOrigins = String(env.CLIENT_URL || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

export const originAllowed = (origin) => {
  // Requests from Postman, mobile clients and internal services.
  if (!origin) return true;

  const normalizedOrigin = origin.replace(/\/$/, '');

  if (configuredOrigins.includes(normalizedOrigin)) {
    return true;
  }

  // Arena live-preview support in development only.
  if (
    env.NODE_ENV !== 'production' &&
    /^https:\/\/\d+-[a-z0-9-]+\.e2b\.app$/i.test(
      normalizedOrigin,
    )
  ) {
    return true;
  }

  return false;
};

export default originAllowed;
