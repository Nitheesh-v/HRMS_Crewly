# PHASE 30.2 — BGV SERVICE CATALOGUE & PRICING

Super Admin manages Crewly's five internal BGV services and their pricing.
Phase 30.1 (optional BGV decision) remains unchanged; 30.3 (orders/payment)
is NOT implemented.

## The five products (backend allowlist only)

`IDENTITY`, `ADDRESS`, `EDUCATION`, `EMPLOYMENT`, `REFERENCE`
(`services/bgv/bgvCatalogueRules.js`). Criminal/court/watchlist/PEP/credit/
medical/drug/licence are absent by design. The frontend can display or submit
only these five; unknown types are rejected before any DB work.

## Architecture (Design A)

- Fixed product definitions (names/descriptions) live in the pure rules
  module; MongoDB stores only commercial configuration in
  `BgvServiceCatalogue` (platform-scoped, **no companyId**):
  `type` (unique index), `displayName`, `description`, `priceMinorUnits`
  (integer paise, 0..10,000,000), `currency` ('INR'), `active`, `version`,
  `updatedBy`, timestamps.
- **No seeding.** Absence of a row = *unconfigured* = not purchasable.
  First-time configuration happens exclusively through the Super Admin UI/API.
- Money: integer minor units only; `parsePriceToMinorUnits`/`formatMinorUnits`
  use string/integer math (no floats). Zero price is an explicit supported
  rule (free product); negative/NaN/Infinity/malformed/over-cap rejected.
  Legacy billing stores whole rupees and multiplies by 100 at the Razorpay
  boundary — 30.3 maps minor units to that boundary losslessly.
- Concurrency: unique `type` index + atomic `findOneAndUpdate` upsert with
  pipeline `$inc`-style version bump → duplicate rows impossible; version is
  copied into future order snapshots.
- Deactivation: `active:false` hides the product from NEW purchases
  (`resolveActivePrice` returns null); the row and all historical data stay.

## Historical price boundary (for 30.3)

Orders must SNAPSHOT `{ type, priceMinorUnits, currency, version }` from
`resolveActivePrice()` at purchase time and must never treat the live
catalogue document as their historical amount. 30.2 implements the resolver
only; no orders, no Razorpay, no tenant-facing price endpoint yet (§12:
deferred to 30.3).

## API (platform-only)

- `GET  /api/super-admin/bgv-catalogue` — `permit('bgv-catalog:read')`
- `PATCH /api/super-admin/bgv-catalogue/:type` — `permit('bgv-catalog:manage')`

New platform permissions `bgv-catalog:read` / `bgv-catalog:manage` granted to
`BILLING_ADMIN`; `SUPER_ADMIN` via `'*'`. `PLATFORM_ADMIN`/`SUPPORT_ADMIN`
have neither. Tenant roles are rejected by `superAdminSession` with 403
*before* any platform DB access (tested). Tenant company RBAC is not used for
this platform operation. `SYSTEM_PERMISSION_VERSION` untouched (tenant-only).

## Audit

`SystemEvent` type `BGV_CATALOGUE_UPDATED` (enum extended additively) on
configure/update/activate/deactivate with safe metadata: action, serviceType,
actorId, previous/next `{priceMinorUnits, active, version}`. No secrets, no
payment credentials, no candidate data.

## UI

Super Admin nav → **BGV Services** (`/super-admin/bgv-services`, roles
SUPER_ADMIN + BILLING_ADMIN). Table: Service / Status (Not configured /
Active / Inactive) / Price / Currency / Last updated / Actions
(Configure | Edit). Modal editor: price (₹, ≤2 decimals), description,
active toggle, backend validation errors, saving state, success banner,
refresh. Loading/error/empty states present. Page icons are Lucide with
readable labels (the layout's nav glyph follows the existing emoji-string
convention of SuperAdminLayout).

## Cache / queues

Deferred deliberately: no Redis cache and no BullMQ queue introduced
(§17/§18). Mongo is the source of truth; read volume is tiny.

## Testing

- `npm run test:bgv-catalogue` — 16 hermetic tests (rules, DI service,
  platform gate fakes): five-types-only, unknown type rejected, first-time
  config + price-required, duplicate prevention, price update, malformed/
  negative/over-cap rejection, currency rejection, activation/deactivation
  with data retention, audit metadata, response field allowlist, unique
  index, permission map, permit pass/deny, tenant 403 at gate.
- In `test:all`; full suite at delivery: **846/846**.
- Live MongoDB-dependent validation: BLOCKED / NOT RUN in Arena.

## Manual acceptance

See delivery report: `http://localhost:5173/super-admin/bgv-services`
with a SUPER_ADMIN login; Tests A–F (catalogue view, first-time
configuration, price update incl. invalid values, activate/deactivate,
permission boundary, 30.1 regression).

## Limitations

No orders/payment (30.3), no candidate consent (30.4), no verifier accounts
(30.6), no tenant-facing price API, no cache, no queue.
