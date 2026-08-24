import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { recordAudit } from '../utils/securityauditService.js';
import {
  createOfferTemplate,
  deactivateOfferTemplate,
  getOfferTemplate,
  listOfferTemplates,
  updateOfferTemplate,
} from '../services/offerTemplateService.js';

const auditTemplate = async ({ req, action, template }) =>
  recordAudit({
    req,
    action,
    companyId: req.companyId,
    resource: 'OfferTemplate',
    resourceId: template._id,
    metadata: { name: template.name, version: template.version, isDefault: template.isDefault },
    critical: true,
  });

export const offerTemplateList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const includeInactive = req.query.includeInactive === 'true';
  // DB Logic - DB logics
  const result = await listOfferTemplates({ companyId: req.companyId, actorId: req.user._id, includeInactive });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer templates fetched', data: result.templates, meta: { supportedVariables: result.supportedVariables } });
});

export const offerTemplateDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { templateId } = req.params;
  // DB Logic - DB logics
  const template = await getOfferTemplate({
    companyId: req.companyId,
    templateId,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Offer template fetched',
    data: template,
  });
});

export const offerTemplateCreate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const payload = req.body;
  // DB Logic - DB logics
  const template = await createOfferTemplate({ companyId: req.companyId, actorId: req.user._id, payload });
  await auditTemplate({ req, action: 'OFFER_TEMPLATE_CREATED', template });
  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: 'Offer template created', data: template });
});

export const offerTemplateUpdate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { templateId } = req.params;
  const payload = req.body;
  // DB Logic - DB logics
  const template = await updateOfferTemplate({ companyId: req.companyId, actorId: req.user._id, templateId, payload });
  await auditTemplate({ req, action: 'OFFER_TEMPLATE_UPDATED', template });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer template updated', data: template });
});

export const offerTemplateDeactivate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { templateId } = req.params;
  // DB Logic - DB logics
  const template = await deactivateOfferTemplate({ companyId: req.companyId, actorId: req.user._id, templateId });
  await auditTemplate({ req, action: 'OFFER_TEMPLATE_DEACTIVATED', template });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Offer template deactivated', data: template });
});
