export const HELPDESK_NOTIFICATION_EVENT_TYPES = Object.freeze([
  'TICKET_CREATED',
  'TICKET_CLAIMED',
  'TICKET_ASSIGNED',
  'TICKET_REASSIGNED',
  'TICKET_TRANSFERRED',
  'TICKET_STATUS_CHANGED',
  'TICKET_RESOLVED',
  'TICKET_CANCELLED',
  'PUBLIC_REPLY',
  'SLA_WARNING',
  'SLA_BREACH',
  'SLA_ESCALATION_ELIGIBLE',
  'ACTIVITY_SUMMARY',
]);

export const HELPDESK_NOTIFICATION_MILESTONES = Object.freeze([
  'FIRST_RESPONSE_WARNING',
  'RESOLUTION_WARNING',
  'FIRST_RESPONSE_BREACH',
  'RESOLUTION_BREACH',
  'FIRST_RESPONSE_ESCALATION',
  'RESOLUTION_ESCALATION',
]);

export const HELPDESK_NOTIFICATION_MAX_TICKET_EVENTS = 128;
export const HELPDESK_NOTIFICATION_MAX_ATTEMPTS = 5;
export const HELPDESK_NOTIFICATION_LEASE_MS = 2 * 60 * 1000;
export const HELPDESK_NOTIFICATION_RETRY_DELAYS_MS = Object.freeze([
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
]);

const sequenceOf = (value) => {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
};

const dateValue = (value, fallback = new Date()) => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
};

const timestampOf = (value) => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
};

/**
 * Build a bounded, Mongo-embedded Helpdesk outbox append. The business write
 * must include the returned $inc/$push in the same conditional update.
 */
export const buildHelpdeskTicketNotificationAppend = ({
  ticket = {},
  eventTypes = [],
  at = new Date(),
} = {}) => {
  const specs = (Array.isArray(eventTypes) ? eventTypes : [eventTypes]).filter(Boolean);
  if (!specs.length) return null;

  const createdAt = dateValue(at);
  const currentSequence = sequenceOf(ticket.notificationSequence);
  const processedSequence = sequenceOf(ticket.notificationProcessedSequence);
  const existing = Array.isArray(ticket.notificationEvents)
    ? ticket.notificationEvents.map((event) => ({
        sequence: sequenceOf(event?.sequence),
        state: event?.state,
        nextAttemptAt: timestampOf(event?.nextAttemptAt),
      }))
    : [];
  const head = existing.find((event) => event.sequence === processedSequence + 1);
  const delayUntil = [
    timestampOf(head?.nextAttemptAt),
    ticket.notificationGap?.state === 'PENDING'
      ? timestampOf(ticket.notificationGap.nextAttemptAt)
      : null,
  ].filter((timestamp) => timestamp !== null);
  const nextAttemptAt = new Date(Math.max(createdAt.getTime(), ...delayUntil));
  const events = specs.map((spec, index) => {
    const type = typeof spec === 'string' ? spec : spec?.type;
    if (!HELPDESK_NOTIFICATION_EVENT_TYPES.includes(type)) {
      throw new TypeError('Unsupported Helpdesk notification event type');
    }
    const milestone = typeof spec === 'object' ? spec.milestone : null;
    if (milestone && !HELPDESK_NOTIFICATION_MILESTONES.includes(milestone)) {
      throw new TypeError('Unsupported Helpdesk SLA notification milestone');
    }
    return {
      sequence: currentSequence + index + 1,
      type,
      ...(milestone ? { milestone } : {}),
      state: 'PENDING',
      attemptCount: 0,
      createdAt,
      nextAttemptAt,
      leaseUntil: null,
    };
  });

  const combined = [...existing, ...events];
  const overflowCount = Math.max(0, combined.length - HELPDESK_NOTIFICATION_MAX_TICKET_EVENTS);
  const evicted = overflowCount ? combined.slice(0, overflowCount) : [];
  const evictedPending = evicted
    .map((event) => sequenceOf(event.sequence))
    .filter((sequence) => sequence > processedSequence);

  let gap = null;
  if (evictedPending.length) {
    const previousGap = ticket.notificationGap || {};
    const previousStart = sequenceOf(previousGap.fromSequence);
    const previousEnd = sequenceOf(previousGap.throughSequence);
    const fromSequence = previousStart > processedSequence
      ? previousStart
      : processedSequence + 1;
    const throughSequence = Math.max(previousEnd, ...evictedPending);
    if (throughSequence >= fromSequence) {
      const previousGapStillPending = previousGap.state === 'PENDING'
        && previousStart > processedSequence;
      gap = {
        fromSequence,
        throughSequence,
        state: 'PENDING',
        attemptCount: previousGapStillPending ? Math.max(0, Number(previousGap.attemptCount) || 0) : 0,
        nextAttemptAt: previousGapStillPending
          ? dateValue(previousGap.nextAttemptAt, createdAt)
          : createdAt,
        leaseUntil: null,
      };
    }
  }

  const append = {
    events,
    nextSequence: currentSequence + events.length,
    ...(gap ? { gap } : {}),
  };
  append.update = {
    $inc: { notificationSequence: events.length },
    $push: {
      notificationEvents: {
        $each: events,
        $slice: -HELPDESK_NOTIFICATION_MAX_TICKET_EVENTS,
      },
    },
    ...(gap ? { $set: { notificationGap: gap } } : {}),
  };
  return append;
};

