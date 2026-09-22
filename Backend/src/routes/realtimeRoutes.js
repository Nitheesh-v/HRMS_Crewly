// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.11 — REALTIME HTTP SURFACE (minimal, infrastructure-only)
//
// Exactly two endpoints — nothing more (§36: no broadcast/publish/connections
// debug surface exists):
//
//   POST /api/realtime/ticket  — normal authenticated HTTP (JWT in the
//       Authorization header via `protect`; tenant server-derived via
//       `tenantContext`). Issues a single-use 30s realtime ticket bound to
//       the VERIFIED identity. Kiosk-device and employee-context tokens
//       carry no user subject and can never pass `protect`; this endpoint
//       additionally refuses anything that is not a plain user session.
//
//   GET  /api/realtime/stream?ticket=… — the SSE stream. EventSource cannot
//       send headers, so the ONE-TIME ticket rides the URL (opaque, 30s,
//       single-use — tradeoff documented in realtimeTickets.js). Identity
//       is taken ONLY from the shared ticket store — a client can never
//       choose its tenant/user (§15). Origin allowlist (same CLIENT_URL
//       source as app.js CORS) is defense-in-depth, never authorization.
//
// No import-time side effects (§86): both handlers check the gateway state
// and fail safely when realtime is disabled or draining.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from 'express';
import env from '../config/env.js';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { getRealtimeGateway } from '../infrastructure/realtime/realtimeGateway.js';
import { getRealtimeTickets } from '../infrastructure/realtime/realtimeTicketsRuntime.js';
import { isValidTicketShape } from '../infrastructure/realtime/realtimeTickets.js';

const router = Router();

// Same origin allowlist source as app.js CORS (re-derived here to avoid an
// import cycle routes→app). Defense-in-depth only — never authorization.
const originAllowed = (origin) => {
  if (!origin) return true; // same-origin/non-browser clients send no Origin
  const configuredOrigins = String(env.CLIENT_URL || '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const normalized = String(origin).replace(/\/$/, '');
  if (configuredOrigins.includes(normalized)) return true;
  // Development-only Arena preview support, mirroring app.js.
  if (env.NODE_ENV !== 'production' && /^https:\/\/\d+-[a-z0-9-]+\.e2b\.app$/i.test(normalized)) {
    return true;
  }
  return false;
};

/**
 * POST /api/realtime/ticket — authenticated ticket issuance.
 * Body is intentionally ignored: identity comes from the verified token.
 */
router.post(
  '/ticket',
  protect,
  tenantContext,
  asyncHandler(async (req, res) => {
    const gateway = getRealtimeGateway();

    if (!gateway.isStarted()) {
      throw new ApiError(503, 'Realtime is not available');
    }

    // Belt-and-braces principal gate: only plain customer user sessions
    // may hold a realtime ticket (protect already refuses verifier +
    // subject-less kiosk tokens).
    const principal = req.user?.principalType;
    if (principal && principal !== 'USER') {
      throw ApiError.unauthorized('Invalid token for this portal');
    }
    if (!req.user?._id || !req.companyId) {
      throw ApiError.unauthorized('Invalid session identity');
    }

    // Kiosk tokens cannot reach here (no user subject), but a user token
    // must also never BE a kiosk-typed token if signing ever changes.
    if (req.user?.typ === 'kiosk') {
      throw ApiError.unauthorized('Invalid token for this portal');
    }

    const tickets = getRealtimeTickets();
    const issued = await tickets.issue({ userId: String(req.user._id), companyId: String(req.companyId) });

    return ApiResponse.success(res, {
      message: 'Realtime ticket issued',
      data: issued, // { ticket, expiresInSeconds }
    });
  })
);

/**
 * GET /api/realtime/stream?ticket=… — the SSE connection.
 * Fails closed and GENERICALLY (no account/tenant/token internals, §32/§49).
 */
router.get(
  '/stream',
  asyncHandler(async (req, res) => {
    const gateway = getRealtimeGateway();

    if (!gateway.isStarted()) {
      throw new ApiError(503, 'Realtime is not available');
    }

    if (!originAllowed(req.headers.origin)) {
      throw ApiError.forbidden('Origin not allowed');
    }

    const ticket = req.query.ticket;
    const identity = await getRealtimeTickets().consume(ticket);

    // Generic refusal: invalid/expired/replayed/shared-store-down are
    // indistinguishable to the caller (no enumeration oracle).
    if (!identity) {
      throw ApiError.unauthorized('Realtime ticket is not valid');
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // future proxy law: never buffer streams
    });
    res.flushHeaders?.();
    res.write('retry: 5000\n\n'); // bounded client reconnect hint

    const admission = gateway.admitStream({
      companyId: identity.companyId,
      userId: identity.userId,
      res,
    });

    // Admission refusal (process/user stream cap) already ended the
    // response with a bounded 503 inside admitStream.
    if (!admission.ok) {
      return;
    }

    // Response stays open until client disconnect or gateway drain; the
    // route promise resolves on 'close' so nothing leaks per connection.
    await new Promise((resolve) => {
      res.on('close', resolve);
    });
  })
);

export default router;
