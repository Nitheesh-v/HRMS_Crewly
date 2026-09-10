// ============================================================
//  PHASE 30.11 — BGV OPERATIONS DASHBOARD (internal, derived).
//
//  This is INTERNAL operations visibility — NOT a hiring-decision
//  dashboard and NOT a second state machine:
//   - Every queue state below is DERIVED on read from the
//     authoritative Phase 30.x documents (BgvOrder 30.3, collection
//     case 30.5, assignment 30.7, verification 30.8/30.9, info
//     requests 30.9, final report 30.10). Nothing here is stored,
//     duplicated, or allowed to drift from those documents.
//   - Rows are deliberately "safe": order code, tenant name,
//     candidate display name, check type, derived state, verifier
//     display name, age/due and last-activity timestamps. PAN,
//     Aadhaar, UAN, addresses, documents, notes, evidence and
//     payment ids are NEVER selected and never appear in responses.
//   - SLA status is computed per request from the deterministic
//     clock (see bgvSlaRules.js); no countdowns are stored and no
//     React timers exist — the backend is the only clock.
//
//  Paging follows the 29.13/super-admin operations pattern: bounded
//  page size, skip/limit, server-side filter + sort, total count.
// ============================================================

import mongoose from 'mongoose';
import { isCommerciallyAuthorized } from './bgvOrderRules.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { BGV_SLA_POLICY_KEY } from '../../models/BgvSlaPolicy.js';
import {
  SLA_CHECK_TYPES,
  evaluateCheckSla,
  evaluateUnassignedWait,
  validateSlaPolicy,
} from './bgvSlaRules.js';

import BgvOrder from '../../models/BgvOrder.js';
import BgvCollectionCase from '../../models/BgvCollectionCase.js';
import BgvCheckAssignment from '../../models/BgvCheckAssignment.js';
import BgvCheckVerification from '../../models/BgvCheckVerification.js';
import BgvInfoRequest from '../../models/BgvInfoRequest.js';
import BgvFinalReport from '../../models/BgvFinalReport.js';
import BgvSlaPolicy from '../../models/BgvSlaPolicy.js';
import Company from '../../models/Company.js';
import Candidate from '../../models/Candidate.js';
import BgvVerifier from '../../models/BgvVerifier.js';

// Direct model references (the app's normal pattern). Every query below
// can still be replaced through deps for hermetic tests.
const MODELS = {
  BgvOrder,
  BgvCollectionCase,
  BgvCheckAssignment,
  BgvCheckVerification,
  BgvInfoRequest,
  BgvFinalReport,
  BgvSlaPolicy,
  Company,
  Candidate,
  BgvVerifier,
};
const loadModels = () => MODELS;

// Derived queue states (documentation-only constant — the values are
// never written to any document).
export const OPS_STATES = [
  'AWAITING_CONSENT', // 30.4: paid, no collection case yet (consent not given)
  'AWAITING_CANDIDATE_SUBMISSION', // 30.5: case exists, not submitted
  'UNASSIGNED', // 30.7: submitted check with no current assignment
  'IN_PROGRESS', // 30.7/30.8: assigned / verifier working
  'AWAITING_CANDIDATE', // 30.9: info request open with candidate
  'AWAITING_THIRD_PARTY', // 30.8: waiting on external source
  'AWAITING_QA', // 30.10: submitted, QA pending
  'QA_RETURNED', // 30.10: returned to verifier for a new revision
  'APPROVED', // 30.10: QA approved, report not generated yet
  'REPORT_READY', // 30.10: report GENERATED (not released)
  'RELEASED', // 30.10: report RELEASED (tenant-visible)
];

export const PAGE_SIZE_CAP = 50;
const SORTS = ['age_desc', 'age_asc'];

const id = (v) => String(v?._id ?? v ?? '');
const iso = (v) => (v ? new Date(v).toISOString() : null);
const maxIso = (...values) =>
  values.filter(Boolean).map(iso).sort().pop() || null;

// ── Derivation: one purchased check → one ops state ──────────────
// Precedence: released/generated report > QA outcomes > verification
// state > assignment presence. Mirrors the authoritative services —
// no state of its own.
const deriveCheckState = ({ report, verification, assignment }) => {
  if (report) return report.status === 'RELEASED' ? 'RELEASED' : 'REPORT_READY';
  if (verification) {
    if (verification.state === 'SUBMITTED') {
      if (verification.qa?.status === 'APPROVED') return 'APPROVED';
      return 'AWAITING_QA'; // NONE/PENDING/RETURNED-with-current-submission
    }
    if (verification.state === 'QA_RETURNED') return 'QA_RETURNED';
    if (verification.state === 'AWAITING_CANDIDATE') return 'AWAITING_CANDIDATE';
    if (verification.state === 'AWAITING_THIRD_PARTY') return 'AWAITING_THIRD_PARTY';
    return 'IN_PROGRESS';
  }
  return assignment ? 'IN_PROGRESS' : 'UNASSIGNED';
};

