// 📄 Document — employee files (Aadhaar, letters, certificates, contracts…)
// Files live in Cloudinary (object storage); Mongo keeps URL + metadata only.
import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // employee this file belongs to
    name: { type: String, required: true, trim: true },
    category: { type: String, default: 'OTHER', trim: true },
    fileUrl: { type: String, required: true },
    publicId: { type: String, default: '' },
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