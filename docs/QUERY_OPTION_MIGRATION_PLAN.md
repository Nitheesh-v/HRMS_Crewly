# Mongoose `new:` option migration — build plan (owner boot log, 2026-10-09)

Owner's post-fix boot log shows the duplicate-index warnings gone and the API booting,
with one new deprecation: `the 'new' option for findOneAndUpdate() and
findOneAndReplace() is deprecated. Use returnDocument: 'after' instead.`

## A. Repository findings

- Installed Mongoose is **9.9.1**; the deprecation is emitted from `lib/query.js:3993`
  whenever a `findOneAndUpdate`-family query carries a `new` option. `findByIdAndUpdate`
  funnels into the same path, so its `new: true` warns too. Mongoose 10 will remove it.
- Corpus audit (Backend `src/` + `scripts/`): **81 code occurrences across 44 files**,
  every single one `new: true` (zero `new: false`), plus **4 documentation comments**
  teaching the old spelling (`PresenceTenantConfig.js:21`, `chatMessageService.js:12`,
  `chatMessageService.js:201`, `subscriptionLifecycle.js:21`).
- One site already carries both spellings — `bgvOperationsDashboardService.js:492`
  `{ upsert: true, returnDocument: 'after', new: true }` — the `new: true` is redundant
  but still warns, and a naive migration would create a duplicate object key.
- Zero `findOneAndReplace` call sites (one schema pre-hook exists solely to refuse it).
- Semantics are identical in Mongoose 9: `returnDocument: 'after'` returns the updated
  document exactly as `new: true` did (upsert, `runValidators`, `setDefaultsOnInsert`,
  `arrayFilters` and `.lean()` combinations unaffected).

## B. Security / data boundaries

- No route, controller, permission, tenant-visibility or data-model change. Every
  replacement is option-name-for-option-name on existing update queries; the documents
  returned (post-update versions) are unchanged.

## C. Implementation

1. Mechanical migration in all 44 files: `new: true` → `returnDocument: 'after'`;
   dedupe the one dual-option site; update the 4 comments so the docs teach the
   surviving spelling (comments stay truthful).
2. New hermetic suite `Backend/test/queryOptionHygiene.test.js`: corpus-wide zero-pin on
   `new: (true|false)` across `src/` + `scripts/` (comments included — Mongoose 10 will
   reject the option, so nothing may teach it), a floor pin on `returnDocument`
   occurrences, and a no-double-key pin.
3. `node --check` every migrated file (execution-grade syntax proof, per the
   server-import lesson).
4. Wire `test:query-hygiene` into `package.json` and append the suite to `test:all`.

## D. Test plan

- `test:query-hygiene` (hermetic, no DB) + bite proof (reintroduce one `new: true` →
  suite must fail → restore).
- Full backend `test:all` green.
- Owner-visible outcome: the deprecation line is gone from `npm run dev`.

## E. Environment / dependencies

- Zero new npm dependencies; no env changes; no frontend change. Mongoose stays 9.9.1.
- Not in scope (still awaiting authorization): the `errors` reserved-path warning from
  the payroll models.


---

## F. RESULTS

### Migrated
- **45 files** under `Backend/src`: `new: true` → `returnDocument: 'after'` — 80 plain
  sites, 1 dual-spelling site deduped (`bgvOperationsDashboardService.js`, whose leftover
  `new: true` was itself still warning), 4 documentation comments updated so nothing in
  the repo teaches the removed option (comments included in the guard on purpose).
- Corpus scan after migration: **zero** `new: (true|false)` across `src/` + `scripts/`.
- Two existing contract pins asserted the old spelling and were updated to the same
  intent under the new contract: `requisitionApproval.test.js` ("all decisions use an
  atomic tenant-and-status filter…") and `requisitionJobCreation.test.js` ("approved
  requisition creates one linked job…") now assert `options.returnDocument === 'after'`.
- New hermetic suite `test/queryOptionHygiene.test.js` (3 pins: corpus coverage floor,
  zero `new:` anywhere incl. comments, `returnDocument` adoption floor ≥ 80). Wired as
  `test:query-hygiene` and appended to `test:all`.

### Evidence
- Execution-grade: `node --check` → **45/45 migrated files pass**; real import of a
  migrated module loads; two contract-pin suites re-run green (16/16).
- Bite proof: planting a `new: true` probe file fails the suite with the exact
  guidance message; removing it restores 3/3.
- Full gate: backend `test:all` → **3359 tests / 178 suites / 0 fail** (3356 + 3).

### Process notes (harness bugs caught by verification, fixed before commit)
- The migration script initially reported success while never writing the one file whose
  only match was the dual-spelling site (a write-condition keyed on an approximate hit
  counter). Caught because the post-transform grep still showed 1 occurrence; fixed with
  a direct edit and the corpus scan now reads 0.
- A `node --check` loop ran from the wrong cwd and "failed" all 45 files with
  module-not-found (path bug, not syntax). Re-run from the repo root: 45/45 pass.

### Owner-visible outcome after pull + restart
- `npm run dev` no longer prints the `new`-option deprecation.
- Remaining known boot warning: the `errors` reserved-schema-path line from the payroll
  models — reported, awaiting your call (rename + migrate, or suppress on those schemas).