// Fetch the bounded, projection-limited working set for one scan.
// Projections never select sensitive subdocuments (identity, address,
// notes, evidence, snapshot, pdf).
const loadWorkingSet = async (deps = {}) => {
  const m = deps.models || loadModels();
  const [orders, cases, assignments, verifications, infoRequests, reports] = await Promise.all([
    (deps.findOrders ||
      (() =>
        m.BgvOrder.find({})
          .select('_id companyId candidate orderCode status paidAt createdAt items')
          .lean()))(),
    (deps.findCases ||
      (() =>
        m.BgvCollectionCase.find({})
          .select('_id bgvOrder candidate status submittedAt purchasedChecks createdAt updatedAt')
          .lean()))(),
    (deps.findAssignments ||
      (() =>
        m.BgvCheckAssignment.find({ activeKey: 'CURRENT' })
          .select('+activeKey _id bgvOrder checkType verifier assignedAt startedAt updatedAt')
          .lean()))(),
    (deps.findVerifications ||
      (() =>
        m.BgvCheckVerification.find({ activeKey: 'CURRENT' })
          .select('+activeKey _id bgvOrder checkType state qa conclusion updatedAt submittedAt activities')
          .lean()))(),
    (deps.findInfoRequests ||
      (() =>
        m.BgvInfoRequest.find({})
          .select('_id bgvOrder checkType status requestedAt respondedAt resolvedAt cancelledAt')
          .lean()))(),
    (deps.findReports ||
      (() =>
        m.BgvFinalReport.find({})
          .select('_id bgvOrder checkType status release createdAt')
          .lean()))(),
  ]);
  return { orders, cases, assignments, verifications, infoRequests, reports };
};

const loadNames = async ({ companyIds, candidateIds, verifierIds }, deps = {}) => {
  const m = deps.models || loadModels();
  // Ids arrive as Sets — normalise once (Sets have .size, not .length).
  const ids = (v) => [...(v || [])];
  const cIds = ids(companyIds);
  const dIds = ids(candidateIds);
  const vIds = ids(verifierIds);
  const [companies, candidates, verifiers] = await Promise.all([
    cIds.length
      ? (deps.findCompanies ||
          (() => m.Company.find({ _id: { $in: cIds } }).select('_id name').lean()))()
      : [],
    dIds.length
      ? (deps.findCandidates ||
          (() => m.Candidate.find({ _id: { $in: dIds } }).select('_id name').lean()))()
      : [],
    vIds.length
      ? (deps.findVerifiers ||
          (() =>
            m.BgvVerifier.find({ _id: { $in: vIds } })
              .select('_id name status specializations')
              .lean()))()
      : [],
  ]);
  return {
    companyName: Object.fromEntries(companies.map((c) => [id(c._id), c.name])),
    candidateName: Object.fromEntries(candidates.map((c) => [id(c._id), c.name])),
    verifier: Object.fromEntries(verifiers.map((v) => [id(v._id), v])),
  };
};

