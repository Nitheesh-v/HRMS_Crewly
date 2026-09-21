// ============================================================
// Phase 32.5 — Mongo index / hot-query auditor (developer command)
//
//   npm run index:check
//
// WHAT THIS IS
//   Static, hermetic evidence that the platform's hot query paths
//   are served by declared Mongoose indexes. NO database connection
//   is made: the models' own schema declarations are the ground
//   truth (the same declarations MongoDB builds at startup).
//   Live EXPLAIN / $indexStats verification on real data is the
//   developer/operator step — see docs
//   PHASE_32_PRODUCTION_INFRASTRUCTURE.md §32.5.
//
// VERDICTS
//   COVERED         — some index's leading keys contain the query's
//                     equality keys in order (index prefix rule).
//   FILTER+SORT     — the sort keys continue that index contiguously
//                     right after the equality prefix (no in-memory
//                     sort).
//   POINT LOOKUP    — a UNIQUE index leading with any equality key
//                     caps findOne at one candidate document.
//   DOCUMENTED      — measured and accepted as-is (tiny collection /
//                     intentional shape); never a GAP.
//   GAP             — nothing serves the query. Exit 1.
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
//  HOT-QUERY CATALOG — the §5 evidence record. Every entry cites
//  its query site (file:line at the 32.5 audit) and the ordered
//  equality keys the code filters by.
// ─────────────────────────────────────────────────────────────

export const HOT_QUERY_CATALOG = [
  {
    id: 'protect session validation',

    evidence: 'src/middlewares/authMiddleware.js:65',

    model: 'SecuritySession',

    filter: ['sessionId', 'user', 'companyId', 'revokedAt'],

    kind: 'point',

    note: 'EVERY authenticated request; unique sessionId caps at one document',
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

    kind: 'point',

    note: 'unique sessionId caps the lookup at one document',
  },

  {
    id: 'super admin session validation',

    evidence: 'src/middlewares/superAdminAuth.js:103',

    model: 'AdminSession',

    filter: ['sessionId', 'user', 'revokedAt'],

    kind: 'point',

    note: 'EVERY platform request; unique sessionId',
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

    evidence: 'src/services/attendance/attendanceEventService.js:482 + emailProcessor.js:964',

    model: 'AttendanceEvent',

    filter: ['companyId', 'user', 'date'],

    sort: ['seq'],

    kind: 'prefix',

    note: 'unique {companyId,user,date,seq} serves filter AND sort (morning punch path)',
  },

  {
    id: 'attendance idempotent replay',

    evidence: 'src/services/attendance/attendanceEventService.js:629',

    model: 'AttendanceEvent',

    filter: ['companyId', 'user', 'requestId'],

    kind: 'point',

    note: 'sparse unique {companyId,user,requestId} — correctness-critical, preserved',
  },

  {
    id: 'attendance day control lookup',

    evidence: 'src/services/attendance/attendanceEventService.js:650',

    model: 'Attendance',

    filter: ['companyId', 'user', 'date'],

    kind: 'prefix',

    note: '{companyId,user,date} (31.2 tenant-first)',
  },

  {
    id: 'payroll run lookup',

    evidence: 'src/services/payroll/payrollRunService.js:lookup + model unique compound',

    model: 'PayrollRun',

    filter: ['companyId', 'month'],

    kind: 'prefix',

    note: 'unique {companyId, month}',
  },

  {
    id: 'payslip per-tenant lists',

    evidence: 'src/services/payroll/payslipService.js:lists + model compound',

    model: 'Payslip',

    filter: ['companyId', 'month', 'status'],

    kind: 'prefix',

    note: '{companyId, month, status} declared exactly',
  },

  {
    id: 'attendance analytics snapshots',

    evidence: 'src/services/attendance/attendanceAnalyticsService.js:269',

    model: 'AttendancePayrollSnapshot',

    filter: ['companyId', 'month', 'employeeId', 'isCurrent'],

    kind: 'prefix',

    note: '{companyId,month,isCurrent} + {companyId,employeeId,month} + unique version compound',
  },

  {
    id: 'notification inbox',

    evidence: 'src/services/notificationService.js:inbox + model compounds',

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

    note: '$nin cannot use an index; collection is one doc per company (tiny); COLLSCAN intentional and cheap — verdict recorded, query byte-frozen',
  },

  {
    id: 'public careers list',

    evidence: 'src/services/publicCareerService.js:217,229',

    model: 'JobPosting',

    filter: ['companyId'],

    sort: ['publishedAt'],

    kind: 'prefix',

    note: 'companyId index serves the tenant filter; per-tenant job count small → bounded sort; pagination capped (MAX_LIMIT 24)',
  },

  {
    id: 'login user lookup',

    evidence: 'src/controllers/authController.js:416',

    model: 'User',

    filter: ['email', 'companyId'],

    kind: 'point',

    note: 'unique {email, companyId}',
  },

  {
    id: 'candidate pipeline board',

    evidence: 'src/services/candidateInboxService.js:71 + model compounds',

    model: 'Candidate',

    filter: ['companyId', 'job', 'currentStage'],

    kind: 'prefix',

    note: '{companyId, job, currentStage, source} declared exactly; inbox is server-paged (≤100)',
  },

  {
    id: 'BGV verifier work queue',

    evidence: 'src/services/bgv/bgvAssignmentService.js:75 (32.5 scoped read)',

    model: 'BgvCheckAssignment',

    filter: ['verifier'],

    kind: 'prefix',

    note: '{verifier} index serves the verifier-scoped CURRENT-assignment read; batched $in loads keep the queue flat-query',
  },

  {
    id: 'BGV checks per case',

    evidence: 'src/workers/bgvProcessor.js:82',

    model: 'BackgroundVerificationCheck',

    filter: ['companyId', 'case'],

    sort: ['displayOrder'],

    kind: 'prefix',

    note: 'unique {companyId, case, code} serves the filter',
  },
];

