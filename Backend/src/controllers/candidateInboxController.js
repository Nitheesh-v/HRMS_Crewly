import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { recordAudit } from '../utils/securityauditService.js';
import {
  getCandidateInboxDetail,
  getCandidateResumeAccess,
  listCandidateInbox,
} from '../services/candidateInboxService.js';

export const candidateInboxList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const query = req.query;

  // DB Logic - DB logics
  const result = await listCandidateInbox({
    companyId: req.companyId,
    query,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Candidates fetched',
    data: result.candidates,
    meta: result.meta,
  });
});

export const candidateInboxDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateRef } = req.params;

  // DB Logic - DB logics
  const candidate = await getCandidateInboxDetail({
    companyId: req.companyId,
    candidateRef,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Candidate fetched',
    data: candidate,
  });
});

export const candidateResumeDownload = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { candidateRef } = req.params;

  // DB Logic - DB logics
  const result = await getCandidateResumeAccess({
    companyId: req.companyId,
    candidateRef,
  });

  await recordAudit({
    req,
    action: 'Candidate resume accessed',
    companyId: req.companyId,
    resource: 'Candidate',
    resourceId: result.candidate._id,
    statusCode: 200,
    metadata: {
      candidateCode: result.candidate.candidateCode,
      resumeScanStatus: result.resume.scanStatus,
    },
    critical: true,
  });

  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  // Data to frontend - response to frontend
  if (result.access.type === 'SIGNED_URL') {
    const upstream = await fetch(result.access.url, {
      redirect: 'follow',
    });

    if (!upstream.ok || !upstream.body) {
      throw new ApiError(502, 'Resume is temporarily unavailable');
    }

    res.type(result.resume.mimeType);
    res.attachment(result.resume.originalFileName);
    await pipeline(Readable.fromWeb(upstream.body), res);
    return undefined;
  }

  res.type(result.resume.mimeType);
  await new Promise((resolve, reject) => {
    res.download(
      result.access.filePath,
      result.resume.originalFileName,
      (error) => (error ? reject(error) : resolve())
    );
  });

  return undefined;
});