// Build derived rows for one scan (orders × purchased checks).
// SLA clock (documented decision): accountability starts at the LATER
// of candidate submission (30.5 freeze) and verifier assignment (30.7)
// — before either, no one is accountable. Time while AWAITING_CANDIDATE
// is paused via 30.9 info-request intervals when the policy says so;
// AWAITING_THIRD_PARTY does NOT pause (verifier owns external chasing).
export const buildRows = ({ workingSet, policy, nowIso, deps = {} }) => {
  const { orders, cases, assignments, verifications, infoRequests, reports } = workingSet;
  const caseByOrder = new Map(cases.map((c) => [id(c.bgvOrder), c]));
  const assignByKey = new Map(assignments.map((a) => [`${id(a.bgvOrder)}|${a.checkType}`, a]));
  const verifyByKey = new Map(verifications.map((v) => [`${id(v.bgvOrder)}|${v.checkType}`, v]));
  const infoByOrder = new Map();
  for (const request of infoRequests) {
    const key = id(request.bgvOrder);
    if (!infoByOrder.has(key)) infoByOrder.set(key, []);
    infoByOrder.get(key).push(request);
  }
  // Latest report per order+check (reports are versioned & immutable).
  const reportByKey = new Map();
  for (const report of reports) {
    const key = `${id(report.bgvOrder)}|${report.checkType}`;
    const prev = reportByKey.get(key);
    if (!prev || new Date(report.createdAt) > new Date(prev.createdAt)) reportByKey.set(key, report);
  }

  const companyIds = new Set();
  const candidateIds = new Set();
  const verifierIds = new Set();
  for (const order of orders) {
    companyIds.add(id(order.companyId));
    candidateIds.add(id(order.candidate));
  }
  for (const assignment of assignments) if (assignment.verifier) verifierIds.add(id(assignment.verifier));

  const nowMs = Date.parse(nowIso);
  const targetOf = (checkType) => policy?.targets?.[checkType] ?? null;

  const rows = [];
  for (const order of orders) {
    // Payment future-proofing: only the commercial-authorization
    // boundary is consumed — never razorpayPaymentId or amounts.
    if (!isCommerciallyAuthorized(order)) continue;
    const caseDoc = caseByOrder.get(id(order._id));
    const base = {
      orderId: id(order._id),
      orderCode: order.orderCode,
      companyId: id(order.companyId),
      candidateId: id(order.candidate),
    };

    if (!caseDoc) {
      // 30.4 — paid but consent/case not created yet.
      rows.push({
        ...base,
        checkType: null,
        state: 'AWAITING_CONSENT',
        verifierId: null,
        ageHours: Math.max(0, Math.floor((nowMs - Date.parse(iso(order.paidAt || order.createdAt) || nowIso)) / 3600000)),
        clockStartIso: iso(order.paidAt || order.createdAt),
        slaStatus: 'SLA_NOT_CONFIGURED',
        dueAtIso: null,
        overdueDays: 0,
        lastActivityIso: iso(order.paidAt || order.createdAt),
      });
      continue;
    }
    if (caseDoc.status !== 'SUBMITTED' || !caseDoc.submittedAt) {
      // 30.5 — consented, submission still pending.
      rows.push({
        ...base,
        checkType: null,
        state: 'AWAITING_CANDIDATE_SUBMISSION',
        verifierId: null,
        ageHours: Math.max(0, Math.floor((nowMs - Date.parse(iso(caseDoc.createdAt) || nowIso)) / 3600000)),
        clockStartIso: iso(caseDoc.createdAt),
        slaStatus: 'SLA_NOT_CONFIGURED',
        dueAtIso: null,
        overdueDays: 0,
        lastActivityIso: maxIso(caseDoc.updatedAt, caseDoc.createdAt),
      });
      continue;
    }

    const orderInfoRequests = infoByOrder.get(id(order._id)) || [];
    for (const checkType of caseDoc.purchasedChecks || []) {
      const assignment = assignByKey.get(`${id(order._id)}|${checkType}`) || null;
      const verification = verifyByKey.get(`${id(order._id)}|${checkType}`) || null;
      const report = reportByKey.get(`${id(order._id)}|${checkType}`) || null;
      const state = deriveCheckState({ report, verification, assignment });
      const verifierId = assignment?.verifier ? id(assignment.verifier) : null;

      // Paused intervals from OPEN/closed 30.9 info requests for this
      // check (candidate wait is not verifier-accountable time).
      const pausedIntervals = (policy?.pauseOnCandidateWait ?? true)
        ? orderInfoRequests
            .filter((r) => r.checkType === checkType)
            .map((r) => ({
              startIso: iso(r.requestedAt),
              endIso: iso(r.respondedAt || r.resolvedAt || r.cancelledAt) ||
                (r.status === 'OPEN' ? null : undefined),
            }))
        : [];

      const clockStartIso = [caseDoc.submittedAt, assignment?.assignedAt]
        .filter(Boolean)
        .map((d) => new Date(d).toISOString())
        .sort()
        .pop();
      const completedAtIso = report
        ? iso(report.release?.releasedAt || report.createdAt)
        : state === 'APPROVED'
          ? iso(verification?.qa?.reviewedAt || verification?.conclusion?.submittedAt)
          : null;

      let sla;
      if (state === 'UNASSIGNED') {
        sla = evaluateUnassignedWait({
          submittedAtIso: iso(caseDoc.submittedAt),
          nowIso,
          unassignedTargetHours: policy?.unassignedTargetHours ?? null,
        });
      } else {
        sla = evaluateCheckSla({
          clockStartIso,
          completedAtIso,
          pausedIntervals,
          nowIso,
          targetHours: targetOf(checkType),
          dueSoonHours: policy?.dueSoonHours ?? 24,
          currentlyPaused: state === 'AWAITING_CANDIDATE',
        });
      }
      const remainingMs = sla.remainingMs ?? null;
      const accountableMs = sla.accountableMs ?? sla.waitingMs ?? 0;
      rows.push({
        ...base,
        checkType,
        state,
        verifierId,
        clockStartIso,
        slaStatus: sla.status,
        dueAtIso:
          clockStartIso && remainingMs !== null && !completedAtIso
            ? new Date(Date.parse(clockStartIso) + accountableMs + remainingMs).toISOString()
            : null,
        overdueDays:
          sla.status === 'OVERDUE' && remainingMs !== null
            ? Math.floor(-remainingMs / 86400000) + 1
            : 0,
        lastActivityIso: maxIso(
          verification?.updatedAt,
          report?.createdAt,
          assignment?.updatedAt,
          assignment?.assignedAt,
          caseDoc.submittedAt
        ),
        ageHours: Math.max(0, Math.floor((nowMs - Date.parse(clockStartIso || caseDoc.submittedAt || nowIso)) / 3600000)),
      });
    }
  }
  return { rows, companyIds, candidateIds, verifierIds };
};

