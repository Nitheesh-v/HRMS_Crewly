// 📥 DocumentRequest — HR asks an employee for a file; employee uploads → FULFILLED
import mongoose from 'mongoose';

export const DOC_REQUEST_STATUS = ['PENDING', 'FULFILLED', 'CANCELLED'];

const documentRequestSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // employee who must upload
    category: { type: String, default: 'OTHER', trim: true },
    note: { type: String, default: '', trim: true },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: DOC_REQUEST_STATUS, default: 'PENDING' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fulfilledAt: { type: Date, default: null },
    document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  },
  { timestamps: true }
);

documentRequestSchema.index({ companyId: 1, user: 1, status: 1 });

export default mongoose.model('DocumentRequest', documentRequestSchema);
export { documentRequestSchema };