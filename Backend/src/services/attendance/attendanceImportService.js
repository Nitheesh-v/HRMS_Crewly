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

// ── Confirm (idempotent, VALID_ROWS_ONLY, chunked) ───────────
//
// 35.7 — the import used to run to completion inside ONE request. A 5,000-row
// file is thousands of engine round trips, so on a real database the client's
// 25s timeout fired while the server was still working: the browser reported a
// timeout, the batch stayed CONFIRMING with nothing written yet, and the file
// became un-importable ("already being imported — please wait").
//
// So confirm now does bounded work per call and is resumable:
//   · each call ingests rows until its time budget is spent, then PERSISTS
//     outcomes and counts and returns `done: false` with progress;
//   · the client calls again to continue — the next chunk starts exactly
//     where the stored outcomes end;
//   · the batch only becomes CONFIRMED when every row has an outcome.
//
// Correctness is unchanged: every row keeps its own idempotency key
// (`import:<batchId>:<line>`) and the exists-backstop, so re-processing any
// row is a replay, never a duplicate. Outcomes merge BY LINE and the counts
// are derived from the merged set, so even two concurrent continuations
// converge on the same ledger.
const DEFAULT_CONFIRM_BUDGET_MS = 12000;

const countOutcomes = (outcomes) => {
  const counts = { imported: 0, skipped: 0, rejected: 0 };
  (outcomes || []).forEach((outcome) => {
    if (outcome.status === 'IMPORTED') counts.imported += 1;
    else if (outcome.status === 'SKIPPED') counts.skipped += 1;
    else counts.rejected += 1;
  });
  return counts;
};

const progressOf = (batch, totalCount) => {
  const processedCount = Array.isArray(batch?.outcomes) ? batch.outcomes.length : 0;
  return {
    processedCount,
    totalCount,
    remainingCount: Math.max(0, totalCount - processedCount),
    done: processedCount >= totalCount,
  };
};