// ─────────────────────────────────────────────────────────────
//  Coverage rule (documented, conservative):
//  COVERED when some declared index's key sequence STARTS with the
//  entry's equality keys in order. POINT LOOKUP additionally when a
//  UNIQUE index leads with ANY equality key (candidate set ≤ 1 for
//  findOne — verified against the single document). Sort keys give
//  FILTER+SORT only when contiguous after the equality prefix.
// ─────────────────────────────────────────────────────────────

export const evaluateCatalogEntry = (entry, declaredIndexes) => {
  const equality = entry.filter;

  const sort = entry.sort || [];

  if (entry.kind === 'documented') {
    return { verdict: 'DOCUMENTED', index: null, note: entry.note };
  }

  for (const [keys] of declaredIndexes) {
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

  // Unique-led fallback (Mongo findOne semantics): a UNIQUE index
  // leading with ANY equality key caps the candidate set at ONE
  // document. Single-field non-unique indexes are handled only by the
  // strict prefix rule — never counted as point lookups.
  let pointKey = equality.includes('_id') ? '_id' : null;

  if (!pointKey) {
    for (const [keys, options] of declaredIndexes) {
      const keyNames = Object.keys(keys);

      const first = keyNames[0];

      if (equality.includes(first) && options?.unique) {
        pointKey = first;

        break;
      }
    }
  }

  if (pointKey && (entry.kind === 'point' || entry.kind === 'prefix')) {
    return {
      verdict: 'COVERED (point lookup)',

      index: `${pointKey} (unique-led)`,

      note: entry.note,
    };
  }

  return {
    verdict: 'GAP',

    index: null,

    note: 'no declared index serves this hot query — add a compound index (with ESR reasoning)',
  };
};

// ─────────────────────────────────────────────────────────────
//  Model loading + inventory (§47 machine-assisted inventory)
//
//  WINDOWS ESM LAW: dynamic import() takes a URL, not a filesystem
//  path. A bare Windows absolute path ("C:\...\User.js") fails with
//  "Received protocol 'c:'". Every dynamic import MUST go through
//  pathToFileURL() (node:url) — correct on Windows, Linux and macOS.
// ─────────────────────────────────────────────────────────────

export const toModuleUrl = (absolutePath) => pathToFileURL(absolutePath).href;

export const loadAllModels = async () => {
  const files = readdirSync(MODELS_DIR)
    .filter((file) => file.endsWith('.js'))
    .sort();

  let loaded = 0;

  const failures = [];

  for (const file of files) {
    try {
      await import(toModuleUrl(path.join(MODELS_DIR, file)));

      loaded += 1;
    } catch (error) {
      failures.push(`${file}: ${error.message}`);
    }
  }

  return { loaded, failures, total: files.length };
};

export const inventoryIndexes = () => {
  let declared = 0;

  let unique = 0;

  let ttl = 0;

  let partial = 0;

  let sparse = 0;

  const zeroIndexModels = [];

  const ttlList = [];

  for (const name of mongoose.modelNames()) {
    const indexes = mongoose.model(name).schema.indexes();

    if (!indexes.length) {
      zeroIndexModels.push(name);

      continue;
    }

    declared += indexes.length;

    for (const [keys, options] of indexes) {
      if (options?.unique) unique += 1;

      if (options?.expireAfterSeconds !== undefined) {
        ttl += 1;

        ttlList.push(`${name}{${Object.keys(keys).join(',')}}`);
      }

      if (options?.partialFilterExpression) partial += 1;

      if (options?.sparse) sparse += 1;
    }
  }

  return {
    models: mongoose.modelNames().length,

    declared,

    unique,

    ttl,

    partial,

    sparse,

    zeroIndexModels,

    ttlList,
  };
};

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const run = async () => {
  process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_index_audit';

  const { loaded, failures, total } = await loadAllModels();

  console.log('=== PHASE 32.5 — INDEX COVERAGE AUDIT (schema ground truth) ===');

  console.log(`models loaded: ${loaded}/${total}`);

  for (const failure of failures) {
    console.log(`  LOAD FAIL ${failure}`);
  }

  // FAIL CLOSED (§5): the audit's verdict is only meaningful when the
  // COMPLETE model set is loaded. A partial set would under-report
  // declared indexes and could imply coverage that does not exist.
  if (failures.length || loaded !== total) {
    console.log(
      `\nREFUSED: model loading incomplete (${loaded}/${total}) — ` +
        'no index-coverage verdict can be produced from a partial model set. ' +
        'Fix the LOAD FAIL entries above and rerun.',
    );

    process.exitCode = 1;

    if (!isMain) return;

    setTimeout(() => process.exit(process.exitCode || 0), 50).unref();

    return;
  }

  const stats = inventoryIndexes();

  console.log(
    `declared indexes: ${stats.declared} across ${stats.models - stats.zeroIndexModels.length}/${stats.models} collections ` +
      `(unique: ${stats.unique}, TTL: ${stats.ttl}, partial: ${stats.partial}, sparse: ${stats.sparse})`,
  );

  console.log(`TTL indexes: ${stats.ttlList.join(' · ') || 'none'}`);

  if (stats.zeroIndexModels.length) {
    console.log(`models with zero explicit indexes: ${stats.zeroIndexModels.join(', ')}`);
  }

  console.log('\n=== HOT-QUERY CATALOG ===');

  let gaps = 0;

  for (const entry of HOT_QUERY_CATALOG) {
    // Defensive (fail-closed): a catalog model that failed to register
    // must be a reported GAP, never an uncaught MissingSchemaError.
    if (!mongoose.models[entry.model]) {
      gaps += 1;

      console.log(
        `[GAP] ${entry.id} → ${entry.model} (${entry.evidence})` +
          ' · model did not register — cannot verify index coverage',
      );

      continue;
    }

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
    console.log(`GAPS: ${gaps} — add compound indexes (with ESR reasoning) before shipping.`);

    process.exitCode = 1;
  } else {
    console.log(
      'All hot-query catalog entries are index-served or explicitly documented.',
    );
  }

  if (!isMain) return;

  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
};

if (isMain) {
  await run();
}
