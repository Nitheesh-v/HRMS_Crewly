import { isValidObjectId } from 'mongoose';

import HelpdeskMessage from '../../models/HelpdeskMessage.js';
import HelpdeskQueue from '../../models/HelpdeskQueue.js';
import HelpdeskTicket from '../../models/HelpdeskTicket.js';
import Notification from '../../models/Notification.js';
import NotificationPref from '../../models/NotificationPref.js';
import User from '../../models/User.js';
import { SUPPORT_TICKET_KIND } from '../../utils/supportTicketKinds.js';
import { hasConfidentialHelpdeskAgentAccess, idString } from './helpdeskAccess.js';
import {
  HELPDESK_NOTIFICATION_LEASE_MS,
  HELPDESK_NOTIFICATION_MAX_ATTEMPTS,
  HELPDESK_NOTIFICATION_MAX_TICKET_EVENTS,
  addHelpdeskNotificationSequenceFilter,
  helpdeskNotificationRetryDelay,
} from './helpdeskNotificationRules.js';

export const HELPDESK_NOTIFICATION_MAX_QUEUE_RECIPIENTS = 20;
export const HELPDESK_NOTIFICATION_MAX_RECONCILE_BATCH = 100;
export const HELPDESK_NOTIFICATION_CATEGORY = 'SUPPORT';
export const HELPDESK_NOTIFICATION_REALTIME_EVENT = 'helpdesk:notifications:changed';

const TERMINAL_TICKET_STATUSES = new Set(['closed', 'cancelled']);
const STAFF_ONLY_EVENT_TYPES = new Set([
  'TICKET_CREATED',
  'SLA_WARNING',
  'SLA_BREACH',
  'SLA_ESCALATION_ELIGIBLE',
]);
const REQUESTER_AND_STAFF_EVENT_TYPES = new Set([
  'TICKET_CLAIMED',
  'TICKET_ASSIGNED',
  'TICKET_REASSIGNED',
  'TICKET_TRANSFERRED',
  'TICKET_STATUS_CHANGED',
  'TICKET_RESOLVED',
  'TICKET_CANCELLED',
  'ACTIVITY_SUMMARY',
]);
const TICKET_DELIVERY_PROJECTION =
  '_id companyId ticketNumber user queueId assignedTo status isConfidential sla';
const TICKET_OUTBOX_PROJECTION =
  '_id companyId ticketNumber user queueId assignedTo status isConfidential sla ' +
  'notificationSequence notificationProcessedSequence notificationEvents notificationGap';
const MESSAGE_DELIVERY_PROJECTION =
  '_id companyId ticketId authorUserId messageType createdAt ' +
  '+notificationState +notificationAttemptCount +notificationNextAttemptAt +notificationLeaseUntil';

const sequenceOf = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
};

const counterFilter = (value) => {
  const parsed = sequenceOf(value);
  return parsed ? parsed : { $in: [0, null] };
};

