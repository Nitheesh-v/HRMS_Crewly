// 🎫 SUPPORT TICKET — employee help desk; HR/admin resolve
import mongoose from 'mongoose';

const replySchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: String, required: true },
  },
  { timestamps: true }
);

const supportTicketSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    subject: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['PAYROLL', 'ATTENDANCE', 'LEAVE', 'IT', 'FACILITIES', 'HR', 'OTHER'],
      default: 'OTHER',
    },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
      default: 'OPEN',
    },
    replies: [replySchema],
  },
  { timestamps: true }
);

export default mongoose.model('SupportTicket', supportTicketSchema);