# Duplicate schema-index warnings — build plan (owner boot log, 2026-10-09)

Owner's `npm run dev` boot log printed two `Duplicate schema index on {"companyId":1}`
warnings (models `PayrollSetup` and `AttendancePolicy`), one `errors` reserved-schema-path
warning, and a permission line reading "(v36)" while the code ships version 38.
This plan covers the index defect (the real problem), the lying log line, and the
reserved-path report.

## A. Repository findings

- Both models index `companyId` **twice**:
  - field-level `index: true` → registers a plain `{companyId:1}` index, FIRST in
    declaration order, and
  - an explicit `schema.index({ companyId: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } })`
    — same key pattern, SECOND.
- Mongoose (`lib/model.js` `_ensureIndexes`, gh-15056) creates indexes **one at a time in
  declaration order** and only *warns* on the duplicate. The second `createIndex` then
  collides with the first (both default to the index name `companyId_1`, options differ →
  `IndexOptionsConflict`), and that failure is emitted as model `index`/`error` events
  nobody listens to. Silent.
- **Consequence:** on any database ever built by this code, the plain `{companyId:1}`
  index exists and the partial-unique "one CURRENT row per tenant" index does **not** —
  the invariant the models' own comments promise ("One CURRENT configuration per tenant",
  "Exactly one current policy per company") was never enforced by MongoDB. Only service
  code guarded it.
- A sweep of all **135 registered models** finds exactly **2** duplicate key-pattern
  groups — the two the owner saw. Nothing else in the registry carries this defect.
- `server.js:71` hardcodes `(v36)` in the permission-catalogue log while
  `SYSTEM_PERMISSION_VERSION` is **38** — the boot log lies about the catalogue version.
- Reserved-path warning sources (payroll domain — **reported, not touched** by this plan):
  `PayrollPaymentBatch.js` `excludedSchema.errors: [String]`, `PayrollRun.js`
  `progress.errors` and `summary.errors` (Number counters). All are plain data fields on
  subdocuments that have worked in production; renaming them is a payroll data change and
  needs separate authorization.
- No existing test pins `index: true` on these two fields or either model's index list
  (`payrollSetup.test.js` / `attendancePolicy.test.js` contain no index pins).

## B. Security / data boundaries

- No routes, controllers, permissions, or tenant-visibility code change. The repair
  *restores* a tenant-level DB constraint that was designed into these models; it adds or
  relaxes nothing.
- The one-time DB repair is run by the owner against their own cluster; no credentials and
  no connection strings are stored in the repo or printed in logs.

## C. Implementation

1. `src/models/PayrollSetup.js` and `src/models/AttendancePolicy.js`: remove `index: true`
   from the `companyId` field so the explicit partial-unique index becomes the single
   authority on `{companyId:1}`; leave a one-line comment explaining why the field carries
   no index flag.
2. `src/server.js`: log `getSystemPermissionVersion()` instead of the hardcoded `v36`.
3. New hermetic regression test `Backend/test/schemaIndexHygiene.test.js` (no database):
   - sweeps every registered model: no two unnamed indexes may share a key pattern — the
     exact condition behind the Mongoose warning, now a test failure instead of a boot-time
     whisper;
   - pins `PayrollSetup` and `AttendancePolicy` to exactly one `{companyId:1}` index
     carrying `unique: true` + `partialFilterExpression: { isCurrent: true }`;
   - pins the boot log to the real catalogue version (no hardcoded `(vNN)`).
4. **Owner one-time DB repair** (their cluster, not code — see §F for commands): verify no
   existing `isCurrent` duplicates would violate the new index, drop the stale plain
   `companyId_1` from both collections, restart the API so autoIndex builds the
   partial-unique index, confirm with `getIndexes()`.

## D. Test plan

- New suite `schemaIndexHygiene.test.js` — hermetic (model registry only, no Mongo).
- Targeted regression: `payrollSetup`, `attendancePolicy`, `payrollEngine`,
  `employeePayroll` suites.
- Full backend `test:all` must stay green.
- Owner-visible outcome: both "Duplicate schema index" warnings gone at boot; after the §C.4
  repair, both collections show the unique+partial index; the permission line reports the
  real version (v38).

## E. Environment / dependencies

