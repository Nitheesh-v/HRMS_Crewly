// 📥 DocumentRequest — one row per request, in either direction:
//
//   TO_EMPLOYEE (default)  HR asks the employee for a file  → employee uploads
//                          → FULFILLED
//   TO_HR                  the employee asks HR to issue a letter or certificate
//                          → HR uploads it into their cabinet → FULFILLED
//
// `user` is always the employee the document belongs to, so a TO_HR request is
// filed against the person who asked for it. `direction` is the only thing that
// tells the two apart, and it defaults to the original meaning so every row
// written before this field existed keeps behaving exactly as it did.
import mongoose from 'mongoose';

export const DOC_REQUEST_STATUS = ['PENDING', 'FULFILLED', 'CANCELLED'];
export const DOC_REQUEST_DIRECTIONS = ['TO_EMPLOYEE', 'TO_HR'];

const documentRequestSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // employee who must upload
    category: { type: String, default: 'OTHER', trim: true },
    note: { type: String, default: '', trim: true },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: DOC_REQUEST_STATUS, default: 'PENDING' },
    direction: { type: String, enum: DOC_REQUEST_DIRECTIONS, default: 'TO_EMPLOYEE' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fulfilledAt: { type: Date, default: null },
    document: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
  },
  { timestamps: true }
);

documentRequestSchema.index({ companyId: 1, user: 1, status: 1 });
documentRequestSchema.index({ companyId: 1, direction: 1, status: 1 });

export default mongoose.model('DocumentRequest', documentRequestSchema);
export { documentRequestSchema };