export const confirmImport = async ({
  companyId,
  content,
  sourceLabel = null,
  actor = null,
  req = null,
  deps = {},
  // Tests drive chunk boundaries deterministically with 0.
  budgetMs = null,
} = {}) => {
  if (!mongoose.isValidObjectId(companyId)) throw ApiError.badRequest('Company context is required');
  const BatchModel = deps.BatchModel || AttendanceImport;
  const fingerprint = fingerprintImportContent(content);
  const budget = Math.max(
    0,
    Number(budgetMs ?? deps.confirmBudgetMs ?? DEFAULT_CONFIRM_BUDGET_MS) || 0
  );
  const clockMs = () => {
    const value = deps.now ? deps.now() : Date.now();
    return value instanceof Date ? value.getTime() : Number(value);
  };

  // Idempotent replay: the same file returns its stored summary — but ONLY
  // when that stored batch actually recorded something. A batch that landed
  // nothing (every row refused, or one confirmed before the outcomes/schema
  // fix) is not a finished import: replaying it would tell a person "already
  // imported" while their data is missing, and the fingerprint would lock the
  // file forever. Those batches are retried in place below.
  const prior = await BatchModel.findOne({ companyId, fingerprint }).lean();
  const recordedBefore =
    Number(prior?.importedCount || 0) + Number(prior?.skippedCount || 0);
  if (prior?.status === IMPORT_STATUS.CONFIRMED && recordedBefore > 0) {
    return {
      ...safeBatch(prior),
      duplicate: true,
      ...progressOf(prior, Number(prior.rowCount || 0)),
    };
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

  // A batch already in CONFIRMING is a CONTINUATION, not a conflict: the
  // stored outcomes say which rows are done (see the 35.7 note above).
  const continuing = prior?.status === IMPORT_STATUS.CONFIRMING;

  let batch = prior && canTransitionImport(prior.status, IMPORT_STATUS.CONFIRMING, {
    importedCount: prior.importedCount,
    skippedCount: prior.skippedCount,
    continuation: continuing,
  })
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
      const racedRecorded =
        Number(raced?.importedCount || 0) + Number(raced?.skippedCount || 0);
      if (raced?.status === IMPORT_STATUS.CONFIRMED && racedRecorded > 0) {
        return {
          ...safeBatch(raced),
          duplicate: true,
          ...progressOf(raced, Number(raced.rowCount || 0)),
        };
      }
      batch = raced;
    }
  }

  if (
    !batch ||
    !canTransitionImport(batch.status, IMPORT_STATUS.CONFIRMING, {
      importedCount: batch.importedCount,
      skippedCount: batch.skippedCount,
      continuation: batch.status === IMPORT_STATUS.CONFIRMING,
    })
  ) {
    throw ApiError.conflict('This file cannot be imported in its current state');
  }

  /*
   * Atomic claim (one *starter* wins): DRAFT → CONFIRMING for a fresh file,
   * CONFIRMED → CONFIRMING for a retry of a batch that recorded nothing —
   * guarded on those zero counts so a retry can never race a completed import
   * into being overwritten. A CONFIRMING batch is already claimed and is
   * simply continued.
   */
  /*
   * A RETRY of a finished-but-empty batch starts from scratch: its stored
   * outcomes are stale refusals (the reason it recorded nothing), NOT
   * progress. A CONTINUATION of an in-progress batch keeps them — that is
   * exactly what makes the chunked run resumable.
   */
  const restartOutcomes = batch.status === IMPORT_STATUS.CONFIRMED;

  let claimed = batch;
  let outcomesCleared = false;
  if (batch.status !== IMPORT_STATUS.CONFIRMING) {
    claimed = await BatchModel.findOneAndUpdate(
      {
        _id: batch._id,
        status: batch.status,
        ...(batch.status === IMPORT_STATUS.CONFIRMED
          ? { importedCount: 0, skippedCount: 0 }
          : {}),
      },
      {
        $set: {
          status: IMPORT_STATUS.CONFIRMING,
          confirmedBy: actor?._id || null,
          confirmedAt: new Date(),
          ...(restartOutcomes ? { outcomes: [], importedCount: 0, skippedCount: 0, rejectedCount: 0 } : {}),
        },
      },
      { returnDocument: 'after' }
    ).lean();

    if (!claimed) {
      const raced = await BatchModel.findOne({ companyId, fingerprint }).lean();
      const racedRecorded =
        Number(raced?.importedCount || 0) + Number(raced?.skippedCount || 0);
      if (raced?.status === IMPORT_STATUS.CONFIRMED && racedRecorded > 0) {
        return {
          ...safeBatch(raced),
          duplicate: true,
          ...progressOf(raced, Number(raced.rowCount || 0)),
        };
      }
      // Two requests started the same file at the same instant: one claimed
      // it, this one CONTINUES it instead of refusing. Rows are idempotent,
      // so both can safely make progress, and there is no dead end left
      // anywhere on this path.
      if (raced?.status === IMPORT_STATUS.CONFIRMING) {
        claimed = raced;
      } else {
        throw ApiError.conflict('This file cannot be imported in its current state');
      }
    } else if (restartOutcomes) {
      outcomesCleared = true;
    }
  }

  const EventModel = deps.EventModel || AttendanceEvent;
  const record = deps.recordEvent || recordEvent;

  // Everything the file contains, and everything already answered.
  const totalCount = new Set([
    ...validated.valid.map((row) => row.line),
    ...validated.invalid.map((row) => row.line),
  ]).size;

  const outcomeMap = new Map(
    (outcomesCleared ? [] : Array.isArray(claimed.outcomes) ? claimed.outcomes : []).map(
      (outcome) => [Number(outcome.line), outcome]
    )
  );
  const isPending = (row) => !outcomeMap.has(Number(row.line));

  // Rows the validator already refused cost nothing — record them now.
  for (const row of validated.invalid) {
    if (!isPending(row)) continue;
    outcomeMap.set(row.line, {
      line: row.line,
      employeeCode: row.employeeCode,
      status: 'REJECTED',
      message: row.message,
    });
  }

  // Sequential chronological ingest — VALID_ROWS_ONLY, bounded by the budget
  // so the request always returns inside the client's timeout. At least one
  // row is always attempted, so a slow single row still makes progress.
  const startedMs = clockMs();
  let chunkCount = 0;
  for (const row of validated.valid) {
    if (!isPending(row)) continue;
    if (chunkCount > 0 && clockMs() - startedMs >= budget) break;
    chunkCount += 1;

    const requestId = `import:${claimed._id}:${row.line}`;
    if (row.alreadyRecorded) {
      outcomeMap.set(row.line, {
        line: row.line,
        employeeCode: row.employeeCode,
        status: 'SKIPPED',
        message: 'Already recorded — skipped',
      });
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
        outcomeMap.set(row.line, {
          line: row.line,
          employeeCode: row.employeeCode,
          status: 'SKIPPED',
          message: 'Already recorded — skipped',
        });
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
      outcomeMap.set(row.line, {
        line: row.line,
        employeeCode: row.employeeCode,
        status: 'IMPORTED',
        eventType: row.eventType,
        at: new Date(row.occurredAt),
      });
    } catch (error) {
      // VALID_ROWS_ONLY: one bad row never poisons the batch.
      outcomeMap.set(row.line, {
        line: row.line,
        employeeCode: row.employeeCode,
        status: 'REJECTED',
        message: error?.message || 'Row could not be imported',
      });
    }
  }

  const outcomes = [...outcomeMap.values()].sort((a, b) => a.line - b.line);
  const counts = countOutcomes(outcomes);
  const done = outcomes.length >= totalCount;

  const finished = await BatchModel.findOneAndUpdate(
    { _id: claimed._id },
    {
      $set: {
        status: done ? IMPORT_STATUS.CONFIRMED : IMPORT_STATUS.CONFIRMING,
        validCount: validated.valid.length,
        importedCount: counts.imported,
        skippedCount: counts.skipped,
        rejectedCount: counts.rejected,
        outcomes,
        ...(done ? { confirmedAt: new Date() } : {}),
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
      importedCount: counts.imported,
      skippedCount: counts.skipped,
      rejectedCount: counts.rejected,
      done,
      processedCount: outcomes.length,
    },
  }).catch(() => {});

  const settled = finished || { ...claimed, outcomes, importedCount: counts.imported, skippedCount: counts.skipped, rejectedCount: counts.rejected };

  return {
    ...safeBatch(settled),
    duplicate: false,
    chunkCount,
    ...progressOf(settled, totalCount),
  };
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