- Zero new npm dependencies; no env vars; no frontend change. Mongoose dedupe/conflict
  behavior verified against the installed version's own source.


---

## F. RESULTS

### Changed
- `src/models/PayrollSetup.js`, `src/models/AttendancePolicy.js` — `index: true` removed
  from `companyId`; the explicit partial-unique index is now the single `{companyId:1}`
  declaration, with a comment explaining why the field must stay flag-free.
- `src/server.js` — the permission-catalogue line interpolates
  `getSystemPermissionVersion()`; the hardcoded `(v36)` (wrong since the catalogue bumped
  to v38) is gone.
- `package.json` — `test:schema-hygiene` script; suite appended to `test:all`.
- `test/schemaIndexHygiene.test.js` — **new, 5 pins, hermetic**: registry-wide
  duplicate-key-pattern sweep (135 models), one-CURRENT-row-per-tenant pins for both
  models, and the no-hardcoded-version pin.

### Evidence
- Mongoose mechanics verified against the installed source (`lib/model.js`
  `_ensureIndexes`, gh-15056): indexes build **one at a time in declaration order**, the
  duplicate is only warned about, and the losing build dies with `IndexOptionsConflict`
  (both patterns default to the index name `companyId_1`) — a failure swallowed as an
  unlistened model `index` event. Field-level registration put the plain index first, so
  MongoDB received the plain index and **never the UNIQUE constraint**.
- Registry sweep: exactly 2 duplicate key-pattern groups across 135 models — the two the
  owner's boot log named; nothing else latent.
- Bite proof: the new suite fails **3/5** against the pushed (old) models and passes
  **5/5** against the fixed ones.
- Gates: backend `test:all` → **3356 tests / 178 suites / 0 fail** (3351 + 5).
- Sandbox note: the first full run dropped 16 suites with instant `MONGO_URI` exit-1s —
  the gitignored `Backend/.env` scaffolding had been lost to a sandbox re-clone; recreated
  with dummy values (never committed), after which all 16 passed alone (418/418) and in
  the full run. Owner localhost is unaffected (real `.env` present).

### Owner one-time DB repair (required once — code cannot undo an already-built index)
The stale plain `companyId_1` blocks the partial-unique build (same default name,
different options → IndexOptionsConflict). Against the cluster/database in the API's
`MONGO_URI`:

1. **Check for violations first** — both must return an empty result:
   ```js
   db.payrollsetups.aggregate([{ $match: { isCurrent: true } }, { $group: { _id: "$companyId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
   db.attendancepolicies.aggregate([{ $match: { isCurrent: true } }, { $group: { _id: "$companyId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
   ```
   If either returns rows: STOP and clean them up first — the unique index cannot build
   over a violation (the boot log would swallow that failure exactly like this one).
2. Drop the stale plain indexes:
   ```js
   db.payrollsetups.dropIndex("companyId_1")
   db.attendancepolicies.dropIndex("companyId_1")
   ```
3. Restart the API (autoIndex builds the partial-unique indexes) and verify:
   ```js
   db.payrollsetups.getIndexes()
   db.attendancepolicies.getIndexes()
   ```
   Each should list an entry with `unique: true, partialFilterExpression: { isCurrent: true }`.

### Reported, NOT changed (payroll domain — needs authorization)
> **Correction (2026-10-09, per-model isolation):** only
> `PayrollPaymentBatch.js` `excludedSchema.errors` actually emits the warning;
> `PayrollRun.js`'s plain-nested `progress.errors` / `summary.errors` never did (plain
> nested object paths don't reach Mongoose's reserved check). The original text below
> over-attributed because Node prints the identical warning once per process.

The `errors` reserved-schema-path warning comes from a payroll model using `errors` as a
plain data field (Mongoose reserves the name for validation errors):
`PayrollPaymentBatch.js` `excludedSchema.errors: [String]` (exclusion reason codes). They work today
because they are data-only subdocument fields. Options: (a) rename + one-time data
migration, or (b) `suppressReservedKeysWarning: true` on those schemas. Payroll is out of
bounds for this unit — say the word and it becomes its own small unit.

### Owner-visible outcome after pull + restart
- Both "Duplicate schema index" warnings gone.
- The permission line reports the real catalogue version (v38), not a hardcoded (v36).
- After the §F repair: both collections actually enforce one CURRENT row per tenant.
