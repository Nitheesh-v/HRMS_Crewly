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
   priority: {
  type: String,
  enum: [
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL',
  ],
  default: 'MEDIUM',
  index: true,
},

status: {
  type: String,
  enum: [
    'OPEN',
    'IN_PROGRESS',
    'WAITING_FOR_CUSTOMER',
    'RESOLVED',
    'CLOSED',
  ],
  default: 'OPEN',
  index: true,
},

assignedSupportAgent: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'User',
  default: null,
},

platformNote: {
  type: String,
  default: '',
  trim: true,
  maxlength: 1000,
},
    replies: [replySchema],
  },
  { timestamps: true }
);


supportTicketSchema.index({
  status: 1,
  priority: 1,
  createdAt: -1,
});

supportTicketSchema.index({
  subject: 'text',
  message: 'text',
});
export default mongoose.model('SupportTicket', supportTicketSchema);