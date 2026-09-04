// ============================================================
//  PHASE 30.1 / 30.1.1 — BGV CHECK FRAMEWORK · platform HTTP layer
//
//  Mounted inside /api/super-admin/bgv (protect + superAdminSession
//  already applied by superAdminRoutes). Execution is Crewly-team
//  only: tenant users have NO route here. Thin controllers:
//  request extraction → service call → ApiResponse.
// ============================================================

import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  addEvidence,
  assignVerifier,
  extendSla,
  getCheck,
  getEvidenceFile,
  listChecks,
  listVerifiers,
  reopenCheck,
  seedChecksForCase,
  updateStatus,
  workbenchStats,
} from '../services/bgv/bgvCheckService.js';

// req.platformPermissions was resolved by superAdminSession
// (SUPER_ADMIN holds '*' → queue operations too). Access model:
// bgv:read views, bgv:verify works the checks, bgv:assign runs
// the queue (assign/reopen/seed) — see the service header.
const buildActor = (req) => {
  const owned = req.platformPermissions || [];
  const canAssign = owned.includes('*') || owned.includes('bgv:assign');
  return {
    userId: String(req.user._id),
    canAssign,
  };
};

export const bgvCheckList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { page, limit, ...filters } = req.query || {};
  // DB Logic - DB logics
  const result = await listChecks({
    companyId: filters.companyId || null,
    actor: buildActor(req),
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
  const result = await listChecks({
    companyId: filters.companyId || null,
    actor: buildActor(req),
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
  const { companyId } = req.query || {};
  // DB Logic - DB logics
  const data = await workbenchStats({ companyId: companyId || null, actor: buildActor(req) });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV workbench stats fetched',
    data,
  });
});

export const bgvVerifierList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  // DB Logic - DB logics
  const data = await listVerifiers();
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Crewly verifier list fetched',
    data,
  });
});

export const bgvCheckDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { checkId } = req.params;
  // DB Logic - DB logics
  const data = await getCheck({ checkId, actor: buildActor(req) });
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
  const data = await assignVerifier({ checkId, verifierId, actor: buildActor(req) });
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
  const data = await updateStatus({
    checkId,
    entryKey: entryKey || null,
    toStatus,
    payload,
    actor: buildActor(req),
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
  // DB Logic - DB logics
  const data = await addEvidence({
    checkId,
    entryKey,
    kind,
    note: note || '',
    meta: meta || {},
    file: req.file || null,
    actor: buildActor(req),
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
  const file = await getEvidenceFile({ checkId, evidenceId, actor: buildActor(req) });
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
  const data = await extendSla({ checkId, days, reason, actor: buildActor(req) });
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
  const data = await reopenCheck({ checkId, reason, actor: buildActor(req) });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV check reopened',
    data,
  });
});

export const bgvCaseSeedChecks = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { caseId } = req.params;
  const companyId = req.body?.companyId || req.query?.companyId || null;
  // DB Logic - DB logics
  // Seeding is tenant-SCOPED work: the case's own companyId decides
  // ownership; a platform actor passes it only to pin the lookup.
  const data = await seedChecksForCase({
    companyId,
    caseId,
    actorId: String(req.user._id),
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'BGV checks seeded',
    data,
  });
});
