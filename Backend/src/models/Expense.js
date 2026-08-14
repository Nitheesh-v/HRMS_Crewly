// 💸 Expense — employee claims with 2-stage approval + reimbursement
import mongoose from 'mongoose';

export const EXPENSE_CATEGORIES = ['TRAVEL', 'FOOD', 'ACCOMMODATION', 'CLIENT_MEETING', 'TRANSPORT', 'OTHER'];
export const EXPENSE_STATUS = ['PENDING_MANAGER', 'PENDING_FINANCE', 'APPROVED', 'REJECTED', 'REIMBURSED', 'CANCELLED'];

const expenseSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: 'OTHER' },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'INR' },
    expenseDate: { type: String, default: '' }, // 'YYYY-MM-DD'
    description: { type: String, default: '', trim: true },
    receiptUrl: { type: String, default: '' },
    receiptPublicId: { type: String, default: '' },
    receiptMime: { type: String, default: '' },
    status: { type: String, enum: EXPENSE_STATUS, default: 'PENDING_MANAGER', index: true },
    managerApproval: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      at: { type: Date, default: null },
      note: { type: String, default: '' },
    },
    financeApproval: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      at: { type: Date, default: null },
      note: { type: String, default: '' },
    },
    rejectNote: { type: String, default: '' },
    reimbursedAt: { type: Date, default: null },
    reimbursedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

expenseSchema.index({ companyId: 1, user: 1, status: 1 });

export default mongoose.model('Expense', expenseSchema);
export { expenseSchema };