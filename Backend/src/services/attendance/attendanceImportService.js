// ─────────────────────────────────────────────────────────────
// Phase 31.14 — CSV attendance import (preview → confirm).
//
// Pipeline: UPLOAD → PARSE → PREVIEW → VALIDATE → CONFIRM →
// IMPORT. Preview is pure computation (zero writes); confirm
// re-validates server-side and ingests VALID_ROWS_ONLY through
// recordEvent with server-decided ingest { source: IMPORT }.
//
// Backdated events ride recordEvent's own backdating rules (past
// days require explicit `date`; future is refused) with the clock
// injected per event. Idempotency: fingerprint-unique batches +
// per-row requestId `import:<batchId>:<line>` + an event-exists
// backstop, so reordered files and retries converge.
// ─────────────────────────────────────────────────────────────

import mongoose from 'mongoose';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import {
  IMPORT_STATUS,
  canTransitionImport,
  fingerprintImportContent,
  parseAttendanceImportCsv,
  isWithinImportWindow,
  monthOfInstantInZone,
  planImportSessions,
} from './attendanceImportRules.js';
import { EVENT_TYPE, EVENT_SOURCE, LIVE_STATE } from './attendancePolicyRules.js';
import { isMonthLockedForIngest } from './attendanceSourceRules.js';
import { enabledWorkModes } from './attendanceEventRules.js';
import { recordEvent } from './attendanceEventService.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import { dayKeyInZone } from './attendanceRegularizationRules.js';
import {
  resolveEmployeeByCode,
  assertIngestMonthOpen,
} from './attendanceIngestSupport.js';
import AttendanceImport from '../../models/AttendanceImport.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import Attendance from '../../models/Attendance.js';
import User from '../../models/User.js';
import AttendancePeriod from '../../models/AttendancePeriod.js';

// Guardrail: existing-history reads stay bounded no matter how
// wide the file's span is.
const MAX_EXISTING_SCAN = 20000;

const safeBatch = (doc) => {
  if (!doc) return null;
  return {
    id: String(doc._id),
    companyId: String(doc.companyId),
    fingerprint: doc.fingerprint,
    sourceLabel: doc.sourceLabel || null,
    status: doc.status,
    months: doc.months || [],
    rowCount: doc.rowCount,
    validCount: doc.validCount,
    importedCount: doc.importedCount,
    skippedCount: doc.skippedCount,
    rejectedCount: doc.rejectedCount,
    outcomes: doc.outcomes || [],
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    confirmedBy: doc.confirmedBy ? String(doc.confirmedBy) : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    confirmedAt: doc.confirmedAt ? new Date(doc.confirmedAt).toISOString() : null,
  };
};

const runAudit = (deps, args) =>
  Promise.resolve()
    .then(() => (deps.audit || recordAudit)(args))
    .catch(() => {});

// ── Shared validation (preview AND confirm) ──────────────────
// Confirm never trusts client rows — it re-runs this function.

