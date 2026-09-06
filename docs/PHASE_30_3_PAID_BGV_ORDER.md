# Phase 30.3 — Paid BGV Request / Order

## What this phase delivers

Tenant HR can now **purchase BGV services** for a candidate whose Phase 30.1
decision is `INITIATE BGV`: select one or more of the five ACTIVE +
CONFIGURED catalogue services, review the server-priced order, pay through
the existing Razorpay (or TEST MODE) architecture, and end with a **PAID
BGV order** — the commercial prerequisite for Phase 30.4.

**This phase stops at paid-order readiness.** No candidate consent token, no
candidate email, no document upload, no verifier assignment. The UI says
explicitly: consent collection is part of the next workflow step.

## Entry gate (backend-enforced)

Purchase is reachable ONLY from a legitimate 30.1 decision — the backend
re-validates independently of any frontend button:

- candidate must be tenant-owned (`req.companyId`; other-tenant refs are a
  clean 404, no existence leak);
- candidate stage must be post-selection (`POST_SELECTION_STAGES`);
- `bgvDecision.status` must be `BGV_INITIATED`
  (`PROCEEDED_WITHOUT_BGV` → 409 conflict; `NONE` → 400);
- selection must be 1–5 of the five known types, no duplicates, no sixth
  service;
- every selected type must exist in the catalogue AND be `active: true`.

## Price authority

- The request body may contain **only** `{ selected: [...] }`. Any client
  money key (`price`, `unitPrice`, `total`, `amount`, `currency`, …) is
  rejected by both the express-validator layer and the service
  (defense in depth).
- At creation the service re-reads the ACTIVE Phase 30.2 catalogue
  (`getCatalogueView`) and snapshots, per item: `type`, `name`,
  `description`, `unitPriceMinorUnits` (paise, INR), `currency`,
  `catalogueVersion`. `totalMinorUnits` is the server-computed sum.
- The snapshot is **schema-immutable** (`items`, `totalMinorUnits`,
  `currency`, `companyId` carry `immutable: true`). Later 30.2 price changes
  never rewrite a historical order (hermetically tested).
- Frontend totals are display-only; the checkout uses the server amount.

## Order model (`Backend/src/models/BgvOrder.js`)

