// ─────────────────────────────────────────────────────────────
// Phase 31.14 — shared alternate-source ingest helpers.
//
// Small server-side-only helpers shared by the kiosk + import
// adapters (QR resolves identity from the employee session, not
// from a code — it only shares the month guard):
//   - resolveEmployeeByCode: tenant-scoped ACTIVE lookup
//   - assertIngestMonthOpen: 31.11 finalized-month protection
// Neither helper is reachable from any client directly.
// ─────────────────────────────────────────────────────────────

import mongoose from 'mongoose';
import ApiError from '../../utils/ApiError.js';
import { isMonthLockedForIngest } from './attendanceSourceRules.js';
import User from '../../models/User.js';
import AttendancePeriod from '../../models/AttendancePeriod.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Tenant-scoped ACTIVE employee resolution by employee code.
// Case-insensitive (strength:2) so legacy mixed-case codes keep
// working; tenant + status filters keep it exact.
export const resolveEmployeeByCode = async ({ companyId, employeeCode, deps = {} } = {}) => {
  const code = String(employeeCode || '').trim();
  if (!mongoose.isValidObjectId(companyId) || !code) return null;
  try {
    const UserModel = deps.UserModel || User;
    const user = await UserModel.findOne({ companyId, employeeCode: code, status: 'ACTIVE' })
      .collation({ locale: 'en', strength: 2 })
      .select('_id companyId name employeeCode status role')
      .lean();
    return user || null;
  } catch {
    return null;
  }
};

// 31.11 protection: locked months refuse ingestion with a message
// that points at the authorized reopen workflow. Missing period =
// OPEN (31.11 convention). No skip flag exists by design.
export const assertIngestMonthOpen = async ({ companyId, month, deps = {} } = {}) => {
  if (!MONTH_RE.test(String(month || ''))) {
    throw ApiError.badRequest('month must be YYYY-MM');
  }
  const PeriodModel = deps.PeriodModel || AttendancePeriod;
  const period = await PeriodModel.findOne({ companyId, month }).select('status').lean();
  if (isMonthLockedForIngest(period?.status)) {
    throw ApiError.conflict(
      `Attendance for ${month} is ${period.status}. Reopen it through Attendance Finalization before adding events.`
    );
  }
  return period?.status || 'OPEN';
};