export const validateImportContent = async ({ companyId, content, deps = {} } = {}) => {
  if (!mongoose.isValidObjectId(companyId)) throw ApiError.badRequest('Company context is required');
  const parsed = parseAttendanceImportCsv(content);
  const fingerprint = fingerprintImportContent(content);

  const getPolicy = deps.getCurrentPolicy || getCurrentPolicy;
  const { policy } = await getPolicy({ companyId });
  const timeZone = policy?.timezone || 'Asia/Kolkata';
  const enabledModes = new Set(enabledWorkModes(policy));
  const nowMs = deps.now ? deps.now() : Date.now();
  const dayKeyOf = (ms) => dayKeyInZone(new Date(ms), timeZone);

  // Resolved employees, bulk-loaded (one query, case-insensitive).
  const codes = [...new Set(parsed.rows.map((row) => row.employeeCode))];
  const UserModel = deps.UserModel || User;
  const users = codes.length
    ? await UserModel.find({ companyId, employeeCode: { $in: codes }, status: 'ACTIVE' })
      .collation({ locale: 'en', strength: 2 })
      .select('_id name employeeCode')
      .lean()
    : [];
  const byCode = new Map((users || []).map((user) => [String(user.employeeCode).toUpperCase(), user]));

  const invalid = parsed.rejected.map((row) => ({
    line: row.line,
    employeeCode: row.employeeCode || '',
    message: row.error,
  }));
  const candidates = [];
  for (const row of parsed.rows) {
    const user = byCode.get(row.employeeCode.toUpperCase());
    if (!user) {
      invalid.push({ line: row.line, employeeCode: row.employeeCode, message: 'Unknown employee code or inactive employee' });
      continue;
    }
    if (!isWithinImportWindow(row.occurredMs, nowMs)) {
      invalid.push({ line: row.line, employeeCode: row.employeeCode, message: 'Timestamp is outside the 12-month import window' });
      continue;
    }
    if (row.eventType !== EVENT_TYPE.CLOCK_IN && row.workMode) {
      invalid.push({ line: row.line, employeeCode: row.employeeCode, message: 'workMode applies to CLOCK_IN rows only' });
      continue;
    }
    // Blank workMode means OFFICE (the documented default).
    const workMode = row.eventType === EVENT_TYPE.CLOCK_IN ? row.workMode || 'OFFICE' : null;
    if (row.eventType === EVENT_TYPE.CLOCK_IN && !enabledModes.has(workMode)) {
      invalid.push({ line: row.line, employeeCode: row.employeeCode, message: `Work mode ${workMode} is not enabled in policy` });
      continue;
    }
    candidates.push({ ...row, workMode, userKey: String(user._id), user });
  }

  // Existing history for the touched (user, day) span.
  const userIds = [...new Set(candidates.map((row) => row.userKey))];
  const days = [...new Set(candidates.map((row) => dayKeyOf(row.occurredMs)))];
  const EventModel = deps.EventModel || AttendanceEvent;
  const AttendanceModel = deps.AttendanceModel || Attendance;
  let existing = [];
  let openState = new Map();
  if (userIds.length && days.length) {
    existing = await EventModel.find({ companyId, user: { $in: userIds }, date: { $in: days } })
      .select('user date type at')
      .sort({ at: 1 })
      .limit(MAX_EXISTING_SCAN + 1)
      .lean();
    if ((existing || []).length > MAX_EXISTING_SCAN) {
      throw ApiError.badRequest('Too much recorded history in this file\u2019s span — split the file and retry');
    }
    const openSessions = await AttendanceModel.find({
      companyId,
      user: { $in: userIds },
      liveState: { $in: [LIVE_STATE.WORKING, LIVE_STATE.ON_BREAK] },
    })
      .select('user date liveState')
      .lean();
    openState = new Map(
      (openSessions || []).map((session) => [
        String(session.user),
        { liveState: session.liveState, sessionDay: session.date },
      ])
    );
  }

  const plans = planImportSessions({
    rows: candidates.map((row) => ({
      line: row.line,
      userKey: row.userKey,
      occurredMs: row.occurredMs,
      eventType: row.eventType,
    })),
    existing: (existing || []).map((ev) => ({
      userKey: String(ev.user),
      sessionDay: ev.date,
      type: ev.type,
      atMs: new Date(ev.at).getTime(),
    })),
    openState,
    dayKeyOf,
  });
  const planByLine = new Map(plans.map((plan) => [plan.line, plan]));

  // Finalized-month checks (only for otherwise-valid rows).
  const PeriodModel = deps.PeriodModel || AttendancePeriod;
  const months = [...new Set(
    candidates
      .filter((row) => planByLine.get(row.line)?.valid)
      .map((row) => monthOfInstantInZone(row.occurredMs, timeZone))
  )];
  const periods = months.length
    ? await PeriodModel.find({ companyId, month: { $in: months } }).select('month status').lean()
    : [];
  const lockedMonths = new Set(
    (periods || []).filter((p) => isMonthLockedForIngest(p.status)).map((p) => p.month)
  );

  const valid = [];
  for (const row of candidates) {
    const plan = planByLine.get(row.line);
    if (!plan || !plan.valid) {
      invalid.push({
        line: row.line,
        employeeCode: row.employeeCode,
        message: plan?.reason || 'Row failed session validation',
      });
      continue;
    }
    const month = monthOfInstantInZone(row.occurredMs, timeZone);
    if (lockedMonths.has(month)) {
      invalid.push({
        line: row.line,
        employeeCode: row.employeeCode,
        message: `Attendance for ${month} is finalized — reopen it in Attendance Finalization, then re-import`,
      });
      continue;
    }
    valid.push({
      line: row.line,
      employeeCode: row.employeeCode,
      userId: String(row.user._id),
      name: row.user.name,
      eventType: row.eventType,
      occurredAt: new Date(row.occurredMs).toISOString(),
      occurredMs: row.occurredMs,
      sessionDay: plan.sessionDay,
      month,
      workMode: row.workMode,
      sourceReference: row.sourceReference || null,
      alreadyRecorded: plan.reasonCode === 'ALREADY_RECORDED',
    });
  }
  valid.sort((a, b) => a.occurredMs - b.occurredMs || a.line - b.line);
  invalid.sort((a, b) => a.line - b.line);

  return {
    fingerprint,
    header: parsed.header,
    truncated: parsed.truncated,
    timeZone,
    months,
    rowCount: parsed.rows.length + parsed.rejected.length,
    valid,
    invalid,
  };
};

