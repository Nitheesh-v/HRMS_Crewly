// ─────────────────────────────────────────────────────────────
// Company Branding — the ONE tenant branding authority (§15).
//
// Centralizes: current-branding resolution, safe serialization,
// upload/replace/remove, settings, branding-snapshot creation and
// fallback initials. No PDF generator interprets branding on its own.
//
// Injectable { companyModel, audit, inspectFile, storage, clock } for
// hermetic tests; the default export wires the real infrastructure.
// ─────────────────────────────────────────────────────────────
import Company from '../models/Company.js';
import AuditLog from '../models/AuditLog.js';
import ApiError from '../utils/ApiError.js';
import cloudinary, { cloudinaryReady } from '../config/cloudinary.js';
import { inspectPreOnboardingFile } from './recruitment/preOnboardingDocumentSecurityService.js';
import {
  DEFAULT_LOGO_LAYOUT,
  IMAGE_FIT,
  LOGO_ALIGNMENT,
  LOGO_ALLOWED_MIME_TYPES,
  LOGO_DISPLAY_BOUNDS,
  LOGO_MAX_BYTES,
  assertSaneSourceDimensions,
  assertValidLogoLayout,
  assertValidPayslipTemplateId,
  initialsOf,
  sanitizeLogoLayout,
  sanitizePayslipTemplateId,
  snapshotBranding,
} from './companyBrandingRules.js';

const streamToCloudinary = (buffer, options) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (err, result) => (err ? reject(err) : resolve(result)))
      .end(buffer);
  });

// Default storage: Cloudinary when configured, inline data: URL fallback
// (the avatar-upload precedent). One stable public_id per company, so a
// replacement overwrites in place and never orphans stored assets.
export const defaultBrandingStorage = {
  save: async ({ buffer, mimeType, companyId }) => {
    if (cloudinaryReady) {
      try {
        const result = await streamToCloudinary(buffer, {
          folder: `crewly/logos/${companyId}`,
          public_id: `company-${companyId}`,
          overwrite: true,
          resource_type: 'image',
          transformation: [{ width: 800, crop: 'limit' }],
        });
        return {
          provider: 'CLOUDINARY',
          publicId: result.public_id,
          deliveryUrl: result.secure_url,
        };
      } catch (error) {
        console.warn('☁️  Cloudinary logo upload failed, inline fallback used:', error?.message);
      }
    }
    return {
      provider: 'INLINE',
      publicId: '',
      deliveryUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    };
  },
  remove: async (logo) => {
    if (logo?.provider === 'CLOUDINARY' && logo?.publicId && cloudinaryReady) {
      try {
        await cloudinary.uploader.destroy(logo.publicId);
      } catch {
        // Best-effort cleanup — branding removal never fails on storage.
      }
    }
  },
};

const toBadRequest = (error) => {
  if (error instanceof ApiError) return error;
  return ApiError.badRequest(error?.message || 'Invalid branding data');
};

// Safe serialization: delivery reference + display metadata only. Never
// storage internals (publicId), never uploader identity, never bytes.
export const getSafeBranding = (company) => {
  const logo = company?.branding?.logo || null;
  const hasLogo = Boolean(logo?.deliveryUrl);
  const payslip = company?.documentBranding?.payslip || {};
  const payslipLogo = payslip?.logo || {};
  return {
    hasLogo,
    logo: hasLogo
      ? {
          deliveryUrl: logo.deliveryUrl,
          mimeType: logo.mimeType || '',
          bytes: logo.bytes || 0,
          width: logo.width || 0,
          height: logo.height || 0,
          version: logo.version || 0,
          uploadedAt: logo.uploadedAt || null,
        }
      : null,
    layout: sanitizeLogoLayout(company?.branding?.layout),
    documentBranding: {
      payslip: {
        templateId: sanitizePayslipTemplateId(payslip?.templateId),
        logo: {
          width: payslipLogo.width ?? null,
          maxHeight: payslipLogo.maxHeight ?? null,
          fit: payslipLogo.fit ?? null,
          alignment: payslipLogo.alignment ?? null,
        },
      },
      offer: {
        useCompanyLogo: company?.documentBranding?.offer?.useCompanyLogo !== false,
      },
    },
  };
};

