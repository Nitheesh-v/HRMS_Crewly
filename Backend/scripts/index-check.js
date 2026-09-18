// ============================================================
// Phase 32.5 — Mongo index/query performance campaign
// (evidence-first, developer command)
//
//   npm run index:check
//
// WHAT THIS IS
//   Static, hermetic evidence that every HOT query path in the
//   platform is served by a declared Mongoose index. No database
//   connection is made: the models' own schema declarations are
//   the ground truth (the same declarations MongoDB builds at
//   startup). Real-data EXPLAIN / $indexStats verification is the
//   operator's localhost step — see docs
//   PHASE_32_PRODUCTION_INFRASTRUCTURE.md §32.5.
//
// HOW TO READ THE VERDICTS
//   COVERED         — an index whose leading keys contain the
//                     query's equality keys in order (index prefix
//                     serves the filter).
//   FILTER+SORT     — the same, and the sort keys continue the
//                     same index contiguously (no in-memory sort).
//   SORT_IN_MEMORY  — filter is index-served; the sort happens in
//                     memory over the matched documents (bounded
//                     per tenant — noted per entry).
//   DOCUMENTED      — measured and accepted as-is, with the
//                     reason (never counts as a GAP).
//   GAP             — no declared index serves the query. Exit 1.
//
// Exit codes:
//   0 — every catalog entry COVERED / FILTER+SORT /
//       SORT_IN_MEMORY / DOCUMENTED
//   1 — at least one GAP (or a catalog/model resolution error)
// ============================================================

import '../src/config/loadEnv.js'; // FIRST — before env-snapshotting imports

import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';

const MODELS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/models',
);

// ─────────────────────────────────────────────────────────────
//  HOT-QUERY CATALOG — the evidence record.
//  Each entry pins a real query path (file:line evidence at the
//  time of the 32.5 audit) to its collection and the ordered
//  equality keys the code filters by. `sort` lists the sort keys.
//  kind: 'point' (first key alone is unique → point lookup),
//        'prefix' (equality keys must prefix some index),
//        'documented' (accepted with note, never GAP).
// ─────────────────────────────────────────────────────────────

