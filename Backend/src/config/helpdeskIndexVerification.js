import { isDeepStrictEqual } from 'node:util';

export const REQUIRED_HELPDESK_OPERATIONAL_INDEXES = Object.freeze({
  HelpdeskTicket: Object.freeze([
    {
      name: 'helpdesk_ticket_number_unique_by_tenant',
      key: { companyId: 1, ticketNumber: 1 },
      unique: true,
      partialFilterExpression: { ticketKind: 'HELPDESK', ticketNumber: { $type: 'string' } },
    },
    {
      name: 'helpdesk_queue_ticket_list',
      key: { companyId: 1, queueId: 1, createdAt: -1 },
      partialFilterExpression: { ticketKind: 'HELPDESK' },
    },
    {
      name: 'helpdesk_agent_queue_ticket_created',
      key: { companyId: 1, queueId: 1, createdAt: -1, _id: -1 },
      partialFilterExpression: { ticketKind: 'HELPDESK' },
    },
    {
      name: 'helpdesk_agent_queue_ticket_updated',
      key: { companyId: 1, queueId: 1, updatedAt: -1, _id: -1 },
      partialFilterExpression: { ticketKind: 'HELPDESK' },
    },
    {
      name: 'helpdesk_agent_queue_assigned_created',
      key: { companyId: 1, queueId: 1, assignedTo: 1, createdAt: -1, _id: -1 },
      partialFilterExpression: { ticketKind: 'HELPDESK' },
    },
    {
      name: 'helpdesk_agent_queue_assigned_updated',
      key: { companyId: 1, queueId: 1, assignedTo: 1, updatedAt: -1, _id: -1 },
      partialFilterExpression: { ticketKind: 'HELPDESK' },
    },
    {
      name: 'helpdesk_requester_ticket_list_created',
      key: { companyId: 1, user: 1, createdAt: -1, _id: -1 },
      partialFilterExpression: { ticketKind: 'HELPDESK' },
    },
    {
      name: 'helpdesk_requester_ticket_list_updated',
      key: { companyId: 1, user: 1, updatedAt: -1, _id: -1 },
      partialFilterExpression: { ticketKind: 'HELPDESK' },
    },
    {
      name: 'helpdesk_ticket_feedback_analytics',
      key: { companyId: 1, queueId: 1, 'feedback.submittedAt': -1 },
      partialFilterExpression: { ticketKind: 'HELPDESK', 'feedback.submittedAt': { $type: 'date' } },
    },
    {
      name: 'helpdesk_sla_due_reconcile',
      key: { 'sla.nextActionAt': 1, companyId: 1, _id: 1 },
      partialFilterExpression: { ticketKind: 'HELPDESK', 'sla.nextActionAt': { $type: 'date' } },
    },
    {
      name: 'helpdesk_ticket_auto_close_due',
      key: { autoCloseAt: 1, companyId: 1, _id: 1 },
      partialFilterExpression: {
        ticketKind: 'HELPDESK',
        status: 'resolved',
        autoCloseAt: { $type: 'date' },
      },
    },
    {
      name: 'helpdesk_ticket_notification_recovery',
      key: { 'notificationEvents.state': 1, 'notificationEvents.nextAttemptAt': 1, companyId: 1, _id: 1 },
      partialFilterExpression: { ticketKind: 'HELPDESK' },
    },
    {
      name: 'helpdesk_ticket_notification_gap_recovery',
      key: { 'notificationGap.state': 1, 'notificationGap.nextAttemptAt': 1, companyId: 1, _id: 1 },
      partialFilterExpression: { ticketKind: 'HELPDESK' },
    },
  ]),
  HelpdeskMessage: Object.freeze([
    {
      name: 'helpdesk_message_sequence_unique',
      key: { companyId: 1, ticketId: 1, sequence: 1 },
      unique: true,
      partialFilterExpression: null,
    },
    {
      name: 'helpdesk_public_message_sequence_unique',
      key: { companyId: 1, ticketId: 1, publicSequence: 1 },
      unique: true,
      partialFilterExpression: { publicSequence: { $type: 'number' } },
    },
    {
      name: 'helpdesk_first_public_agent_reply',
      key: { companyId: 1, ticketId: 1, createdAt: 1, _id: 1 },
      partialFilterExpression: { messageType: 'PUBLIC' },
    },
    {
      name: 'helpdesk_public_message_analytics',
      key: { companyId: 1, createdAt: -1, ticketId: 1 },
      partialFilterExpression: { messageType: 'PUBLIC' },
    },
    {
      name: 'helpdesk_message_notification_recovery',
      key: { notificationState: 1, notificationNextAttemptAt: 1, companyId: 1, createdAt: 1, _id: 1 },
      partialFilterExpression: { messageType: 'PUBLIC', notificationState: 'PENDING' },
    },
  ]),
  HelpdeskAttachment: Object.freeze([
    {
      name: 'helpdesk_attachment_message_unique',
      key: { companyId: 1, ticketId: 1, messageId: 1 },
      unique: true,
      partialFilterExpression: null,
    },
    {
      name: 'helpdesk_attachment_cleanup_recovery',
      key: { companyId: 1, createdAt: 1 },
      partialFilterExpression: { cleanupRequired: true },
    },
    {
      name: 'helpdesk_attachment_commit_recovery',
      key: { companyId: 1, persistenceStatus: 1, createdAt: 1 },
      partialFilterExpression: null,
    },
  ]),
  HelpdeskSlaPolicy: Object.freeze([
    {
      name: 'helpdesk_sla_policy_tenant_queue_unique',
      key: { companyId: 1, queueId: 1 },
      unique: true,
      partialFilterExpression: null,
    },
  ]),
});

const orderedKeysMatch = (actual, expected) => {
  const actualEntries = Object.entries(actual || {});
  const expectedEntries = Object.entries(expected || {});
  return actualEntries.length === expectedEntries.length
    && expectedEntries.every(([key, direction], position) => {
      const actualEntry = actualEntries[position];
      return actualEntry?.[0] === key && actualEntry?.[1] === direction;
    });
};

const indexMatchesRequirement = (index, requirement) =>
  index?.name === requirement.name
  && orderedKeysMatch(index.key, requirement.key)
  && Boolean(index.unique) === Boolean(requirement.unique)
  && isDeepStrictEqual(index.partialFilterExpression ?? null, requirement.partialFilterExpression ?? null);

export const findMissingHelpdeskIndexes = ({ indexes = [], requirements = [] } = {}) =>
  requirements.filter((requirement) =>
    !(Array.isArray(indexes) && indexes.some((index) => indexMatchesRequirement(index, requirement))),
  );

export const assertRequiredHelpdeskIndexes = ({ modelName, indexes, requirements } = {}) => {
  const missing = findMissingHelpdeskIndexes({ indexes, requirements });
  if (missing.length) {
    throw new Error(
      `Required Helpdesk indexes are unavailable for ${String(modelName || 'unknown model')}: `
      + missing.map((requirement) => requirement.name).join(', '),
    );
  }
  return true;
};