const pick = (value, fallback) => (value === undefined || value === null ? fallback : value);

export const createCompanyBrandingService = (deps = {}) => {
  const {
    companyModel = Company,
    audit = (entry) => AuditLog.create(entry),
    inspectFile = inspectPreOnboardingFile,
    storage = defaultBrandingStorage,
    clock = () => new Date(),
  } = deps;

  const mustFindCompany = async (companyId) => {
    const company = await companyModel.findOne({ _id: companyId });
    if (!company || company.archivedAt) throw ApiError.notFound('Company not found');
    return company;
  };

  // §26 — the resolver contract. Generators resolve through this (or a
  // document snapshot); they never accept a logoUrl from a request body.
  const resolveCompanyBranding = async ({ companyId }) => {
    const company = await mustFindCompany(companyId);
    const safe = getSafeBranding(company);
    return {
      companyName: company?.name || '',
      hasLogo: safe.hasLogo,
      logoResource: safe.hasLogo
        ? {
            deliveryUrl: safe.logo.deliveryUrl,
            mimeType: safe.logo.mimeType,
            version: safe.logo.version,
          }
        : null,
      initials: initialsOf(company?.name),
      layout: safe.layout,
      documentBranding: safe.documentBranding,
    };
  };

  const uploadLogo = async ({ companyId, actor, file }) => {
    if (!file?.buffer?.length) {
      throw ApiError.badRequest('Attach a logo image as field "logo"');
    }
    const company = await mustFindCompany(companyId);

    let inspection;
    try {
      inspection = await inspectFile({
        file,
        allowedMimeTypes: [...LOGO_ALLOWED_MIME_TYPES],
        maxFileSize: LOGO_MAX_BYTES,
      });
    } catch (error) {
      throw toBadRequest(error);
    }

    let dimensions;
    try {
      dimensions = assertSaneSourceDimensions(file.buffer, inspection.mimeType);
    } catch (error) {
      throw toBadRequest(error);
    }

    const prev = company?.branding?.logo || null;
    const stored = await storage.save({
      buffer: file.buffer,
      mimeType: inspection.mimeType,
      companyId: String(companyId),
    });
    const version = (Number(prev?.version) || 0) + 1;

    company.set('branding.logo', {
      provider: stored.provider,
      publicId: stored.publicId || '',
      deliveryUrl: stored.deliveryUrl,
      mimeType: inspection.mimeType,
      bytes: file.buffer.length,
      width: dimensions.width,
      height: dimensions.height,
      version,
      uploadedAt: clock(),
      uploadedBy: actor?._id || actor?.id || null,
    });
    // Backwards-compatible mirror for existing readers (career portal,
    // super-admin company view, stored snapshots). Service-written only.
    company.logoUrl = stored.deliveryUrl;
    await company.save();

    if (prev?.provider === 'CLOUDINARY' && prev.publicId && prev.publicId !== stored.publicId) {
      await storage.remove(prev);
    }

    await audit({
      companyId,
      actor: actor?._id || actor?.id || null,
      actorName: actor?.name || '',
      actorRole: actor?.role || '',
      action: prev?.deliveryUrl ? 'COMPANY_LOGO_REPLACED' : 'COMPANY_LOGO_UPLOADED',
      method: 'POST',
      path: '/api/companies/my/branding/logo',
      statusCode: 200,
      metadata: {
        version,
        mimeType: inspection.mimeType,
        bytes: file.buffer.length,
        width: dimensions.width,
        height: dimensions.height,
      },
    });

    return getSafeBranding(company);
  };

  const removeLogo = async ({ companyId, actor }) => {
    const company = await mustFindCompany(companyId);
    const logo = company?.branding?.logo || null;
    if (!logo?.deliveryUrl) return getSafeBranding(company);

    await storage.remove(logo);
    company.set('branding.logo', {
      provider: '',
      publicId: '',
      deliveryUrl: '',
      mimeType: '',
      bytes: 0,
      width: 0,
      height: 0,
      version: logo.version || 0,
      uploadedAt: null,
      uploadedBy: null,
    });
    company.logoUrl = '';
    await company.save();

    await audit({
      companyId,
      actor: actor?._id || actor?.id || null,
      actorName: actor?.name || '',
      actorRole: actor?.role || '',
      action: 'COMPANY_LOGO_REMOVED',
      method: 'DELETE',
      path: '/api/companies/my/branding/logo',
      statusCode: 200,
      metadata: { version: logo.version || 0 },
    });

    return getSafeBranding(company);
  };

  const updateSettings = async ({ companyId, actor, layout, documentBranding }) => {
    const company = await mustFindCompany(companyId);
    const changed = [];

    if (layout !== undefined) {
      let asserted;
      try {
        asserted = assertValidLogoLayout({
          ...sanitizeLogoLayout(company?.branding?.layout),
          ...(layout || {}),
        });
      } catch (error) {
        throw toBadRequest(error);
      }
      company.set('branding.layout', asserted);
      changed.push('layout');
    }

    const payslip = documentBranding?.payslip;
    if (payslip !== undefined) {
      if (payslip?.templateId !== undefined) {
        try {
          assertValidPayslipTemplateId(payslip.templateId);
        } catch (error) {
          throw toBadRequest(error);
        }
        company.set('documentBranding.payslip.templateId', payslip.templateId);
        changed.push('payslip.templateId');
      }
      const overrides = payslip?.logo;
      if (overrides !== undefined) {
        const { widthMin, widthMax, heightMin, heightMax } = LOGO_DISPLAY_BOUNDS;
        const width = pick(overrides?.width, null);
        const maxHeight = pick(overrides?.maxHeight, null);
        const fit = pick(overrides?.fit, null);
        const alignment = pick(overrides?.alignment, null);
        // null = inherit the company default (§10: overrides, not copies).
        if (width !== null && (!Number.isInteger(width) || width < widthMin || width > widthMax)) {
          throw ApiError.badRequest(`Payslip logo width must be ${widthMin}–${widthMax}`);
        }
        if (
          maxHeight !== null &&
          (!Number.isInteger(maxHeight) || maxHeight < heightMin || maxHeight > heightMax)
        ) {
          throw ApiError.badRequest(`Payslip logo max height must be ${heightMin}–${heightMax}`);
        }
        if (fit !== null && !IMAGE_FIT[fit]) {
          throw ApiError.badRequest('Payslip logo fit must be CONTAIN or COVER');
        }
        if (alignment !== null && !LOGO_ALIGNMENT[alignment]) {
          throw ApiError.badRequest('Payslip logo alignment must be LEFT, CENTER or RIGHT');
        }
        company.set('documentBranding.payslip.logo', { width, maxHeight, fit, alignment });
        changed.push('payslip.logo');
      }
    }

    const offer = documentBranding?.offer;
    if (offer?.useCompanyLogo !== undefined) {
      company.set('documentBranding.offer.useCompanyLogo', offer.useCompanyLogo !== false);
      changed.push('offer.useCompanyLogo');
    }

    if (!changed.length) return getSafeBranding(company);
    await company.save();

    await audit({
      companyId,
      actor: actor?._id || actor?.id || null,
      actorName: actor?.name || '',
      actorRole: actor?.role || '',
      action: 'COMPANY_BRANDING_UPDATED',
      method: 'PUT',
      path: '/api/companies/my/branding',
      statusCode: 200,
      metadata: { fields: changed },
    });

    return getSafeBranding(company);
  };

  // Addition §14 — pure snapshot via the shared rules (payroll rules import
  // the rules module directly, without dragging models along).
  const buildBrandingSnapshot = (company, docType, overrides = {}) =>
    snapshotBranding(company, docType, overrides);

  return {
    getSafeBranding,
    resolveCompanyBranding,
    uploadLogo,
    removeLogo,
    updateSettings,
    buildBrandingSnapshot,
  };
};

export default createCompanyBrandingService();

// Re-exported so callers keep one import surface.
export { DEFAULT_LOGO_LAYOUT };