const applyFilters = (rows, filter = {}) =>
  rows.filter((row) => {
    if (filter.state && row.state !== filter.state) return false;
    if (filter.checkType && row.checkType !== filter.checkType) return false;
    if (filter.verifierId && row.verifierId !== filter.verifierId) return false;
    if (filter.companyId && row.companyId !== filter.companyId) return false;
    if (filter.orderCode && !String(row.orderCode || '').toLowerCase().includes(String(filter.orderCode).toLowerCase())) return false;
    if (filter.sla === 'OVERDUE' && row.slaStatus !== 'OVERDUE') return false;
    if (filter.sla === 'DUE_SOON' && row.slaStatus !== 'DUE_SOON') return false;
    if (filter.sla === 'SLA_NOT_CONFIGURED' && row.slaStatus !== 'SLA_NOT_CONFIGURED') return false;
    return true;
  });

const decorate = (rows, names) =>
  rows.map((row) => ({
    ...row,
    companyName: names.companyName[row.companyId] || 'Unknown organisation',
    candidateName: names.candidateName[row.candidateId] || 'Candidate',
    verifierName: row.verifierId ? names.verifier[row.verifierId]?.name || 'Verifier' : null,
  }));

// ── Summary cards (counts derived from the same scan) ────────────
export const opsSummary = async ({ deps = {}, nowIso = new Date().toISOString() } = {}) => {
  const workingSet = await loadWorkingSet(deps);
  const policy = await readSlaPolicy({ deps });
  const { rows } = buildRows({ workingSet, policy, nowIso, deps });
  const counts = Object.fromEntries(OPS_STATES.map((s) => [s, 0]));
  let overdue = 0;
  let dueSoon = 0;
  let slaNotConfigured = 0;
  for (const row of rows) {
    if (counts[row.state] !== undefined) counts[row.state] += 1;
    if (row.slaStatus === 'OVERDUE') overdue += 1;
    if (row.slaStatus === 'DUE_SOON') dueSoon += 1;
    if (row.slaStatus === 'SLA_NOT_CONFIGURED') slaNotConfigured += 1;
  }
  return {
    counts,
    overdue,
    dueSoon,
    slaNotConfigured,
    totalRows: rows.length,
    checkTypes: SLA_CHECK_TYPES,
    asOfIso: nowIso,
  };
};

// ── Drill-down queue (server-side paging/filter/sort, capped) ────
export const opsQueue = async ({
  page = 1,
  pageSize = 20,
  filter = {},
  sort = 'age_desc',
  deps = {},
  nowIso = new Date().toISOString(),
} = {}) => {
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.min(PAGE_SIZE_CAP, Math.max(1, Math.floor(Number(pageSize) || 20)));
  const workingSet = await loadWorkingSet(deps);
  const policy = await readSlaPolicy({ deps });
  const { rows, companyIds, candidateIds, verifierIds } = buildRows({ workingSet, policy, nowIso, deps });
  const names = await loadNames({ companyIds, candidateIds, verifierIds }, deps);
  const filtered = applyFilters(rows, filter);
  filtered.sort((a, b) => {
    const av = a.state === 'UNASSIGNED' ? Date.parse(a.clockStartIso || 0) : Date.parse(a.clockStartIso || 0);
    const bv = Date.parse(b.clockStartIso || 0);
    return sort === 'age_asc' ? av - bv : bv - av;
  });
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / safeSize));
  const slice = filtered.slice((safePage - 1) * safeSize, safePage * safeSize);
  return {
    rows: decorate(slice, names),
    total,
    page: safePage,
    pages,
    pageSize: safeSize,
    filter,
    sort: SORTS.includes(sort) ? sort : 'age_desc',
    asOfIso: nowIso,
  };
};

