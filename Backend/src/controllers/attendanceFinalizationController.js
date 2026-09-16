import {
  finalizeMonth,
  getFinalizationStatus,
  previewFinalization,
  reopenMonth,
  sendToPayroll,
  validateFinalization,
} from "../services/attendance/attendanceFinalizationService.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

// ============================================================
// PHASE 31.11 — MONTHLY ATTENDANCE FINALIZATION & PAYROLL SYNC
// Controlled boundary: validate → finalize (freeze) → send to
// payroll (sync snapshots into 29.5 auto) → reopen (reasoned).
// All derivation, gating and syncing live in the service; this
// controller only moves the month + reason across.
// ============================================================

export const getFinalization = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params || {};

  // DB Logic - DB logics
  const status = await getFinalizationStatus({
    companyId: req.companyId,

    actor: req.user,

    month,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Attendance finalization status",

    data: status,
  });
});

export const validateFinalizationMonth = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params || {};

  // DB Logic - DB logics
  const report = await validateFinalization({
    companyId: req.companyId,

    actor: req.user,

    month,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Attendance finalization validation",

    data: report,
  });
});

export const previewFinalizationMonth = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params || {};

  // DB Logic - DB logics
  const preview = await previewFinalization({
    companyId: req.companyId,

    actor: req.user,

    month,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Attendance finalization preview",

    data: preview,
  });
});

export const finalizeAttendanceMonth = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params || {};

  // DB Logic - DB logics
  const result = await finalizeMonth({
    companyId: req.companyId,

    actor: req.user,

    month,

    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result?.alreadyFinalized
      ? "Attendance already finalized"
      : "Attendance finalized",

    data: result,
  });
});

export const sendAttendanceToPayroll = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params || {};

  // DB Logic - DB logics
  const result = await sendToPayroll({
    companyId: req.companyId,

    actor: req.user,

    month,

    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result?.alreadySent
      ? "Attendance already sent to payroll"
      : "Attendance sent to payroll",

    data: result,
  });
});

export const reopenAttendanceMonth = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { month } = req.params || {};
  const { reason } = req.body || {};

  // DB Logic - DB logics
  const result = await reopenMonth({
    companyId: req.companyId,

    actor: req.user,

    month,

    reason,

    req,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Attendance reopened",

    data: result,
  });
});
