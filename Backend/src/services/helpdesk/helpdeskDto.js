import { serializeHelpdeskSla } from './helpdeskSlaRules.js';

const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const categoryDto = (category, { includeDisabled = false } = {}) => ({
  id: idOf(category?._id),
  name: String(category?.name || ''),
  description: String(category?.description || ''),
  enabled: category?.enabled !== false,
});

export const serializeHelpdeskConfig = (config) => ({
  enabled: config?.enabled === true,
  allowEmployeeTickets: config?.allowEmployeeTickets !== false,
  attachmentsEnabled: config?.attachmentsEnabled === true,
  confidentialTicketsEnabled: config?.confidentialTicketsEnabled === true,
  defaultPriority: String(config?.defaultPriority || 'normal'),
  updatedAt: config?.updatedAt || null,
});

export const serializeHelpdeskQueue = (
  queue,
  { administrative = false, includeDisabledCategories = false } = {},
) => {
  const dto = {
    id: idOf(queue?._id),
    name: String(queue?.name || ''),
    description: String(queue?.description || ''),
    enabled: queue?.enabled !== false,
    categories: (queue?.categories || [])
      .filter((category) => includeDisabledCategories || category?.enabled !== false)
      .map(categoryDto),
    createdAt: queue?.createdAt || null,
    updatedAt: queue?.updatedAt || null,
  };

  if (administrative) {
    dto.agents = (queue?.agents || []).map(idOf);
    dto.managers = (queue?.managers || []).map(idOf);
    dto.confidentiality = {
      enabled: queue?.confidentiality?.enabled === true,
      agentIds: (queue?.confidentiality?.agentIds || []).map(idOf),
      reviewerIds: (queue?.confidentiality?.reviewerIds || []).map(idOf),
    };
  }

  return dto;
};

export const serializeHelpdeskTicket = (ticket) => ({
  ticketNumber: String(ticket?.ticketNumber || ''),
  requesterId: idOf(ticket?.user),
  queueId: idOf(ticket?.queueId),
  categoryId: idOf(ticket?.categoryId),
  category: String(ticket?.categoryName || ''),
  subject: String(ticket?.subject || ''),
  description: String(ticket?.message || ''),
  status: String(ticket?.status || 'open'),
  priority: String(ticket?.priority || 'normal'),
  requestedPriority: ticket?.requestedPriority || null,
  assignedTo: idOf(ticket?.assignedTo),
  confidential: ticket?.isConfidential === true,
  createdAt: ticket?.createdAt || null,
  updatedAt: ticket?.updatedAt || null,
  ...(ticket?.sla ? { sla: serializeHelpdeskSla(ticket.sla) } : {}),
});

const agentTicketBaseDto = (ticket, queueName) => ({
  ticketNumber: String(ticket?.ticketNumber || ''),
  subject: String(ticket?.subject || ''),
  queue: {
    id: idOf(ticket?.queueId),
    name: queueName === null || queueName === undefined ? null : String(queueName),
  },
  category: {
    id: idOf(ticket?.categoryId),
    name: String(ticket?.categoryName || ''),
  },
  status: String(ticket?.status || 'open'),
  priority: String(ticket?.priority || 'normal'),
  assignedTo: idOf(ticket?.assignedTo),
  confidential: ticket?.isConfidential === true,
  createdAt: ticket?.createdAt || null,
  updatedAt: ticket?.updatedAt || null,
  ...(ticket?.sla ? { sla: serializeHelpdeskSla(ticket.sla, { includeEscalation: true }) } : {}),
});

export const serializeHelpdeskAgentTicketListItem = (ticket, { queueName = null } = {}) =>
  agentTicketBaseDto(ticket, queueName);

export const serializeHelpdeskAgentTicketDetails = (ticket, { queueName = null } = {}) => ({
  ...agentTicketBaseDto(ticket, queueName),
  requesterId: idOf(ticket?.user),
  description: String(ticket?.message || ''),
});

const employeeTicketBaseDto = (ticket, queueName) => ({
  ticketNumber: String(ticket?.ticketNumber || ''),
  subject: String(ticket?.subject || ''),
  queue: {
    id: idOf(ticket?.queueId),
    name: queueName === null || queueName === undefined ? null : String(queueName),
  },
  category: {
    id: idOf(ticket?.categoryId),
    name: String(ticket?.categoryName || ''),
  },
  status: String(ticket?.status || 'open'),
  priority: String(ticket?.priority || 'normal'),
  confidential: ticket?.isConfidential === true,
  createdAt: ticket?.createdAt || null,
  updatedAt: ticket?.updatedAt || null,
  ...(ticket?.sla ? { sla: serializeHelpdeskSla(ticket.sla) } : {}),
});

export const serializeHelpdeskEmployeeTicketListItem = (ticket, { queueName = null } = {}) =>
  employeeTicketBaseDto(ticket, queueName);

export const serializeHelpdeskEmployeeTicketDetails = (ticket, { queueName = null } = {}) => ({
  ...employeeTicketBaseDto(ticket, queueName),
  requesterId: idOf(ticket?.user),
  description: String(ticket?.message || ''),
});
