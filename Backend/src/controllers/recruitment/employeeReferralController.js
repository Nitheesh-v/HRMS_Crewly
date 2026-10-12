// ═══════════════════════════════════════════════════════════════════════════
//  EMPLOYEE REFERRAL CONTROLLER (HTTP layer)
//
//  Three thin handlers, repo's three-comment convention.
//
//  IDENTITY RULE
//    companyId and the referrer's id come from the token/middleware
//    (req.companyId, req.user) — never from the body. The job is addressed
//    by its in-tenant jobCode; the service re-verifies that it belongs to
//    the caller's tenant and is actually posted.
//
//  GATES
//    No permission gate on purpose: every authenticated employee of the
//    tenant may see posted openings and refer. Writes still pass the
//    subscription gates at the router. "My referrals" is self-scoped in the
//    service; nobody can read another employee's referral list.
// ═══════════════════════════════════════════════════════════════════════════

import ApiResponse from '../../utils/ApiResponse.js';
import asyncHandler from '../../utils/asyncHandler.js';
import {
  listMyReferrals,
  listReferralOpenings,
  submitReferral,
} from '../../services/recruitment/employeeReferralService.js';

// GET /api/referrals/openings
export const listOpenings = asyncHandler(async (req, res) => {
  // Data from frontend - nothing (companyId comes from the token)
  // DB Logic - posted + open jobs of this tenant, referral-safe fields
  const { openings } = await listReferralOpenings({ companyId: req.companyId });

  // Data to frontend - the openings employees can refer into
  return ApiResponse.success(res, { message: 'Openings fetched', data: { openings } });
});

// POST /api/referrals/:jobCode
export const referCandidate = asyncHandler(async (req, res) => {
  // Data from frontend - jobCode (URL) + candidate name/email/phone/notes (body)
  // DB Logic - validates the job is posted for this tenant, dedupes, creates
  //            the REFERRAL candidate + history
  const { referral } = await submitReferral({
    companyId: req.companyId,
    userId: req.user._id,
    jobCode: req.params.jobCode,
    input: req.body || {},
  });

  // Data to frontend - the created referral (for the success toast)
  return ApiResponse.created(res, {
    message: 'Referral submitted — thank you!',
    data: { referral },
  });
});

// GET /api/referrals/mine
export const listMine = asyncHandler(async (req, res) => {
  // DB Logic - only the caller's referrals, tenant-scoped, live stage
  const { referrals } = await listMyReferrals({
    companyId: req.companyId,
    userId: req.user._id,
  });

  // Data to frontend - the referrer's own list
  return ApiResponse.success(res, { message: 'Referrals fetched', data: { referrals } });
});
