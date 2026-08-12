// 📄 DOCUMENT — employee-uploaded files (ID proofs, certificates…)
import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['PERSONAL', 'EDUCATION', 'EXPERIENCE', 'ID_PROOF', 'PAYSLIP', 'OTHER'],
      default: 'OTHER',
    },
    fileUrl: { type: String, required: true }, // Cloudinary URL (or inline data-URI in dev mode)
    publicId: { type: String, default: '' },   // Cloudinary ref for deletes
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },        // bytes
  },
  { timestamps: true }
);

export default mongoose.model('Document', documentSchema);