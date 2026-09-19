// 📄 Document — employee files (Aadhaar, letters, certificates, contracts…)
// Files live in Cloudinary (object storage); Mongo keeps URL + metadata only.
import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // employee this file belongs to
    name: { type: String, required: true, trim: true },
    category: { type: String, default: 'OTHER', trim: true },
    fileUrl: { type: String, default: '' }, // '' for 32.8 private rows (delivery endpoint serves bytes)
    publicId: { type: String, default: '' },
    // Phase 32.8 — private storage reference for NEW uploads. The bytes
    // live behind Cloudinary `authenticated` resources (no permanent
    // public URL); delivery is the authorization-gated
    // GET /api/documents/:id/file endpoint. The key is select:false —
    // storage internals are never returned to the frontend (§14).
    storageProvider: { type: String, default: '' },
    storageKey: { type: String, default: '', select: false },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    // 🆕 Phase 14
    expiryDate: { type: Date, default: null },                    // HR-set; null = never expires
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // HR uploading on behalf
    note: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

documentSchema.index({ companyId: 1, user: 1, createdAt: -1 });

export default mongoose.model('Document', documentSchema);