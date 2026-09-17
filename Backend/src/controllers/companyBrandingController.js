// ─────────────────────────────────────────────────────────────
// Company Branding — tenant logo + document branding settings.
//
// Reads are safe for any member; every mutation is COMPANY_ADMIN only
// (checked in routes). Historical documents are never touched here —
// branding applies at generation time only.
// ─────────────────────────────────────────────────────────────
import Company from '../models/Company.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import brandingService, { getSafeBranding } from '../services/companyBrandingService.js';
import { resolveCompanyLogo } from '../utils/companyLogo.js';
import { buildPayslipPdf } from '../utils/payslipPdf.js';
import { buildSamplePayslipSnapshot } from '../utils/payslipTemplates.js';

// GET /api/companies/my/branding — any logged-in member can view
export const getBranding = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  // DB Logic - DB logics
  const company = await Company.findOne({ _id: companyId });
  if (!company || company.archivedAt) throw ApiError.notFound('Company not found');
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Company branding', data: getSafeBranding(company) });
});

// POST /api/companies/my/branding/logo — COMPANY_ADMIN only (checked in routes)
export const uploadLogo = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { companyId, user, file } = req;
  // DB Logic - DB logics
  const branding = await brandingService.uploadLogo({ companyId, actor: user, file });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Company logo updated', data: branding });
});

// DELETE /api/companies/my/branding/logo — COMPANY_ADMIN only (checked in routes)
export const removeLogo = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { companyId, user } = req;
  // DB Logic - DB logics
  const branding = await brandingService.removeLogo({ companyId, actor: user });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Company logo removed', data: branding });
});

// PUT /api/companies/my/branding — COMPANY_ADMIN only (checked in routes)
export const updateSettings = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { layout, documentBranding } = req.body || {};
  // DB Logic - DB logics
  const branding = await brandingService.updateSettings({
    companyId: req.companyId,
    actor: req.user,
    layout,
    documentBranding,
  });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Branding settings updated', data: branding });
});

// POST /api/companies/my/branding/payslip-preview — COMPANY_ADMIN only.
// Visual preview only: sample data, SAMPLE watermark, no Payslip record,
// no payslip number, no email, no payroll changes of any kind.
export const previewPayslip = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { templateId, layout } = req.body || {};
  // DB Logic - DB logics
  const company = await Company.findOne({ _id: req.companyId });
  if (!company || company.archivedAt) throw ApiError.notFound('Company not found');
  const brandingSnapshot = brandingService.buildBrandingSnapshot(company, 'PAYSLIP', {
    templateId,
    layout,
  });
  const logoUrl = company?.branding?.logo?.deliveryUrl || '';
  const logo = logoUrl ? await resolveCompanyLogo(logoUrl) : null;
  const snapshot = buildSamplePayslipSnapshot({
    companyName: company.name,
    address: company.address,
    logoUrl,
    brandingSnapshot,
  });
  const buffer = await buildPayslipPdf(snapshot, {
    logo,
    templateId: brandingSnapshot.templateId,
    layout: brandingSnapshot.layout,
    preview: true,
  });
  // Data to frontend - response to frontend
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="payslip-preview-${brandingSnapshot.templateId}.pdf"`
  );
  return res.send(buffer);
});
