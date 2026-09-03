// ============================================================
//  PHASE 30.1 — BGV CHECK FRAMEWORK · HTTP layer
//
//  Thin controllers: request extraction → service call →
//  ApiResponse. Tenant authority is only ever req.companyId.
// ============================================================

import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { hasPermission } from '../utils/permissionService.js';
import {
  addEvidence,
  assignVerifier,
  extendSla,
  getCheck,
  getEvidenceFile,
  listChecks,
  reopenCheck,
  seedChecksForCase,
  updateStatus,
  workbenchStats,
} from '../services/bgv/bgvCheckService.js';

// The service enforces "own checks" vs "all checks" from these
// flags; the route middleware enforces the coarse permission.
const buildActor = async (req) => ({
  userId: String(req.user._id),
  canReadAll: await hasPermission(req.user, 'BGV_CHECK_READ_ALL'),
  canReopen: await hasPermission(req.user, 'BGV_CHECK_REOPEN'),
});

export const bgvCheckList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { page, limit, ...filters } = req.query || {};
  // DB Logic - DB logics
  const actor = await buildActor(req);
  const result = await listChecks({
    companyId: req.companyId,
    actor,
    filters,
    page: Number(page) || 1,
    limit: Number(limit) || 25,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV checks fetched',
    data: result.checks,
    meta: result.meta,
  });
});

export const bgvCheckMine = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { page, limit, ...filters } = req.query || {};
  // DB Logic - DB logics
  const actor = await buildActor(req);
  const result = await listChecks({
    companyId: req.companyId,
    actor,
    filters: { ...filters, assignedToMe: true },
    page: Number(page) || 1,
    limit: Number(limit) || 25,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'My BGV checks fetched',
    data: result.checks,
    meta: result.meta,
  });
});

export const bgvCheckStats = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  // DB Logic - DB logics
  const actor = await buildActor(req);
  const data = await workbenchStats({ companyId: req.companyId, actor });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV workbench stats fetched',
    data,
  });
});

export const bgvCheckDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { checkId } = req.params;
  // DB Logic - DB logics
  const actor = await buildActor(req);
  const data = await getCheck({ companyId: req.companyId, checkId, actor });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV check fetched',
    data,
  });
});

export const bgvCheckAssign = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { checkId } = req.params;
  const verifierId = req.body?.verifierId;
  // DB Logic - DB logics
  const data = await assignVerifier({
    companyId: req.companyId,
    checkId,
    verifierId,
    actorId: String(req.user._id),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Verifier assigned',
    data,
  });
});

export const bgvCheckStatusUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { checkId } = req.params;
  const { entryKey, toStatus, ...payload } = req.body || {};
  // DB Logic - DB logics
  const actor = await buildActor(req);
  const data = await updateStatus({
    companyId: req.companyId,
    checkId,
    entryKey: entryKey || null,
    toStatus,
    payload,
    actor,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV check status updated',
    data,
  });
});

export const bgvCheckEvidenceAdd = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { checkId } = req.params;
  const { entryKey, kind, note, meta } = req.body || {};
  if (!req.file && req.error) throw req.error;
  // DB Logic - DB logics
  const data = await addEvidence({
    companyId: req.companyId,
    checkId,
    entryKey,
    kind,
    note: note || '',
    meta: meta || {},
    file: req.file || null,
    actor: { userId: String(req.user._id), canReadAll: await hasPermission(req.user, 'BGV_CHECK_READ_ALL') },
    requestContext: req,
  });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'Evidence added',
    data,
  });
});

export const bgvCheckEvidenceDownload = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { checkId, evidenceId } = req.params;
  // DB Logic - DB logics
  const actor = await buildActor(req);
  const file = await getEvidenceFile({ companyId: req.companyId, checkId, evidenceId, actor });
  // Data to frontend - response to frontend (streamed private bytes)
  const safeName = String(file.filename || 'evidence').replace(/[^\w.\-]/g, '_').slice(0, 120);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).send(file.buffer);
});

export const bgvCheckExtendSla = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { checkId } = req.params;
  const { days, reason } = req.body || {};
  // DB Logic - DB logics
  const data = await extendSla({
    companyId: req.companyId,
    checkId,
    days,
    reason,
    actor: { userId: String(req.user._id), canReadAll: await hasPermission(req.user, 'BGV_CHECK_READ_ALL') },
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'SLA extended',
    data,
  });
});

export const bgvCheckReopen = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { checkId } = req.params;
  const reason = req.body?.reason;
  // DB Logic - DB logics
  const data = await reopenCheck({
    companyId: req.companyId,
    checkId,
    reason,
    actor: { userId: String(req.user._id), canReadAll: true },
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV check reopened',
    data,
  });
});

export const bgvCaseSeedChecks = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { caseId } = req.params;
  // DB Logic - DB logics
  const data = await seedChecksForCase({
    companyId: req.companyId,
    caseId,
    actorId: String(req.user._id),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV checks seeded',
    data,
  });
});