// ── Verifier workload (platform-only; never exposed to tenants) ──
export const verifierWorkload = async ({ deps = {}, nowIso = new Date().toISOString() } = {}) => {
  const m = deps.models || loadModels();
  const workingSet = await loadWorkingSet(deps);
  const policy = await readSlaPolicy({ deps });
  const { rows } = buildRows({ workingSet, policy, nowIso, deps });
  const allVerifiers = await (deps.findAllVerifiers ||
    (() => m.BgvVerifier.find({}).select('_id name status specializations').lean()))();
  const out = [];
  for (const verifier of allVerifiers) {
    const mine = rows.filter((r) => r.verifierId === id(verifier._id));
    out.push({
      verifierId: id(verifier._id),
      name: verifier.name,
      status: verifier.status,
      specializations: verifier.specializations || [],
      assigned: mine.length,
      inProgress: mine.filter((r) => r.state === 'IN_PROGRESS').length,
      awaitingThirdParty: mine.filter((r) => r.state === 'AWAITING_THIRD_PARTY').length,
      waitingCandidate: mine.filter((r) => r.state === 'AWAITING_CANDIDATE').length,
      submittedForQa: mine.filter((r) => r.state === 'AWAITING_QA' || r.state === 'QA_RETURNED').length,
      overdue: mine.filter((r) => r.slaStatus === 'OVERDUE').length,
    });
  }
  out.sort((a, b) => b.inProgress - a.inProgress || a.name.localeCompare(b.name));
  return { verifiers: out, asOfIso: nowIso };
};

// ── SLA policy (platform config; NO defaults are ever seeded) ────
// An absent document means "not configured" — every derived row then
// reports SLA_NOT_CONFIGURED explicitly instead of inventing targets.
export const readSlaPolicy = async ({ deps = {} } = {}) => {
  const m = deps.models || loadModels();
  const doc = await (deps.findSlaPolicy || (() => m.BgvSlaPolicy.findOne({ key: BGV_SLA_POLICY_KEY }).lean()))();
  if (!doc) return null;
  return {
    targets: doc.targets || {},
    dueSoonHours: doc.dueSoonHours ?? 24,
    pauseOnCandidateWait: doc.pauseOnCandidateWait !== false,
    unassignedTargetHours: doc.unassignedTargetHours ?? null,
    updatedBy: doc.updatedBy ? id(doc.updatedBy) : null,
    updatedAt: iso(doc.updatedAt),
  };
};

export const updateSlaPolicy = async ({ actorId, input = {}, requestContext = null, deps = {} } = {}) => {
  const m = deps.models || loadModels();
  const checked = validateSlaPolicy(input);
  if (!checked.ok) {
    const err = new Error(checked.error);
    err.statusCode = 400;
    throw err;
  }
  const now = new Date();
  // Full replacement of the targets map (unconfigured = key omitted).
  const doc = await (deps.upsertSlaPolicy ||
    (() =>
      m.BgvSlaPolicy.findOneAndUpdate(
        { key: BGV_SLA_POLICY_KEY },
        {
          $set: {
            key: BGV_SLA_POLICY_KEY,
            targets: checked.value.targets,
            dueSoonHours: checked.value.dueSoonHours,
            pauseOnCandidateWait: checked.value.pauseOnCandidateWait,
            unassignedTargetHours: checked.value.unassignedTargetHours,
            updatedBy: actorId ? new mongoose.Types.ObjectId(actorId) : null,
            updatedAt: now,
          },
        },
        { upsert: true, returnDocument: 'after', new: true }
      ).lean()))();
  // Audit ONLY the configuration write (safe metadata — hour counts and
  // flags, never case data). Dashboard/queue/workload READS are internal
  // count lookups and are deliberately NOT audited (no read-spam rows).
  const audit = deps.audit || ((entry) => recordAudit(entry).catch(() => {}));
  await audit({
    req: requestContext,
    action: 'BGV_SLA_POLICY_UPDATED',
    actorId,
    resource: 'BgvSlaPolicy',
    resourceId: doc?._id,
    metadata: {
      configuredChecks: Object.keys(checked.value.targets).length,
      dueSoonHours: checked.value.dueSoonHours,
      pauseOnCandidateWait: checked.value.pauseOnCandidateWait,
      unassignedConfigured: checked.value.unassignedTargetHours !== null,
      phase: '30.11',
    },
  });
  return readSlaPolicy({ deps: { ...deps, findSlaPolicy: () => Promise.resolve(doc) } });
};