const asDate = (value) => {
  if (value instanceof Date) return new Date(value.getTime());
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const idValue = (value) => {
  const result = idString(value);
  return isValidObjectId(result) ? result : '';
};

const uniqueIds = (values) => [...new Set((values || []).map(idValue).filter(Boolean))];

const prefEnabled = (inapp) => {
  if (inapp instanceof Map) return inapp.get(HELPDESK_NOTIFICATION_CATEGORY) !== false;
  return inapp?.[HELPDESK_NOTIFICATION_CATEGORY] !== false;
};

const queryWithOptions = async (query, { select, sort, limit, lean = true } = {}) => {
  let next = query;
  if (select && typeof next?.select === 'function') next = next.select(select);
  if (sort && typeof next?.sort === 'function') next = next.sort(sort);
  if (Number.isInteger(limit) && typeof next?.limit === 'function') next = next.limit(limit);
  if (lean && typeof next?.lean === 'function') next = next.lean();
  return next;
};

const duplicateOnly = (error) => {
  if (error?.code === 11000) return true;
  const rows = error?.writeErrors
    || error?.result?.getWriteErrors?.()
    || error?.result?.writeErrors;
  return Array.isArray(rows) && rows.length > 0 && rows.every((row) => row?.code === 11000);
};

const eventIdentityKey = (eventIdentity) => {
  if (typeof eventIdentity === 'string') return eventIdentity;
  if (Number.isSafeInteger(Number(eventIdentity?.ticketSequence))) {
    return `ticket-event:${Number(eventIdentity.ticketSequence)}`;
  }
  return 'ticket-event:unknown';
};

const eventKeyFor = ({ ticketId, eventIdentity, recipientId }) =>
  `helpdesk:${idString(ticketId)}:${eventIdentityKey(eventIdentity)}:${idString(recipientId)}`;

const milestoneClock = (ticket, milestone) => {
  if (milestone?.startsWith('FIRST_RESPONSE_')) return ticket.sla?.firstResponse;
  if (milestone?.startsWith('RESOLUTION_')) return ticket.sla?.resolution;
  return null;
};

export const resolveHelpdeskNotificationRecipientIds = ({
  ticket,
  queue,
  eventType,
  actorUserId = null,
  maxQueueRecipients = HELPDESK_NOTIFICATION_MAX_QUEUE_RECIPIENTS,
} = {}) => {
  if (!ticket || !queue || idString(ticket.companyId) !== idString(queue.companyId)) return [];

  const allAgents = uniqueIds(queue.agents);
  const allowedAgents = ticket.isConfidential === true
    ? allAgents.filter((agentId) => hasConfidentialHelpdeskAgentAccess({ queue, actorId: agentId }))
    : allAgents;
  const assignedTo = idValue(ticket.assignedTo);
  let staffRecipients = [];

  if (assignedTo) {
    // A stale assignee is not replaced with a queue-wide fallback.
    if (allowedAgents.some((agentId) => agentId === assignedTo)) staffRecipients = [assignedTo];
  } else {
    staffRecipients = [...allowedAgents]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, Math.max(1, Math.min(HELPDESK_NOTIFICATION_MAX_QUEUE_RECIPIENTS, Number(maxQueueRecipients) || 1)));
  }

  const requesterId = idValue(ticket.user);
  if (eventType === 'PUBLIC_REPLY') {
    const authorId = idValue(actorUserId);
    return authorId && authorId === requesterId ? uniqueIds(staffRecipients) : uniqueIds([requesterId]);
  }
  if (STAFF_ONLY_EVENT_TYPES.has(eventType)) return uniqueIds(staffRecipients);
  if (REQUESTER_AND_STAFF_EVENT_TYPES.has(eventType)) {
    return uniqueIds([...staffRecipients, requesterId]);
  }
  return [];
};

