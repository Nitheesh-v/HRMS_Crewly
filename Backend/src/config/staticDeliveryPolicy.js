// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.16 — STATIC DELIVERY & CACHE-CONTROL POLICY (provider-neutral)
//
// Single source of truth for how Crewly content classes are allowed to be
// cached. Two ownership tiers are honest about who enforces what:
//
//   CREWLY           — enforced by this repo's code (API default middleware,
//                      private-file controllers, SSE route) and pinned by
//                      test/deploymentConfig + staticDelivery tests.
//   FUTURE_CDN_HOST  — Crewly does not serve static assets in production;
//                      these rows are the CONTRACT any future CDN/static
//                      host must implement. No vendor is selected; these
//                      values are requirements, never configuration.
//
// See docs/PHASE_32_16_CDN_EDGE_STATIC_DELIVERY.md for the full contract.
// ═══════════════════════════════════════════════════════════════════════════

export const HEADER_OWNERSHIP = Object.freeze({
  CREWLY: 'CREWLY',
  FUTURE_CDN_HOST: 'FUTURE_CDN_HOST',
});

// Default for EVERY /api/* response (middlewares/apiCachePolicy.js).
// Explicit controller headers (e.g. the existing `private, no-store,
// max-age=0` family) win over this default by setting it again later.
export const API_CACHE_POLICY_DEFAULT = 'private, no-store, max-age=0';

// The provider-neutral matrix. Values here are assertions tests pin and
// documentation quotes — not provider configuration.
export const STATIC_DELIVERY_POLICY = Object.freeze({
  INDEX_HTML: Object.freeze({
    cacheControl: 'no-cache',
    ownership: HEADER_OWNERSHIP.FUTURE_CDN_HOST,
    rationale:
      'index.html references the CURRENT content-hashed asset names. ' +
      'Never immutable/year-long: a cached-away HTML pins users to old ' +
      'chunks or breaks on missing new ones. Revalidate every navigation.',
  }),
  HASHED_STATIC_ASSET: Object.freeze({
    cacheControl: 'public, max-age=31536000, immutable',
    ownership: HEADER_OWNERSHIP.FUTURE_CDN_HOST,
    rationale:
      'Vite content hashes: changed content ⇒ different URL, so aggressive ' +
      'caching can never serve stale code for a given URL.',
  }),
  PUBLIC_VERSIONED_ASSET: Object.freeze({
    cacheControl: 'public, max-age=31536000, immutable',
    ownership: HEADER_OWNERSHIP.FUTURE_CDN_HOST,
    rationale:
      'Intentionally-public images/fonts ONLY when their URL carries a ' +
      'version/hash. Mutable-at-same-URL content must NOT use this row.',
  }),
  PUBLIC_NON_VERSIONED_ASSET: Object.freeze({
    cacheControl: 'public, max-age=3600',
    ownership: HEADER_OWNERSHIP.FUTURE_CDN_HOST,
    rationale:
      'favicon/icons/logos served at stable paths may change without a URL ' +
      'change — short cache with revalidation, never immutable. (Crewly ' +
      'public/ today: favicon.png, favicon.svg, icons.svg, logo-crewly.png.)',
  }),
  AUTHENTICATED_API: Object.freeze({
    cacheControl: API_CACHE_POLICY_DEFAULT,
    ownership: HEADER_OWNERSHIP.CREWLY,
    rationale:
      'Default-deny for all /api/* responses. A shared cache serving ' +
      'Company A data to Company B is a severe incident; absence of a ' +
      'Cache-Control header is NOT a safe contract (heuristic/shared ' +
      'caching is possible). Routes may only override with an equally ' +
      'private policy.',
  }),
  PRIVATE_FILE: Object.freeze({
    cacheControl: API_CACHE_POLICY_DEFAULT,
    ownership: HEADER_OWNERSHIP.CREWLY,
    rationale:
      'Payslips, BGV evidence/reports, resumes, offers, employee documents, ' +
      'exports: never public/shared-cacheable, never immutable. 32.8 ' +
      'private storage is preserved; a CDN must never become their origin.',
  }),
  SECURE_TOKEN_ROUTE: Object.freeze({
    cacheControl: API_CACHE_POLICY_DEFAULT,
    ownership: HEADER_OWNERSHIP.CREWLY,
    rationale:
      'Offer/pre-onboarding/BGV-consent token portals are reachable without ' +
      'login but are NOT public content. No shared caching; raw tokens are ' +
      'never cache keys and must not leak into edge logs.',
  }),
  REALTIME_STREAM: Object.freeze({
    cacheControl: 'no-store',
    ownership: HEADER_OWNERSHIP.CREWLY,
    rationale:
      '32.11 SSE: authenticated per-user stream. Never buffered by proxies ' +
      '(X-Accel-Buffering: no already set), never cached, never routed to ' +
      'a static origin.',
  }),
  PUBLIC_API_OPT_IN: Object.freeze({
    cacheControl: null, // deliberately undecided — see rationale
    ownership: HEADER_OWNERSHIP.CREWLY,
    rationale:
      'Public careers content could someday carry a short public max-age, ' +
      'but job data changes, rate-limit semantics and per-company branding ' +
      'make a blanket policy wrong. Until a specific safe contract is ' +
      'designed and approved, public API routes stay under the default-deny.',
  }),
});

export const STATIC_DELIVERY_CATEGORIES = Object.freeze(
  Object.keys(STATIC_DELIVERY_POLICY),
);

export const staticDeliveryHeaderFor = (category) =>
  STATIC_DELIVERY_POLICY[category]?.cacheControl ?? null;
