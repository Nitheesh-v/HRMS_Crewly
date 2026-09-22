// ============================================================
// 📄 DOCUMENT CONTROLLER — My Documents (Phase 9)
// Phase 32.8: uploads are PRIVATE Cloudinary `authenticated`
// objects (no permanent public URL) with a dev inline fallback;
// delivery is the authorization-gated GET /documents/:id/file.
// Storage failure in production fails LOUD (503) — Mongo never
// claims a durable file that was not stored.
// Phase 13: Admin/HR 🔔 on upload + 📧 via queue (fire & forget)
// ============================================================
import * as DocumentNS from '../models/Document.js';
import logger from '../config/logger.js';
import { sanitizeText as safeErrorText } from '../infrastructure/observability/redaction.js';
import cloudinary, { cloudinaryReady } from '../config/cloudinary.js';
import * as asyncHandlerNS from '../utils/asyncHandler.js';
import User from '../models/User.js';
import { notifySmart } from '../utils/notifyPref.js';
import crypto from 'node:crypto';
import { uploadPrivateAsset, destroyPrivateAsset, getPrivateAssetSignedUrl } from '../infrastructure/storage/privateCloudinaryAsset.js';
import { classifyUploadedAsset, legacyRowDeliveryInput, resolvePrivateFileDelivery } from '../services/privateFileDelivery.js';
import ApiError from '../utils/ApiError.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const Document = pickModel(DocumentNS);
const asyncHandler = typeof asyncHandlerNS.default === 'function' ? asyncHandlerNS.default : asyncHandlerNS.asyncHandler;

// Same HR set the HR file cabinet enforces (employeeDocsController).
export const HR_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];

/**
 * §63 authorization predicate — pure + exported for hermetic tests.
 * The file endpoint serves a document only to its OWNER or to HR of
 * the same company. A known document id/storage key grants nothing.
 */
export const canViewDocumentFile = (actor, doc) => {
  if (!actor || !doc) return false;

  if (doc.companyId && String(doc.companyId) !== String(actor.companyId || '')) return false;

  if (doc.user && actor._id && String(doc.user) === String(actor._id)) return true;

  return HR_ROLES.includes(actor.role);
};

const resourceTypeFor = (mimeType) => (/^image\//.test(mimeType || '') ? 'image' : 'raw');

const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Attach a file as field "document"' });

  const name = (req.body.name || req.file.originalname || 'Document').trim();
  const category = req.body.category || 'OTHER';

  let stored = null;

  if (cloudReady()) {
    const storageKey = `crewly-private-documents/${req.companyId}/${crypto.randomUUID()}`;
    stored = await uploadPrivateAsset({
      buffer: req.file.buffer,
      storageKey,
      resourceType: resourceTypeFor(req.file.mimetype),
    }).catch((cloudErr) => {
      // Dev UX law of this controller (never a 500): inside non-production
      // the inline fallback below takes over. Production must NOT silently
      // store employee documents in Mongo — it fails loud instead.
      if (process.env.NODE_ENV === 'production') {
        throw new ApiError(503, 'Secure document storage is temporarily unavailable');
      }
      logger.warn(`[storage] private document upload failed, inline fallback used (${safeErrorText(cloudErr)})`);
      return null;
    });
  } else if (process.env.NODE_ENV === 'production') {
    // No provider configured in production = unsafe configuration (same
    // stance as the four hardened storage services).
    throw new ApiError(503, 'Secure document storage is unavailable');
  }

  const classified = classifyUploadedAsset({
    cloudResult: stored,
    file: req.file,
    allowInlineFallback: process.env.NODE_ENV !== 'production',
  });

  const doc = await Document.create({
    companyId: req.companyId,
    user: req.user._id,
    name,
    category,
    fileUrl: classified.legacyUrl, // '' for private rows
    publicId: '',                  // legacy column; private rows have none
    storageProvider: classified.storageProvider,
    storageKey: classified.storageKey,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });

  // 🔔 Phase 13: tell Admin/HR a document arrived (fire & forget — the upload never waits)
  try {
    // DB Logic - DB logics
    const bosses = await User.find({ companyId: req.companyId, role: { $in: ['COMPANY_ADMIN', 'HR_MANAGER'] } }).select('_id');
    bosses.forEach((b) => notifySmart(b._id, {
      title: '📄 Document uploaded',
      message: `${req.user.name || 'An employee'} uploaded "${doc.name}"`,
      link: '/app/documents',
      category: 'DOCUMENT',
    }));
  } catch (e) { /* never block uploads */ }

  res.status(201).json({ success: true, message: 'Document uploaded 📄', data: { ...doc.toObject(), storageKey: undefined, fileUrl: doc.fileUrl || undefined } });
});

const myDocuments = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const docs = await Document.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
  // Data to frontend - response to frontend
  res.json({ success: true, data: docs });
});

/**
 * GET /documents/:id/file — the ONLY delivery path for document bytes.
 * Authorization first (owner or same-company HR — §63), then delivery:
 *   private row  → 302 to a ≤5-minute signed provider URL (after authz)
 *   legacy row   → 302 to its stored URL, now reachable ONLY from here
 *   inline row   → 200 bytes (dev fallback), private + attachment
 */
const getDocumentFile = asyncHandler(async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id }).select('+storageKey');

  if (!doc || !canViewDocumentFile(req.user, doc)) throw ApiError.notFound('Document not found');

  const delivery = resolvePrivateFileDelivery({
    ...legacyRowDeliveryInput(doc, { legacyUrlField: 'fileUrl' }),
    signedUrlResolver: ({ storageKey, resourceType }) =>
      getPrivateAssetSignedUrl({ storageKey, resourceType, attachment: true }),
  });

  if (delivery.kind === 'SIGNED_URL') {
    res.set('Cache-Control', 'private, no-store');
    return res.redirect(302, delivery.url);
  }

  if (delivery.kind === 'REDIRECT') {
    res.set('Cache-Control', 'private, no-store');
    return res.redirect(302, delivery.url);
  }

  const safeName = sanitizeDownloadName(doc.name);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', delivery.contentType || doc.mimeType || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${safeName}"`);
  return res.status(200).send(delivery.bytes);
});

const deleteDocument = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const doc = await Document.findOneAndDelete({ _id: req.params.id, user: req.user._id }).select('+storageKey');
  if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

  if (doc.storageProvider === 'CLOUDINARY_AUTHENTICATED' && doc.storageKey) {
    await destroyPrivateAsset({ storageKey: doc.storageKey, resourceType: resourceTypeFor(doc.mimeType) });
  } else if (cloudReady() && doc.publicId) {
    try { await cloudinaryDestroyLegacy(doc.publicId); } catch { /* ignore */ }
  }
  // Data to frontend - response to frontend
  res.json({ success: true, message: 'Document deleted', data: { id: doc._id } });
});

// ── small indirections so tests can inject without touching globals ──
const cloudReady = () => cloudinaryReady;
const cloudinaryDestroyLegacy = (publicId) => cloudinary.uploader.destroy(publicId, { resource_type: 'auto' });

const sanitizeDownloadName = (raw) =>
  String(raw || 'document')
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[/\\?%*:|<>]/g, '_')
    .slice(0, 120) || 'document';

export { uploadDocument, myDocuments, getDocumentFile, deleteDocument, sanitizeDownloadName };
export default { uploadDocument, myDocuments, getDocumentFile, deleteDocument };
