// Shared Helpdesk authorization predicates. RBAC is necessary at the route/controller
// boundary; these predicates preserve the queue-membership and confidentiality rules.

export const idString = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

export const includesId = (values, id) =>
  (values || []).some(
    (value) => idString(value).toLowerCase() === String(id || '').toLowerCase(),
  );

export const isHelpdeskQueueAgent = ({ queue, actorId } = {}) =>
  includesId(queue?.agents, actorId);

export const isHelpdeskQueueStaff = ({ queue, actorId } = {}) =>
  isHelpdeskQueueAgent({ queue, actorId }) || includesId(queue?.managers, actorId);

export const hasConfidentialHelpdeskAgentAccess = ({ queue, actorId } = {}) =>
  isHelpdeskQueueAgent({ queue, actorId })
    && includesId(queue?.confidentiality?.agentIds, actorId);

export const canReadHelpdeskTicket = ({ ticket, queue, viewerId, access = {} } = {}) => {
  const viewer = idString(viewerId);
  if (access.canReadOwn === true && idString(ticket?.user) === viewer) return true;
  if (access.canReadQueue !== true) return false;

  if (ticket?.isConfidential === true) {
    const hasRestrictedAgentAccess = hasConfidentialHelpdeskAgentAccess({ queue, actorId: viewer });
    const hasReviewerAccess = includesId(queue?.confidentiality?.reviewerIds, viewer);
    return hasRestrictedAgentAccess || hasReviewerAccess;
  }

  return isHelpdeskQueueStaff({ queue, actorId: viewer });
};
