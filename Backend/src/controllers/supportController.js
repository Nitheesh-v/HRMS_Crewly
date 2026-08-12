// ============================================================
// 🎫 SUPPORT CONTROLLER — employee help desk
// POST /api/support                 (anyone creates)
// GET  /api/support/my              (my tickets)
// GET  /api/support                 (COMPANY_ADMIN / HR_MANAGER: all tickets)
// POST /api/support/:id/reply       (owner or HR)
// PATCH /api/support/:id/status     (HR/admin)
// ============================================================
import * as TicketNS from '../models/SupportTicket.js';
import * as asyncHandlerNS from '../utils/asyncHandler.js';
import * as notifyNS from '../utils/notify.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const mergeExports = (ns) => ({ ...ns, ...(ns.default && typeof ns.default === 'object' ? ns.default : {}) });

const Ticket = pickModel(TicketNS);
const asyncHandler = typeof asyncHandlerNS.default === 'function' ? asyncHandlerNS.default : asyncHandlerNS.asyncHandler;
const notify = mergeExports(notifyNS);

const HR_SIDE = ['COMPANY_ADMIN', 'HR_MANAGER'];

const createTicket = asyncHandler(async (req, res) => {
  const { subject, category = 'OTHER', message } = req.body;
  if (!subject?.trim() || !message?.trim()) {
    return res.status(400).json({ success: false, message: 'subject and message are required' });
  }
  const ticket = await Ticket.create({
    companyId: req.companyId,
    user: req.user._id,
    subject: subject.trim(),
    category,
    message: message.trim(),
  });
  try {
    await notify.notifyRoles?.(req.companyId, HR_SIDE, {
      title: '🎫 New support ticket',
      message: `${req.user.name}: ${ticket.subject}`,
      link: '/app/support',
    });
  } catch { /* best-effort */ }
  res.status(201).json({ success: true, message: 'Ticket raised 🎫 HR will get back to you', data: ticket });
});

const myTickets = asyncHandler(async (req, res) => {
  const list = await Ticket.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: list });
});

const listTickets = asyncHandler(async (req, res) => {
  if (!HR_SIDE.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'HR access only' });
  }
  const filter = { companyId: req.companyId };
  if (req.query.status) filter.status = req.query.status;
  const list = await Ticket.find(filter)
    .populate('user', 'name email role designation')
    .sort({ status: 1, createdAt: -1 })
    .lean();
  res.json({ success: true, data: list });
});

const replyTicket = asyncHandler(async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ success: false, message: 'message is required' });

  const ticket = await Ticket.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

  const isOwner = String(ticket.user) === String(req.user._id);
  const isHR = HR_SIDE.includes(req.user.role);
  if (!isOwner && !isHR) return res.status(403).json({ success: false, message: 'Not your ticket' });

  ticket.replies.push({ by: req.user._id, message: message.trim() });
  // auto triage: HR reply on OPEN ticket moves it to IN_PROGRESS
  if (isHR && ticket.status === 'OPEN') ticket.status = 'IN_PROGRESS';
  await ticket.save();

  try {
    if (!isOwner) {
      await notify.notifyUser?.(req.companyId, ticket.user, {
        title: '💬 Ticket reply',
        message: `Re: ${ticket.subject}`,
        link: '/app/support',
      });
    }
  } catch { /* best-effort */ }

  const populated = await ticket.populate([
    { path: 'user', select: 'name email role' },
    { path: 'replies.by', select: 'name role' },
  ]);
  res.json({ success: true, message: 'Reply added', data: populated });
});

const updateTicketStatus = asyncHandler(async (req, res) => {
  if (!HR_SIDE.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'HR access only' });
  }
  const { status } = req.body;
  if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }
  const ticket = await Ticket.findOneAndUpdate(
    { _id: req.params.id, companyId: req.companyId },
    { $set: { status } },
    { new: true }
  );
  if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

  try {
    await notify.notifyUser?.(req.companyId, ticket.user, {
      title: `🎫 Ticket ${status.replace('_', ' ')}`,
      message: ticket.subject,
      link: '/app/support',
    });
  } catch { /* best-effort */ }

  res.json({ success: true, message: `Ticket ${status}`, data: ticket });
});

export { createTicket, myTickets, listTickets, replyTicket, updateTicketStatus };
export default { createTicket, myTickets, listTickets, replyTicket, updateTicketStatus };