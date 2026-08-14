// 🖥 Asset — company equipment with full assignment history
import mongoose from 'mongoose';

export const ASSET_CATEGORIES = ['LAPTOP', 'MONITOR', 'KEYBOARD', 'MOUSE', 'MOBILE', 'ID_CARD', 'OTHER'];
export const ASSET_STATUS = ['AVAILABLE', 'ASSIGNED'];

const assignmentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assignedAt: { type: Date, default: Date.now },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
    returnedAt: { type: Date, default: null },
    returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    returnNote: { type: String, default: '' },
  },
  { _id: true }
);

const assetSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: ASSET_CATEGORIES, default: 'OTHER' },
    serialNumber: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    status: { type: String, enum: ASSET_STATUS, default: 'AVAILABLE', index: true },
    currentHolder: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignments: { type: [assignmentSchema], default: [] },
  },
  { timestamps: true }
);

assetSchema.index({ companyId: 1, status: 1 });

export default mongoose.model('Asset', assetSchema);
export { assetSchema };