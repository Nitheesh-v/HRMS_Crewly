# Reserved-schema-path warning — build plan (owner authorized correction, 2026-10-09)

Owner's boot log still shows `` `errors` is a reserved schema pathname and may break
some functionality `` after the index and query-option cleanups, and asked for it to be
corrected. This is the previously-deferred payroll-adjacent unit, now authorized.

## A. Repository findings

- The warning fires from `mongoose/lib/schema.js` (~line 1310): a schema path's first
  piece is a reserved name (`errors` collides with `Document#errors`, where Mongoose
  surfaces validation errors) and the schema lacks `suppressReservedKeysWarning`.
- **Sole source: `PayrollPaymentBatch.js` `excludedSchema`** — its `errors:
  [String]` holds the machine-readable exclusion reason codes the UI renders. Proven by
  per-model isolation: `PayrollPaymentBatch` alone → 1 warning; `PayrollRun` alone →
  **0 warnings**. (Correction to `DUPLICATE_INDEX_FIX_PLAN.md`, which had listed
  `PayrollRun.progress.errors` / `summary.errors` as sources: plain-nested object paths
  never hit Mongoose's reserved check — the earlier attribution came from a two-model
  experiment where Node's one-warning-per-process dedupe hid the culprit.)
- A whole-registry sweep: **exactly one** offending schema across all 135 models; no
  schema is built outside `src/models`.
- The field is deliberate data, actively used by the payment service and rendered by the
  frontend. Renaming (`reasonCodes`) would ripple model → service → API payload →
  frontend plus a `$rename` migration over `payrollpaymentbatches` — for zero behaviour
  change, in the money domain.

## B. Security / data boundaries

- No data change, no API change, no permission/visibility change. Documents keep the
  `errors` field exactly as stored today.

## C. Implementation

1. `PayrollPaymentBatch.js` `excludedSchema`: add the documented opt-out
   `suppressReservedKeysWarning: true` beside `_id: false`, with a comment recording why
   the name is deliberate and when a rename should be revisited.
2. New hermetic suite `test/reservedSchemaPath.test.js`: warning listener attached
   before any model import; registering all models must emit **zero** reserved-path
   warnings; `suppressReservedKeysWarning` must appear in exactly one model file (the
   flag may not spread silently).
3. Wire into `test:schema-hygiene` (combined with `schemaIndexHygiene`) and `test:all`.

## D. Test plan

- New suite green; bite proof (pre-fix model → the no-warning pin AND the scoped-flag
  pin both fail; fixed model → green).
- `payrollPayment` suite (the field's domain tests) + full backend `test:all` green.
- Owner-visible outcome: the `errors` line is gone from `npm run dev` — making the boot
  log completely warning-free.

## E. Environment / dependencies

- Zero new npm dependencies; no env changes; no frontend change; no data migration.

---

## F. RESULTS

- `excludedSchema` now carries the flag with its reasoning comment; the model registers
  with **0 warnings** in isolation, and a sweep of all 135 models produces **zero
  process warnings of any kind**.
- `test/reservedSchemaPath.test.js`: registry floor (≥130 models + directory count),
  zero reserved-path warnings, and the one-file scoping of the suppression flag.
  Combined `test:schema-hygiene` → 8/8.
- Bite proof: reverting the model to its pre-fix state fails exactly the two new pins
  (2 fail / 6 pass); restoring → 8/8.
- Gates: `payrollPayment` 32/32; backend `test:all` → **3362 tests / 178 suites /
  0 fail** (3359 + 3).
- Process notes: the `package.json` wiring first anchored on a stale tail assertion and
  a bite-proof used `git checkout` against uncommitted work, which briefly wiped the
  fix — caught immediately by the follow-up grep, redone with `/tmp` copies. Recorded
  so the pattern (verify after every transform; never `checkout` uncommitted work)
  stays explicit.
- Renaming the field remains a documented future option if a real `Document#errors`
  collision ever appears in this subdocument — no evidence of one today.
