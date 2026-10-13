// Legacy tenant/platform support tickets and the Helpdesk discriminator share
// this collection. Helpdesk reads must use the HelpdeskTicket model; legacy
// readers must use legacySupportTicketFilter (including historical rows with
// no ticketKind field).
import mongoose from 'mongoose';

const replySchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: String, required: true },
  },
  { timestamps: true },
);

const supportTicketSchema = new mongoose.Schema(
  {
    ticketKind: {
      type: String,
      enum: ['LEGACY_SUPPORT', 'HELPDESK'],
      default: 'LEGACY_SUPPORT',
    },
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
        'LOW', 'MEDIUM', 'NORMAL', 'HIGH', 'CRITICAL', 'URGENT',
        'low', 'normal', 'high', 'urgent',
      ],
      default: 'MEDIUM',
      index: true,
    },
    status: {
      type: String,
      enum: [
        'OPEN',
        'ASSIGNED',
        'IN_PROGRESS',
        'WAITING_FOR_CUSTOMER',
        'WAITING_FOR_EMPLOYEE',
        'WAITING_FOR_DEPARTMENT',
        'RESOLVED',
        'CLOSED',
        'CANCELLED',
        'open',
        'assigned',
        'in_progress',
        'waiting_for_employee',
        'waiting_for_department',
        'resolved',
        'closed',
        'cancelled',
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
    replies: { type: [replySchema], default: [] },
  },
  {
    timestamps: true,
    discriminatorKey: 'ticketKind',
  },
);

supportTicketSchema.index({ status: 1, priority: 1, createdAt: -1 });
supportTicketSchema.index({ subject: 'text', message: 'text' });

export default mongoose.model('SupportTicket', supportTicketSchema);