export const helpdeskNotificationService = (deps = {}) => {
  const TicketModel = deps.TicketModel || HelpdeskTicket;
  const MessageModel = deps.MessageModel || HelpdeskMessage;
  const QueueModel = deps.QueueModel || HelpdeskQueue;
  const UserModel = deps.UserModel || User;
  const NotificationModel = deps.NotificationModel || Notification;
  const PreferenceModel = deps.PreferenceModel || NotificationPref;
  const realtimePublisher = deps.realtimePublisher || null;
  const now = deps.now || (() => new Date());
  const maxQueueRecipients = deps.maxQueueRecipients || HELPDESK_NOTIFICATION_MAX_QUEUE_RECIPIENTS;

  const loadTicketContext = async ({ companyId, ticketId }) => {
    const ticket = await queryWithOptions(
      TicketModel.findOne({
        _id: ticketId,
        companyId,
        ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      }),
      { select: TICKET_DELIVERY_PROJECTION },
    );
    if (!ticket || idString(ticket.companyId) !== idString(companyId)) return null;
    const queue = await queryWithOptions(
      QueueModel.findOne({ _id: ticket.queueId, companyId }),
      { select: '_id companyId agents managers confidentiality enabled' },
    );
    if (!queue || idString(queue.companyId) !== idString(companyId)) return { ticket, queue: null };
    return { ticket, queue };
  };

  const activeRecipients = async ({ companyId, ticket, queue, eventType, actorUserId }) => {
    const candidateIds = resolveHelpdeskNotificationRecipientIds({
      ticket,
      queue,
      eventType,
      actorUserId,
      maxQueueRecipients,
    });
    if (!candidateIds.length) return [];

    // One bounded tenant-scoped membership read, never one User lookup per recipient.
    const users = await queryWithOptions(
      UserModel.find({
        companyId,
        status: 'ACTIVE',
        _id: { $in: candidateIds },
      }),
      { select: '_id' },
    );
    const activeIds = uniqueIds((users || []).map((user) => user._id));
    if (!activeIds.length) return [];

    const preferences = await queryWithOptions(
      PreferenceModel.find({ company: companyId, user: { $in: activeIds } }),
      { select: 'user inapp' },
    );
    const preferenceByUser = new Map(
      (preferences || []).map((preference) => [idValue(preference.user), preference]),
    );
    return activeIds.filter((userId) => prefEnabled(preferenceByUser.get(userId)?.inapp));
  };

  const persistNotifications = async ({ companyId, ticketId, eventIdentity, userIds }) => {
    const docs = uniqueIds(userIds).map((recipientId) => ({
      companyId,
      user: recipientId,
      eventKey: eventKeyFor({ ticketId, eventIdentity, recipientId }),
      type: HELPDESK_NOTIFICATION_CATEGORY,
      title: 'Helpdesk update',
      message: 'There is an update in Helpdesk.',
      link: '/app/helpdesk',
      readAt: null,
    }));
    if (!docs.length) return [];

    const operations = docs.map((doc) => ({
      updateOne: {
        filter: { companyId: doc.companyId, user: doc.user, eventKey: doc.eventKey },
        update: { $setOnInsert: doc },
        upsert: true,
      },
    }));
    let persisted = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await NotificationModel.bulkWrite(operations, { ordered: false });
        persisted = true;
        break;
      } catch (error) {
        if (!duplicateOnly(error)) throw error;
        if (attempt === 1) persisted = true;
      }
    }
    if (!persisted) throw new Error('Helpdesk notification persistence did not complete');

    // Realtime only invalidates the recipient's own bell; it never carries ticket data.
    try {
      await realtimePublisher?.notify?.({ companyId, userIds: docs.map((doc) => doc.user) });
    } catch {
      // Mongo notices are authoritative; realtime is best-effort acceleration.
    }
    return docs;
  };

  const deliverEvent = async ({ ticket, queue, eventType, eventIdentity, actorUserId = null }) => {
    if (!ticket || !queue) return 'SUPPRESSED';
    if (eventType.startsWith('SLA_')) {
      if (TERMINAL_TICKET_STATUSES.has(String(ticket.status || '').toLowerCase())) return 'SUPPRESSED';
      if (eventType === 'SLA_WARNING') {
        const clock = milestoneClock(ticket, eventIdentity.milestone);
        if (!clock?.warningEligibleAt || ['COMPLETED', 'STOPPED'].includes(clock.state)) return 'SUPPRESSED';
      }
      if (eventType === 'SLA_BREACH') {
        const clock = milestoneClock(ticket, eventIdentity.milestone);
        if (!clock?.breachedAt) return 'SUPPRESSED';
      }
      if (eventType === 'SLA_ESCALATION_ELIGIBLE') {
        const trigger = eventIdentity.milestone?.startsWith('FIRST_RESPONSE_')
          ? 'FIRST_RESPONSE'
          : 'RESOLUTION';
        if (ticket.sla?.escalation?.state !== 'ELIGIBLE'
          || !(ticket.sla?.escalation?.triggers || []).includes(trigger)) return 'SUPPRESSED';
      }
    }

    const userIds = await activeRecipients({
      companyId: ticket.companyId,
      ticket,
      queue,
      eventType,
      actorUserId,
    });
    if (!userIds.length) return 'SUPPRESSED';
    await persistNotifications({
      companyId: ticket.companyId,
      ticketId: ticket._id,
      eventIdentity,
      userIds,
    });
    return 'DELIVERED';
  };

  const claimTicketEvent = async ({ ticket, event, at }) => {
    const currentSequence = sequenceOf(ticket.notificationSequence);
    const processedSequence = sequenceOf(ticket.notificationProcessedSequence);
    const leaseUntil = new Date(at.getTime() + HELPDESK_NOTIFICATION_LEASE_MS);
    const filter = addHelpdeskNotificationSequenceFilter({
      _id: ticket._id,
      companyId: ticket.companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      notificationProcessedSequence: counterFilter(processedSequence),
      notificationEvents: {
        $elemMatch: {
          sequence: event.sequence,
          state: 'PENDING',
          nextAttemptAt: { $lte: at },
        },
      },
    }, { notificationSequence: currentSequence });

    const query = TicketModel.findOneAndUpdate(
      filter,
      {
        $set: {
          'notificationEvents.$[event].leaseUntil': leaseUntil,
          'notificationEvents.$[event].nextAttemptAt': leaseUntil,
          'notificationEvents.$[later].nextAttemptAt': leaseUntil,
          'notificationEvents.$[later].leaseUntil': null,
        },
        $inc: { 'notificationEvents.$[event].attemptCount': 1 },
      },
      {
        arrayFilters: [
          { 'event.sequence': event.sequence, 'event.state': 'PENDING', 'event.nextAttemptAt': { $lte: at } },
          { 'later.sequence': { $gt: event.sequence }, 'later.state': 'PENDING' },
        ],
        returnDocument: 'after',
        runValidators: true,
      },
    );
    return queryWithOptions(query, { select: TICKET_OUTBOX_PROJECTION });
  };

  const claimTicketGap = async ({ ticket, gap, at }) => {
    const currentSequence = sequenceOf(ticket.notificationSequence);
    const processedSequence = sequenceOf(ticket.notificationProcessedSequence);
    const leaseUntil = new Date(at.getTime() + HELPDESK_NOTIFICATION_LEASE_MS);
    const filter = addHelpdeskNotificationSequenceFilter({
      _id: ticket._id,
      companyId: ticket.companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      notificationProcessedSequence: counterFilter(processedSequence),
      'notificationGap.fromSequence': gap.fromSequence,
      'notificationGap.throughSequence': gap.throughSequence,
      'notificationGap.state': 'PENDING',
      'notificationGap.nextAttemptAt': { $lte: at },
    }, { notificationSequence: currentSequence });
    const query = TicketModel.findOneAndUpdate(
      filter,
      {
        $set: {
          'notificationGap.nextAttemptAt': leaseUntil,
          'notificationGap.leaseUntil': leaseUntil,
        },
        $inc: { 'notificationGap.attemptCount': 1 },
      },
      { returnDocument: 'after', runValidators: true },
    );
    return queryWithOptions(query, { select: TICKET_OUTBOX_PROJECTION });
  };

  const updateTicketEvent = async ({ ticket, event, state, at, retry = false }) => {
    const sequence = sequenceOf(event.sequence);
    const currentSequence = sequenceOf(ticket.notificationSequence);
    const processedSequence = sequenceOf(ticket.notificationProcessedSequence);
    const attemptCount = Math.max(0, Number(event.attemptCount) || 0);
    const terminal = !retry || attemptCount >= HELPDESK_NOTIFICATION_MAX_ATTEMPTS;
    const retryAt = terminal
      ? null
      : new Date(at.getTime() + helpdeskNotificationRetryDelay(attemptCount));
    const filter = {
      _id: ticket._id,
      companyId: ticket.companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      notificationSequence: counterFilter(currentSequence),
      notificationProcessedSequence: counterFilter(processedSequence),
      notificationEvents: {
        $elemMatch: {
          sequence,
          state: 'PENDING',
          leaseUntil: event.leaseUntil,
        },
      },
    };
    const set = {
      'notificationEvents.$[event].state': terminal ? state : 'PENDING',
      'notificationEvents.$[event].nextAttemptAt': terminal ? null : retryAt,
      'notificationEvents.$[event].leaseUntil': null,
    };
    if (terminal) {
      set.notificationProcessedSequence = sequence;
      set['notificationEvents.$[later].nextAttemptAt'] = at;
      set['notificationEvents.$[later].leaseUntil'] = null;
    } else {
      set['notificationEvents.$[later].nextAttemptAt'] = retryAt;
      set['notificationEvents.$[later].leaseUntil'] = null;
    }
    const query = TicketModel.findOneAndUpdate(
      filter,
      { $set: set },
      {
        arrayFilters: [
          { 'event.sequence': sequence },
          { 'later.sequence': { $gt: sequence }, 'later.state': 'PENDING' },
        ],
        returnDocument: 'after',
        runValidators: true,
      },
    );
    return queryWithOptions(query, { select: '_id' });
  };

  const updateTicketGap = async ({ ticket, gap, state, at, retry = false }) => {
    const currentSequence = sequenceOf(ticket.notificationSequence);
    const processedSequence = sequenceOf(ticket.notificationProcessedSequence);
    const attemptCount = Math.max(0, Number(gap.attemptCount) || 0);
    const terminal = !retry || attemptCount >= HELPDESK_NOTIFICATION_MAX_ATTEMPTS;
    const retryAt = terminal
      ? null
      : new Date(at.getTime() + helpdeskNotificationRetryDelay(attemptCount));
    const filter = {
      _id: ticket._id,
      companyId: ticket.companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      notificationSequence: counterFilter(currentSequence),
      notificationProcessedSequence: counterFilter(processedSequence),
      'notificationGap.fromSequence': gap.fromSequence,
      'notificationGap.throughSequence': gap.throughSequence,
      'notificationGap.state': 'PENDING',
      'notificationGap.leaseUntil': gap.leaseUntil,
    };
    const set = terminal
      ? {
          notificationProcessedSequence: gap.throughSequence,
          notificationGap: {
            ...gap,
            state,
            attemptCount,
            nextAttemptAt: null,
            leaseUntil: null,
          },
        }
      : {
          'notificationGap.state': 'PENDING',
          'notificationGap.attemptCount': attemptCount,
          'notificationGap.nextAttemptAt': retryAt,
          'notificationGap.leaseUntil': null,
        };
    if (terminal) {
      set['notificationEvents.$[later].nextAttemptAt'] = at;
      set['notificationEvents.$[later].leaseUntil'] = null;
    }
    const query = TicketModel.findOneAndUpdate(
      filter,
      { $set: set },
      {
        ...(terminal
          ? { arrayFilters: [{ 'later.sequence': { $gt: gap.throughSequence }, 'later.state': 'PENDING' }] }
          : {}),
        returnDocument: 'after',
        runValidators: true,
      },
    );
    return queryWithOptions(query, { select: '_id' });
  };

  const processTicketGap = async ({ ticket, at }) => {
    const gap = ticket.notificationGap;
    const fromSequence = sequenceOf(gap?.fromSequence);
    const throughSequence = sequenceOf(gap?.throughSequence);
    const processedSequence = sequenceOf(ticket.notificationProcessedSequence);
    if (
      !gap
      || gap.state !== 'PENDING'
      || fromSequence !== processedSequence + 1
      || throughSequence < fromSequence
      || !asDate(gap.nextAttemptAt)
      || asDate(gap.nextAttemptAt) > at
    ) return { skipped: true };

    const claimed = await claimTicketGap({ ticket, gap, at });
    if (!claimed) return { skipped: true };
    const claimedGap = claimed.notificationGap;
    try {
      const context = await loadTicketContext({ companyId: claimed.companyId, ticketId: claimed._id });
      const result = context
        ? await deliverEvent({
          ticket: context.ticket,
          queue: context.queue,
          eventType: 'ACTIVITY_SUMMARY',
          eventIdentity: `gap:${fromSequence}`,
        })
        : 'SUPPRESSED';
      await updateTicketGap({ ticket: claimed, gap: claimedGap, state: result, at });
      return { delivered: result === 'DELIVERED', suppressed: result === 'SUPPRESSED' };
    } catch {
      await updateTicketGap({ ticket: claimed, gap: claimedGap, state: 'FAILED', at, retry: true }).catch(() => {});
      return { failed: true };
    }
  };

  const processTicketEvent = async ({ ticket, at }) => {
    const processedSequence = sequenceOf(ticket.notificationProcessedSequence);
    const currentSequence = sequenceOf(ticket.notificationSequence);
    if (ticket.notificationGap?.state === 'PENDING') return processTicketGap({ ticket, at });
    if (currentSequence <= processedSequence) return { skipped: true };

    const expectedSequence = processedSequence + 1;
    const events = Array.isArray(ticket.notificationEvents) ? ticket.notificationEvents : [];
    const event = events.find((row) => sequenceOf(row.sequence) === expectedSequence);
    if (!event) {
      // Defensive recovery for a legacy/corrupt sequence gap. Normal overflow
      // records this marker atomically with the ticket event append.
      const available = events.map((row) => sequenceOf(row.sequence)).filter((value) => value > processedSequence);
      const firstAvailable = available.length ? Math.min(...available) : currentSequence + 1;
      const throughSequence = Math.min(currentSequence, firstAvailable - 1);
      if (throughSequence < expectedSequence) return { skipped: true };
      const query = TicketModel.findOneAndUpdate(
        {
          _id: ticket._id,
          companyId: ticket.companyId,
          ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
          notificationSequence: counterFilter(currentSequence),
          notificationProcessedSequence: counterFilter(processedSequence),
          notificationGap: { $exists: false },
        },
        {
          $set: {
            notificationGap: {
              fromSequence: expectedSequence,
              throughSequence,
              state: 'PENDING',
              attemptCount: 0,
              nextAttemptAt: at,
              leaseUntil: null,
            },
          },
        },
        { returnDocument: 'after', runValidators: true },
      );
      await queryWithOptions(query, { select: '_id' });
      return { skipped: true };
    }
    if (event.state !== 'PENDING') {
      // A terminal event should never be ahead of the high-water mark, but
      // advance safely if an interrupted legacy deployment left that shape.
      if (event.state === 'DELIVERED' || event.state === 'SUPPRESSED' || event.state === 'FAILED') {
        const query = TicketModel.findOneAndUpdate(
          {
            _id: ticket._id,
            companyId: ticket.companyId,
            ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
            notificationSequence: counterFilter(currentSequence),
            notificationProcessedSequence: counterFilter(processedSequence),
            'notificationEvents.sequence': expectedSequence,
          },
          { $set: { notificationProcessedSequence: expectedSequence } },
          { returnDocument: 'after', runValidators: true },
        );
        await queryWithOptions(query, { select: '_id' });
      }
      return { skipped: true };
    }
    const nextAttemptAt = asDate(event.nextAttemptAt);
    if (!nextAttemptAt || nextAttemptAt > at) return { skipped: true };

    const claimed = await claimTicketEvent({ ticket, event, at });
    if (!claimed) return { skipped: true };
    const claimedEvent = (claimed.notificationEvents || []).find(
      (row) => sequenceOf(row.sequence) === expectedSequence,
    );
    if (!claimedEvent) return { skipped: true };

    try {
      const context = await loadTicketContext({ companyId: claimed.companyId, ticketId: claimed._id });
      const result = context
        ? await deliverEvent({
          ticket: context.ticket,
          queue: context.queue,
          eventType: claimedEvent.type,
          eventIdentity: {
            ticketSequence: expectedSequence,
            milestone: claimedEvent.milestone,
          },
        })
        : 'SUPPRESSED';
      await updateTicketEvent({ ticket: claimed, event: claimedEvent, state: result, at });
      return { delivered: result === 'DELIVERED', suppressed: result === 'SUPPRESSED' };
    } catch {
      await updateTicketEvent({
        ticket: claimed,
        event: claimedEvent,
        state: 'FAILED',
        at,
        retry: true,
      }).catch(() => {});
      return { failed: true };
    }
  };

  const claimMessage = async ({ message, at }) => {
    const leaseUntil = new Date(at.getTime() + HELPDESK_NOTIFICATION_LEASE_MS);
    const query = MessageModel.findOneAndUpdate(
      {
        _id: message._id,
        companyId: message.companyId,
        ticketId: message.ticketId,
        messageType: 'PUBLIC',
        notificationState: 'PENDING',
        notificationNextAttemptAt: { $lte: at },
      },
      {
        $set: {
          notificationNextAttemptAt: leaseUntil,
          notificationLeaseUntil: leaseUntil,
        },
        $inc: { notificationAttemptCount: 1 },
      },
      { returnDocument: 'after', runValidators: true },
    );
    return queryWithOptions(query, { select: MESSAGE_DELIVERY_PROJECTION });
  };

  const finishMessage = async ({ message, state, at, retry = false }) => {
    const attemptCount = Math.max(0, Number(message.notificationAttemptCount) || 0);
    const terminal = !retry || attemptCount >= HELPDESK_NOTIFICATION_MAX_ATTEMPTS;
    const retryAt = terminal
      ? null
      : new Date(at.getTime() + helpdeskNotificationRetryDelay(attemptCount));
    const query = MessageModel.updateOne(
      {
        _id: message._id,
        companyId: message.companyId,
        ticketId: message.ticketId,
        messageType: 'PUBLIC',
        notificationState: 'PENDING',
        notificationLeaseUntil: message.notificationLeaseUntil,
      },
      {
        $set: {
          notificationState: terminal ? state : 'PENDING',
          notificationNextAttemptAt: terminal ? null : retryAt,
          notificationLeaseUntil: null,
          ...(terminal && state === 'DELIVERED' ? { notificationDeliveredAt: at } : {}),
        },
      },
    );
    return query;
  };

  const processMessage = async ({ candidate, at }) => {
    const claimed = await claimMessage({ message: candidate, at });
    if (!claimed) return { skipped: true };
    try {
      // Re-read the committed public message without selecting its body,
      // attachment metadata, or private storage fields.
      const message = await queryWithOptions(
        MessageModel.findOne({
          _id: claimed._id,
          companyId: claimed.companyId,
          ticketId: claimed.ticketId,
          messageType: 'PUBLIC',
        }),
        { select: MESSAGE_DELIVERY_PROJECTION },
      );
      if (!message || message.notificationState !== 'PENDING') {
        await finishMessage({ message: claimed, state: 'SUPPRESSED', at });
        return { suppressed: true };
      }
      const context = await loadTicketContext({ companyId: message.companyId, ticketId: message.ticketId });
      const result = context
        ? await deliverEvent({
          ticket: context.ticket,
          queue: context.queue,
          eventType: 'PUBLIC_REPLY',
          eventIdentity: `message:${idString(message._id)}`,
          actorUserId: message.authorUserId,
        })
        : 'SUPPRESSED';
      await finishMessage({ message: claimed, state: result, at });
      return { delivered: result === 'DELIVERED', suppressed: result === 'SUPPRESSED' };
    } catch {
      await finishMessage({ message: claimed, state: 'FAILED', at, retry: true }).catch(() => {});
      return { failed: true };
    }
  };

  const reconcilePendingNotifications = async ({ limit = 100, now: at } = {}) => {
    const when = asDate(at) || asDate(now()) || new Date();
    const batchSize = Number.isInteger(Number(limit))
      ? Math.min(HELPDESK_NOTIFICATION_MAX_RECONCILE_BATCH, Math.max(1, Number(limit)))
      : 100;
    const ticketFilter = {
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      $or: [
        {
          'notificationGap.state': 'PENDING',
          'notificationGap.nextAttemptAt': { $lte: when },
        },
        {
          'notificationGap.state': { $ne: 'PENDING' },
          notificationEvents: {
            $elemMatch: {
              state: 'PENDING',
              nextAttemptAt: { $lte: when },
            },
          },
        },
      ],
    };
    const ticketCandidates = await queryWithOptions(
      TicketModel.find(ticketFilter),
      {
        select: TICKET_OUTBOX_PROJECTION,
        sort: { companyId: 1, _id: 1 },
        limit: batchSize,
      },
    );
    const messageCandidates = await queryWithOptions(
      MessageModel.find({
        messageType: 'PUBLIC',
        notificationState: 'PENDING',
        notificationNextAttemptAt: { $lte: when },
      }),
      {
        select: MESSAGE_DELIVERY_PROJECTION,
        sort: { notificationNextAttemptAt: 1, companyId: 1, createdAt: 1, _id: 1 },
        limit: batchSize,
      },
    );

    const summary = {
      ticketsInspected: (ticketCandidates || []).length,
      ticketEventsDelivered: 0,
      ticketEventsSuppressed: 0,
      ticketGapsDelivered: 0,
      ticketGapsSuppressed: 0,
      ticketEventsFailed: 0,
      messagesInspected: (messageCandidates || []).length,
      messagesDelivered: 0,
      messagesSuppressed: 0,
      messagesFailed: 0,
      limit: batchSize,
    };

    for (const ticket of ticketCandidates || []) {
      try {
        const result = await processTicketEvent({ ticket, at: when });
        if (result.delivered) {
          if (ticket.notificationGap?.state === 'PENDING') summary.ticketGapsDelivered += 1;
          else summary.ticketEventsDelivered += 1;
        }
        if (result.suppressed) {
          if (ticket.notificationGap?.state === 'PENDING') summary.ticketGapsSuppressed += 1;
          else summary.ticketEventsSuppressed += 1;
        }
        if (result.failed) summary.ticketEventsFailed += 1;
      } catch {
        summary.ticketEventsFailed += 1;
      }
    }

    for (const message of messageCandidates || []) {
      try {
        const result = await processMessage({ candidate: message, at: when });
        if (result.delivered) summary.messagesDelivered += 1;
        if (result.suppressed) summary.messagesSuppressed += 1;
        if (result.failed) summary.messagesFailed += 1;
      } catch {
        summary.messagesFailed += 1;
      }
    }
    return summary;
  };

  return { reconcilePendingNotifications };
};