| Field | Notes |
| --- | --- |
| `orderCode` | `BGVORD-000042` via `TenantSequence` key `BGV_ORDER` (same convention as BGV case codes — never `Date.now`/`Math.random`) |
| `status` | `CREATED → PENDING_PAYMENT → PAID / PAYMENT_FAILED`; `CREATED/PENDING_PAYMENT → CANCELLED`; `EXPIRED` reserved (no auto-expiry in 30.3) |
| `openKey` | `'OPEN'` while CREATED/PENDING_PAYMENT/**PAID**, `null` when PAYMENT_FAILED/CANCELLED/EXPIRED |
| payment fields | `gateway` (`razorpay`\|`mock`), `providerOrderId`, `gatewayPaymentId`, `failureReason`, `paidAt` — mirrors the existing billing `Payment` architecture |

**Duplicate protection is DB-backed**: a partial unique index on
`(companyId, candidate, openKey='OPEN')` means at most one open order per
candidate. Double-clicks/double tabs get the existing order back
(`reused: true`); a concurrent insert race that hits the unique index is
caught (code 11000) and returns the winner. A PAID order keeps the block —
revisiting shows the paid order, never a second payable one.
Failed/cancelled orders release the candidate for a fresh order.

## Payment flow (reuses the billing architecture)

1. `POST /api/recruitment/bgv-orders/:orderId/payment/initiate` — the SERVER
   creates the provider order with the SERVER amount (`totalMinorUnits` is
   already paise). Without Razorpay keys the order runs on the `mock`
   gateway (TEST MODE simulator, same pattern as billing). Retry reuses the
   same provider order — never creates two. A provider outage leaves the
   order payable (`CREATED`).
2. The existing Razorpay checkout opens with the publishable `keyId` only.
   `RAZORPAY_KEY_SECRET` never leaves the backend, is never logged, and
   never appears in Vite code.
3. `POST .../payment/verify` — the server verifies
   `HMAC-SHA256(secret, providerOrderId|razorpay_payment_id)` itself
   (timing-safe compare). Mock confirms are honoured ONLY on mock-gateway
   orders. A frontend "paid" claim means nothing.
4. Success performs an **atomic conditional transition** to `PAID`
   (`findOneAndUpdate` with `status ∈ {CREATED, PENDING_PAYMENT}`), so a
   duplicated callback/retry replays the authoritative state idempotently —
   no second audit, no snapshot mutation. We do NOT claim exactly-once
   webhooks; Mongo state is the truth.
5. Verification failure moves the order to `PAYMENT_FAILED` (fail-closed;
   never PAID) and releases the candidate for a retry order.

## 27.15 relationship

The order references the candidate and persists who/tenant/order/checks for
Phase 30.4. It does **not** create or mutate a 27.15 `BackgroundVerificationCase`,
does not touch the pipeline/stage, and does not generate consent. The tenant
BGV policy (settings) stays separate from the purchase.

## Routes (tenant, under `/api/recruitment`)

| Route | Permission |
| --- | --- |
| `GET /bgv-purchase/services` | `BACKGROUND_VERIFICATION_READ` (tenant-safe ACTIVE catalogue projection — not the platform mutation surface) |
| `POST /candidates/:candidateId/bgv-order` | `checkWriteAccess` + `BACKGROUND_VERIFICATION_MANAGE` |
| `GET /candidates/:candidateId/bgv-order` | `BACKGROUND_VERIFICATION_READ` |
| `POST /bgv-orders/:orderId/payment/initiate` | `checkWriteAccess` + `BACKGROUND_VERIFICATION_MANAGE` |
| `POST /bgv-orders/:orderId/payment/verify` | `checkWriteAccess` + `BACKGROUND_VERIFICATION_MANAGE` |
| `POST /bgv-orders/:orderId/cancel` | `checkWriteAccess` + `BACKGROUND_VERIFICATION_MANAGE` |

No new permission and no `SYSTEM_PERMISSION_VERSION` bump: the same HR
personas that hold the 30.1 decision already carry these.

## Frontend

`BgvPurchasePanel.jsx` renders inside the candidate BGV panel (30.1 flow),
gated on `BACKGROUND_VERIFICATION_MANAGE`:

- **Selection** — checkboxes for purchasable services with indicative totals
  (display-only, labelled "server confirms the final amount").
- **Review/pay** — order card with immutable snapshot + `Proceed to
  payment` / `Cancel order`.
- **Payment** — real Razorpay checkout, or the TEST MODE simulator when no
  keys are configured (same UX as billing; dismiss is safe, the order stays
  pending and retry works).
- **Confirmation** — PAID card with paid timestamp and the "consent in the
  next workflow step" copy.
- All states: loading, no-active-services, not-eligible hint, error,
  cancelled, failed, retry. Every view re-reads Mongo on mount — refresh or
  resume never double-charges.

## Tests

`Backend/test/bgvOrder.test.js` — 34 hermetic tests (no Mongo, no Redis, no
Razorpay network): eligibility gates, tamper rejection, server totals,
snapshot immutability (schema + store-level), duplicate/concurrent create,
provider amount assertion, forged/invalid signature rejection, real-HMAC
success with a dummy in-process secret, duplicate-callback idempotency,
fail-closed states, cancel semantics, tenant isolation, audit-safety, and
30.4 scope absence.

## Files

Backend: `models/BgvOrder.js`, `services/bgv/bgvOrderRules.js`,
`services/bgv/bgvOrderService.js`, `controllers/bgvOrderController.js`,
`validators/backgroundVerificationValidator.js` (order rules +
`rejectClientMoney`), `routes/recruitmentRoutes.js` (6 routes),
`utils/bgvIdentifiers.js` (`nextBgvOrderCode`), `package.json`
(`test:bgv-order`, `test:all`).

Frontend: `services/bgvService.js` (6 methods),
`components/recruitment/BgvPurchasePanel.jsx`,
`components/recruitment/CandidateBgvPanel.jsx` (integration).

Docs: this file.

## Deliberately NOT in this phase (30.4+)

Consent token/link, candidate email, document upload, verifier assignment,
BGV case creation from a paid order, auto-expiry worker, refunds.