/** A zero/missing sequence is the legacy Phase 38.1–38.5 ticket shape. */
export const addHelpdeskNotificationSequenceFilter = (filter, ticket = {}) => {
  const sequence = sequenceOf(ticket.notificationSequence);
  return {
    ...filter,
    notificationSequence: sequence === 0 ? { $in: [0, null] } : sequence,
  };
};

export const buildHelpdeskTicketNotificationCreateFields = (append) => {
  if (!append?.events?.length) return {};
  return {
    notificationSequence: append.nextSequence,
    notificationProcessedSequence: 0,
    notificationEvents: append.events,
    ...(append.gap ? { notificationGap: append.gap } : {}),
  };
};

/**
 * Derive durable notification intent only from newly persisted SLA markers.
 * Warning/breach dates and escalation triggers are sticky Mongo state, so a
 * worker restart or repeated CAS read cannot create a second logical event.
 */
export const diffHelpdeskSlaNotificationEvents = (previousSla, nextSla) => {
  if (!nextSla) return [];
  const events = [];
  const clocks = [
    ['firstResponse', 'FIRST_RESPONSE'],
    ['resolution', 'RESOLUTION'],
  ];

  for (const [field, label] of clocks) {
    const previous = previousSla?.[field] || {};
    const next = nextSla?.[field] || {};
    if (
      timestampOf(next.warningEligibleAt) !== null
      && timestampOf(next.warningEligibleAt) !== timestampOf(previous.warningEligibleAt)
    ) {
      events.push({ type: 'SLA_WARNING', milestone: `${label}_WARNING` });
    }
    if (
      timestampOf(next.breachedAt) !== null
      && timestampOf(next.breachedAt) !== timestampOf(previous.breachedAt)
    ) {
      events.push({ type: 'SLA_BREACH', milestone: `${label}_BREACH` });
    }
  }

  const previousTriggers = new Set(previousSla?.escalation?.triggers || []);
  for (const trigger of nextSla?.escalation?.triggers || []) {
    if (!previousTriggers.has(trigger) && ['FIRST_RESPONSE', 'RESOLUTION'].includes(trigger)) {
      events.push({
        type: 'SLA_ESCALATION_ELIGIBLE',
        milestone: `${trigger}_ESCALATION`,
      });
    }
  }
  return events;
};

export const helpdeskNotificationRetryDelay = (attemptCount) => {
  const attempt = Math.max(1, Math.trunc(Number(attemptCount) || 1));
  return HELPDESK_NOTIFICATION_RETRY_DELAYS_MS[
    Math.min(attempt - 1, HELPDESK_NOTIFICATION_RETRY_DELAYS_MS.length - 1)
  ];
};
