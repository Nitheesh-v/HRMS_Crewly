// ============================================================
// 📄 DOCUMENT CONTROLLER — My Documents (Phase 9)
// Hardened: cloud failure → inline fallback, never a 500.
// Phase 13: Admin/HR 🔔 on upload + 📧 via queue (fire & forget)
// ============================================================
import * as DocumentNS from '../models/Document.js';
import * as asyncHandlerNS from '../utils/asyncHandler.js';
import cloudinary, { cloudinaryReady } from '../config/cloudinary.js';
import User from '../models/User.js';
import { notifySmart } from '../utils/notifyPref.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const Document = pickModel(DocumentNS);
const asyncHandler = typeof asyncHandlerNS.default === 'function' ? asyncHandlerNS.default : asyncHandlerNS.asyncHandler;

const streamToCloudinary = (buffer, options) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(options, (err, r) => (err ? reject(err) : resolve(r))).end(buffer);
  });

const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Attach a file as field "document"' });

  const name = (req.body.name || req.file.originalname || 'Document').trim();
  const category = req.body.category || 'OTHER';
  let fileUrl;
  let publicId = '';

  if (cloudinaryReady) {
    try {
      const result = await streamToCloudinary(req.file.buffer, {
        folder: `crewly/documents/${req.companyId}`,
        resource_type: 'auto', // images & PDFs
      });
      fileUrl = result.secure_url;
      publicId = result.public_id;
    } catch (cloudErr) {
      console.warn('☁️  Cloudinary document upload failed, inline fallback used:', cloudErr.message);
    }
  }
  if (!fileUrl) {
    fileUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  }

  const doc = await Document.create({
    companyId: req.companyId,
    user: req.user._id,
    name,
    category,
    fileUrl,
    publicId,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });

  // 🔔 Phase 13: tell Admin/HR a document arrived (fire & forget — the upload never waits)
  try {
    const bosses = await User.find({ companyId: req.companyId, role: { $in: ['COMPANY_ADMIN', 'HR_MANAGER'] } }).select('_id');
    bosses.forEach((b) => notifySmart(b._id, {
      title: '📄 Document uploaded',
      message: `${req.user.name || 'An employee'} uploaded "${doc.name}"`,
      link: '/app/documents',
      category: 'DOCUMENT',
    }));
  } catch (e) { /* never block uploads */ }

  res.status(201).json({ success: true, message: 'Document uploaded 📄', data: doc });
});

const myDocuments = asyncHandler(async (req, res) => {
  const docs = await Document.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: docs });
});

const deleteDocument = asyncHandler(async (req, res) => {
  const doc = await Document.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
  if (cloudinaryReady && doc.publicId) {
    try { await cloudinary.uploader.destroy(doc.publicId, { resource_type: 'auto' }); } catch { /* ignore */ }
  }
  res.json({ success: true, message: 'Document deleted', data: { id: doc._id } });
});

export { uploadDocument, myDocuments, deleteDocument };
export default { uploadDocument, myDocuments, deleteDocument };