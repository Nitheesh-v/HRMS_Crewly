import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  approveRequisition,
  createJobFromRequisition,
  createRequisition,
  getRequisition,
  getRequisitionOptions,
  listRequisitions,
  rejectRequisition,
  sendBackRequisition,
  submitRequisition,
  updateRequisition,
} from '../services/requisitionService.js';

// GET /api/recruitment/requisitions/options
export const requisitionOptions = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    companyId: req.companyId,
    user: req.user,
  };

  // DB Logic - DB logics
  const data = await getRequisitionOptions(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Requisition options fetched',
    data,
  });
});

// GET /api/recruitment/requisitions
export const requisitionList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    companyId: req.companyId,
    user: req.user,
    query: req.query,
  };

  // DB Logic - DB logics
  const result = await listRequisitions(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Requisitions fetched',
    data: result.requisitions,
    meta: {
      ...result.meta,
      summary: result.summary,
    },
  });
});

// GET /api/recruitment/requisitions/:id
export const requisitionDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    companyId: req.companyId,
    user: req.user,
    requisitionId: req.params.id,
  };

  // DB Logic - DB logics
  const data = await getRequisition(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Requisition fetched',
    data,
  });
});

// POST /api/recruitment/requisitions
export const requisitionCreate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    req,
    payload: req.body,
  };

  // DB Logic - DB logics
  const data = await createRequisition(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: `${data.requisitionNumber} saved as draft`,
    data,
  });
});

// PATCH /api/recruitment/requisitions/:id
export const requisitionUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    req,
    requisitionId: req.params.id,
    payload: req.body,
  };

  // DB Logic - DB logics
  const data = await updateRequisition(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `${data.requisitionNumber} updated`,
    data,
  });
});

// POST /api/recruitment/requisitions/:id/submit
export const requisitionSubmit = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    req,
    requisitionId: req.params.id,
    comment: req.body.comment || '',
  };

  // DB Logic - DB logics
  const data = await submitRequisition(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `${data.requisitionNumber} submitted to HR`,
    data,
  });
});

// POST /api/recruitment/requisitions/:id/approve
export const requisitionApprove = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    req,
    requisitionId: req.params.id,
    comment: req.body?.comment || '',
  };

  // DB Logic - DB logics
  const data = await approveRequisition(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `${data.requisitionNumber} approved`,
    data,
  });
});

// POST /api/recruitment/requisitions/:id/reject
export const requisitionReject = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    req,
    requisitionId: req.params.id,
    comment: req.body?.comment,
  };

  // DB Logic - DB logics
  const data = await rejectRequisition(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `${data.requisitionNumber} rejected`,
    data,
  });
});

// POST /api/recruitment/requisitions/:id/send-back
export const requisitionSendBack = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    req,
    requisitionId: req.params.id,
    comment: req.body?.comment,
  };

  // DB Logic - DB logics
  const data = await sendBackRequisition(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: `${data.requisitionNumber} sent back for changes`,
    data,
  });
});

// POST /api/recruitment/requisitions/:id/create-job
export const requisitionCreateJob = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const requestContext = {
    req,
    requisitionId: req.params.id,
    payload: req.body || {},
  };

  // DB Logic - DB logics
  const data = await createJobFromRequisition(requestContext);

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: `${data.title} job created from the approved requisition`,
    data,
  });
});