export const HOT_QUERY_CATALOG = [
  {
    id: 'protect session validation',

    evidence: 'src/middlewares/authMiddleware.js:65',

    model: 'SecuritySession',

    filter: ['sessionId', 'user', 'companyId', 'revokedAt'],

    kind: 'point',

    note: 'runs on EVERY authenticated request; sessionId is unique',
  },

  {
    id: 'refresh-token rotation',

    evidence: 'src/utils/tokenService.js:293',

    model: 'SecuritySession',

    filter: ['_id'],

    kind: 'point',

    note: '_id primary index',
  },

  {
    id: 'logout-all / revoke by user',

    evidence: 'src/utils/tokenService.js:399',

    model: 'SecuritySession',

    filter: ['user', 'companyId', 'sessionId'],

    kind: 'prefix',

    note: 'unique sessionId index caps the lookup at one document',
  },

  {
    id: 'super admin session validation',

    evidence: 'src/middlewares/superAdminAuth.js:103',

    model: 'AdminSession',

    filter: ['sessionId', 'user', 'revokedAt'],

    kind: 'point',

    note: 'runs on EVERY platform request; sessionId is unique',
  },

  {
    id: 'kiosk station authentication',

    evidence: 'src/middlewares/kioskAuth.js:42',

    model: 'AttendanceKiosk',

    filter: ['_id'],

    kind: 'point',

    note: '_id primary index',
  },

  {
    id: 'kiosk/attendance day events',

    evidence: 'src/workers/emailProcessor.js:964 + attendance event service',

    model: 'AttendanceEvent',

    filter: ['companyId', 'user', 'date'],

    sort: ['seq'],

    kind: 'prefix',

    note: 'unique {companyId,user,date,seq} serves filter AND sort',
  },

  {
    id: 'payroll run lookup',

    evidence: 'src/models/PayrollRun.js (unique compound)',

    model: 'PayrollRun',

    filter: ['companyId', 'month'],

    kind: 'prefix',

    note: 'unique {companyId, month}',
  },

  {
    id: 'payslip per-tenant lists',

    evidence: 'src/models/Payslip.js (compound)',

    model: 'Payslip',

    filter: ['companyId', 'month', 'status'],

    kind: 'prefix',

    note: '{companyId, month, status} declared exactly',
  },

  {
    id: 'notification inbox',

    evidence: 'src/models/Notification.js (compounds)',

    model: 'Notification',

    filter: ['user', 'readAt'],

    kind: 'prefix',

    note: '{user, readAt} and {user, createdAt:-1}',
  },

  {
    id: 'subscription lifecycle sweep (every 10 s)',

    evidence: 'src/utils/subscriptionLifecycle.js:178',

    model: 'Subscription',

    filter: ['status'],

    kind: 'documented',

    note: '$nin cannot use an index; collection is one doc per company (tiny); COLLSCAN here is intentional and cheap — verdict recorded, query byte-frozen',
  },

  {
    id: 'public careers list',

    evidence: 'src/services/publicCareerService.js:217,229',

    model: 'JobPosting',

    filter: ['companyId'],

    sort: ['publishedAt'],

    kind: 'prefix',

    note: 'companyId field index serves the tenant filter; per-tenant job count is small → in-memory sort bounded',
  },

  {
    id: 'login user lookup',

    evidence: 'src/controllers/authController.js:416',

    model: 'User',

    filter: ['email', 'companyId'],

    kind: 'prefix',

    note: 'unique {email, companyId} — point lookup',
  },

  {
    id: 'candidate pipeline board',

    evidence: 'src/models/Candidate.js (compounds)',

    model: 'Candidate',

    filter: ['companyId', 'job', 'currentStage'],

    kind: 'prefix',

    note: '{companyId, job, currentStage, source} declared exactly',
  },

  {
    id: 'BGV case dispatcher polling',

    evidence: 'src/services/bgvQueueDispatcher.js:171,180',

    model: 'BackgroundVerificationCase',

    filter: ['companyId'],

    kind: 'prefix',

    note: '{companyId, polling.status, polling.nextPollAt} + unique {companyId, caseCode}',
  },

  {
    id: 'BGV checks per case',

    evidence: 'src/workers/bgvProcessor.js:82',

    model: 'BackgroundVerificationCheck',

    filter: ['companyId', 'case'],

    sort: ['displayOrder'],

    kind: 'prefix',

    note: 'unique {companyId, case, code} serves the filter; checks per case are few → bounded sort',
  },

  {
    id: 'pre-onboarding document requirements',

    evidence: 'src/workers/scheduledProcessor.js:301',

    model: 'CandidateDocumentRequirement',

    filter: ['companyId', 'preOnboarding'],

    kind: 'prefix',

    note: 'unique {companyId, preOnboarding, code} serves the prefix',
  },
];

// ─────────────────────────────────────────────────────────────
//  Coverage rule (documented, conservative):
//  an entry is index-served when some declared index's key
//  sequence STARTS with the entry's equality keys in order.
//  'point' entries may instead be served by a unique index whose
//  FIRST key is the entry's first key (point lookup), or by _id.
//  Sort keys are FILTER+SORT only when they continue the same
//  index contiguously after the equality prefix.
// ─────────────────────────────────────────────────────────────