// ── Preview (zero writes) ────────────────────────────────────

export const previewImport = async ({ companyId, content, deps = {} } = {}) => {
  const result = await validateImportContent({ companyId, content, deps });
  return {
    fingerprint: result.fingerprint,
    truncated: result.truncated,
    timeZone: result.timeZone,
    months: result.months,
    rowCount: result.rowCount,
    validCount: result.valid.length,
    invalidCount: result.invalid.length,
    valid: result.valid.map(({ occurredMs: _omitted, ...row }) => row),
    invalid: result.invalid,
  };
};

// ── Confirm (idempotent, VALID_ROWS_ONLY) ────────────────────

export const confirmImport = async ({
  companyId,
  content,
  sourceLabel = null,
  actor = null,
  req = null,
  deps = {},
} = {}) => {
  if (!mongoose.isValidObjectId(companyId)) throw ApiError.badRequest('Company context is required');
  const BatchModel = deps.BatchModel || AttendanceImport;
  const fingerprint = fingerprintImportContent(content);

  // Idempotent replay: the same file returns its stored summary.
  const prior = await BatchModel.findOne({ companyId, fingerprint }).lean();
  if (prior?.status === IMPORT_STATUS.CONFIRMED) {
    return { ...safeBatch(prior), duplicate: true };
  }
  if (prior?.status === IMPORT_STATUS.CONFIRMING) {
    throw ApiError.conflict('This file is already being imported — please wait, then refresh');
  }

  // Server-side re-validation (never trust client rows).
  const validated = await validateImportContent({ companyId, content, deps });
  if (!validated.rowCount) {
    throw ApiError.badRequest('The file has no data rows');
  }
  // Finalized months were already refused per-row above; an
  // all-invalid file stops here instead of recording a batch.
  if (!validated.valid.length) {
    throw ApiError.badRequest('No valid rows to import — fix the errors and retry');
  }

  let batch = prior && canTransitionImport(prior.status, IMPORT_STATUS.CONFIRMING)
    ? prior
    : null;
  if (!batch) {
    try {
      batch = await BatchModel.create({
        companyId,
        fingerprint,
        sourceLabel: sourceLabel ? String(sourceLabel).slice(0, 120) : null,
        status: IMPORT_STATUS.DRAFT,
        months: validated.months,
        rowCount: validated.rowCount,
        validCount: validated.valid.length,
        createdBy: actor?._id || null,
      });
      batch = batch.toObject ? batch.toObject() : batch;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const raced = await BatchModel.findOne({ companyId, fingerprint }).lean();
      if (raced?.status === IMPORT_STATUS.CONFIRMED) return { ...safeBatch(raced), duplicate: true };
      if (raced?.status === IMPORT_STATUS.CONFIRMING) {
        throw ApiError.conflict('This file is already being imported — please wait, then refresh');
      }
      batch = raced;
    }
  }
  if (!batch || !canTransitionImport(batch.status, IMPORT_STATUS.CONFIRMING)) {
    throw ApiError.conflict('This file cannot be imported in its current state');
  }

  // Atomic DRAFT → CONFIRMING claim (exactly one confirmer wins).
  const claimed = await BatchModel.findOneAndUpdate(
    { _id: batch._id, status: IMPORT_STATUS.DRAFT },
    { $set: { status: IMPORT_STATUS.CONFIRMING, confirmedBy: actor?._id || null, confirmedAt: new Date() } },
    { returnDocument: 'after' }
  ).lean();
  if (!claimed) {
    const raced = await BatchModel.findOne({ companyId, fingerprint }).lean();
    if (raced?.status === IMPORT_STATUS.CONFIRMED) return { ...safeBatch(raced), duplicate: true };
    throw ApiError.conflict('This file is already being imported — please wait, then refresh');
  }

  const EventModel = deps.EventModel || AttendanceEvent;
  const record = deps.recordEvent || recordEvent;
  const outcomes = [];
  let importedCount = 0;
  let skippedCount = 0;
  let rejectedCount = 0;

  // Sequential chronological ingest — VALID_ROWS_ONLY.
  for (const row of validated.valid) {
    const requestId = `import:${claimed._id}:${row.line}`;
    if (row.alreadyRecorded) {
      skippedCount += 1;
      outcomes.push({ line: row.line, employeeCode: row.employeeCode, status: 'SKIPPED', message: 'Already recorded — skipped' });
      continue;
    }
    try {
      // Backstop: the exact fact already exists (retry/reorder).
      const exists = await EventModel.findOne({
        companyId,
        user: row.userId,
        type: row.eventType,
        at: new Date(row.occurredMs),
      }).select('_id').lean();
      if (exists) {
        skippedCount += 1;
        outcomes.push({ line: row.line, employeeCode: row.employeeCode, status: 'SKIPPED', message: 'Already recorded — skipped' });
        continue;
      }
      await record({
        companyId,
        userId: row.userId,
        action: row.eventType,
        date: row.sessionDay,
        workMode: row.workMode,
        idempotencyKey: requestId,
        ingest: {
          source: EVENT_SOURCE.IMPORT,
          provenance: {
            importBatchId: String(claimed._id),
            ...(row.sourceReference ? { sourceReference: row.sourceReference } : {}),
          },
        },
        deps: { ...(deps.eventDeps || {}), now: () => new Date(row.occurredMs) },
      });
      importedCount += 1;
      outcomes.push({ line: row.line, employeeCode: row.employeeCode, status: 'IMPORTED', eventType: row.eventType, at: row.occurredAt });
    } catch (error) {
      // VALID_ROWS_ONLY: one bad row never poisons the batch.
      rejectedCount += 1;
      outcomes.push({
        line: row.line,
        employeeCode: row.employeeCode,
        status: 'REJECTED',
        message: error?.message || 'Row could not be imported',
      });
    }
  }
  for (const row of validated.invalid) {
    rejectedCount += 1;
    outcomes.push({ line: row.line, employeeCode: row.employeeCode, status: 'REJECTED', message: row.message });
  }
  outcomes.sort((a, b) => a.line - b.line);

  const finished = await BatchModel.findOneAndUpdate(
    { _id: claimed._id },
    {
      $set: {
        status: IMPORT_STATUS.CONFIRMED,
        validCount: validated.valid.length,
        importedCount,
        skippedCount,
        rejectedCount,
        outcomes,
      },
    },
    { returnDocument: 'after' }
  ).lean();

  await runAudit(deps, {
    req,
    action: 'ATTENDANCE_IMPORT_CONFIRMED',
    companyId,
    actorId: actor?._id || null,
    resource: 'AttendanceImport',
    resourceId: claimed._id,
    newValue: {
      fingerprint,
      months: validated.months,
      rowCount: validated.rowCount,
      importedCount,
      skippedCount,
      rejectedCount,
    },
  }).catch(() => {});

  return { ...safeBatch(finished), duplicate: false };
};

// ── Reads ────────────────────────────────────────────────────

export const listImports = async ({ companyId, deps = {} } = {}) => {
  if (!mongoose.isValidObjectId(companyId)) return [];
  const BatchModel = deps.BatchModel || AttendanceImport;
  const rows = await BatchModel.find({ companyId })
    .select('-outcomes')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return (rows || []).map((row) => ({ ...safeBatch(row), outcomes: undefined }));
};

export const getImport = async ({ companyId, importId, deps = {} } = {}) => {
  if (!mongoose.isValidObjectId(companyId) || !mongoose.isValidObjectId(importId)) {
    throw ApiError.badRequest('Import not found');
  }
  const BatchModel = deps.BatchModel || AttendanceImport;
  const batch = await BatchModel.findOne({ _id: importId, companyId }).lean();
  if (!batch) throw ApiError.notFound('Import not found');
  return safeBatch(batch);
};