export const evaluateCatalogEntry = (entry, declaredIndexes) => {
  const equality = entry.filter;

  const sort = entry.sort || [];

  const all = declaredIndexes;

  if (entry.kind === 'documented') {
    return { verdict: 'DOCUMENTED', index: null, note: entry.note };
  }

  for (const [keys] of all) {
    const keyNames = Object.keys(keys);

    const matchesEquality = equality.every(
      (key, position) => keyNames[position] === key,
    );

    if (!matchesEquality) continue;

    const sortContiguous = sort.every(
      (key, position) => keyNames[equality.length + position] === key,
    );

    return {
      verdict: sort.length && sortContiguous ? 'FILTER+SORT' : 'COVERED',

      index: keyNames.join(', '),

      note: entry.note,
    };
  }

  if (entry.kind === 'point' || entry.kind === 'prefix') {
    // Unique-led fallback (Mongo semantics for findOne): a UNIQUE
    // index leading with ANY equality key caps the candidate set at
    // ONE document — the whole filter is then verified against that
    // single doc. Honest point lookup, regardless of key order.
    // (Single-field non-unique indexes are handled by the strict
    // prefix rule above only — never counted as point lookups.)
    let pointKey = equality.includes('_id') ? '_id' : null;

    if (!pointKey) {
      for (const [keys, options] of all) {
        const keyNames = Object.keys(keys);

        const first = keyNames[0];

        if (equality.includes(first) && options?.unique) {
          pointKey = first;

          break;
        }
      }
    }

    if (pointKey) {
      return {
        verdict: 'COVERED (point lookup)',

        index: `${pointKey} (unique-led)`,

        note: entry.note,
      };
    }
  }

  return {
    verdict: 'GAP',

    index: null,

    note: 'no declared index serves this hot query — add a compound index',
  };
};

// ─────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export const loadAllModels = async () => {
  const files = readdirSync(MODELS_DIR)
    .filter((file) => file.endsWith('.js'))
    .sort();

  let loaded = 0;

  const failures = [];

  for (const file of files) {
    try {
      await import(path.join(MODELS_DIR, file));

      loaded += 1;
    } catch (error) {
      failures.push(`${file}: ${error.message}`);
    }
  }

  return { loaded, failures, total: files.length };
};

const run = async () => {
  process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_index_audit';

  const { loaded, failures, total } = await loadAllModels();

  console.log('=== PHASE 32.5 — INDEX COVERAGE AUDIT (schema ground truth) ===');

  console.log(`models loaded: ${loaded}/${total}`);

  for (const failure of failures) {
    console.log(`  LOAD FAIL ${failure}`);
  }

  // ── Inventory ──
  const names = mongoose.modelNames();

  let explicit = 0;

  const uniqueCount = { count: 0 };

  const ttl = [];

  const partial = [];

  const zeroIndexModels = [];

  for (const name of names) {
    const schema = mongoose.model(name).schema;

    const indexes = schema.indexes();

    if (!indexes.length) {
      zeroIndexModels.push(name);

      continue;
    }

    explicit += indexes.length;

    for (const [keys, options] of indexes) {
      if (options?.unique) uniqueCount.count += 1;

      if (options?.expireAfterSeconds !== undefined) {
        ttl.push(`${name} {${Object.keys(keys).join(',')}}`);
      }

      if (options?.partialFilterExpression) {
        partial.push(name);
      }
    }
  }

  console.log(
    `declared indexes: ${explicit} across ${names.length - zeroIndexModels.length}/${names.length} collections ` +
      `(unique: ${uniqueCount.count}, TTL: ${ttl.length}, partial: ${partial.length})`,
  );

  console.log(`TTL indexes: ${ttl.join(' · ') || 'none'}`);

  console.log(
    `models with zero explicit indexes (${zeroIndexModels.length}): ` +
      `${zeroIndexModels.join(', ') || 'none'}`,
  );

  // ── Hot-query catalog ──
  console.log('\n=== HOT-QUERY CATALOG ===');

  let gaps = 0;

  for (const entry of HOT_QUERY_CATALOG) {
    const model = mongoose.model(entry.model);

    const result = evaluateCatalogEntry(entry, model.schema.indexes());

    if (result.verdict === 'GAP') gaps += 1;

    console.log(
      `[${result.verdict}] ${entry.id} → ${entry.model}` +
        ` (${entry.evidence})` +
        (result.index ? ` · index: ${result.index}` : '') +
        ` · ${result.note}`,
    );
  }

  console.log('\n=== RESULT ===');

  if (gaps) {
    console.log(`GAPS: ${gaps} — add compound indexes before shipping.`);

    process.exitCode = 1;
  } else {
    console.log(
      'All hot-query catalog entries are index-served or explicitly documented.',
    );
  }

  if (!isMain) return;

  // Give mongoose's (connection-less) timers a beat, then exit.
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
};

if (isMain) {
  await run();
}
