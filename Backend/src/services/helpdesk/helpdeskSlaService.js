import { DateTime } from 'luxon';
import HelpdeskSlaPolicy from '../../models/HelpdeskSlaPolicy.js';
import HelpdeskQueue from '../../models/HelpdeskQueue.js';
import HelpdeskTicket from '../../models/HelpdeskTicket.js';
import HelpdeskMessage from '../../models/HelpdeskMessage.js';
import User from '../../models/User.js';
import ApiError from '../../utils/ApiError.js';
import { SUPPORT_TICKET_KIND } from '../../utils/supportTicketKinds.js';
import { getHolidaysForUser } from '../../utils/scheduleEngine.js';
import { HELPDESK_PRIORITIES } from './helpdeskRules.js';
import {
  HELPDESK_SLA_MAX_MINUTES,
  HELPDESK_SLA_MAX_RECONCILE_BATCH,
  HELPDESK_SLA_MAX_SEARCH_DAYS,
  applyHelpdeskSlaDueEvents,
  createHelpdeskSlaState,
  rebaseHelpdeskSla,
  transitionHelpdeskSlaStatus,
  validateHelpdeskSlaPolicy,
} from './helpdeskSlaRules.js';
import {
  addHelpdeskNotificationSequenceFilter,
  buildHelpdeskTicketNotificationAppend,
  diffHelpdeskSlaNotificationEvents,
} from './helpdeskNotificationRules.js';

const FIVE_YEAR_MS = (366 * 5) * 24 * 60 * 60 * 1000;
const ID_RE = /^[a-f\d]{24}$/i;

const plain = (value) => {
  if (value && typeof value.toObject === 'function') return value.toObject({ depopulate: true });
  return value;
};

const toDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const idString = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const applyQueryOptions = (query, { select, sort, limit, lean = true } = {}) => {
  let next = query;
  if (select && typeof next?.select === 'function') next = next.select(select);
  if (sort && typeof next?.sort === 'function') next = next.sort(sort);
  if (Number.isInteger(limit) && typeof next?.limit === 'function') next = next.limit(limit);
  if (lean && typeof next?.lean === 'function') next = next.lean();
  return next;
};

const boundedBatchSize = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 100;
  return Math.min(parsed, HELPDESK_SLA_MAX_RECONCILE_BATCH);
};

const serializePolicy = (rawPolicy) => {
  const policy = plain(rawPolicy);
  if (!policy) return null;
  return {
    enabled: policy.enabled === true,
    version: Number(policy.version) || 1,
    clockMode: policy.clockMode,
    timeZone: policy.timeZone,
    excludeHolidays: policy.excludeHolidays === true,
    weeklyHours: (policy.weeklyHours || []).map((day) => ({
      weekday: day.weekday,
      windows: (day.windows || []).map((window) => ({ start: window.start, end: window.end })),
    })),
    targets: Object.fromEntries(HELPDESK_PRIORITIES.map((priority) => [
      priority,
      {
        firstResponseMinutes: Number(policy.targets?.[priority]?.firstResponseMinutes),
        resolutionMinutes: Number(policy.targets?.[priority]?.resolutionMinutes),
      },
    ])),
    warningPercent: Number(policy.warningPercent) || 80,
    pauseStatuses: {
      firstResponse: [...(policy.pauseStatuses?.firstResponse || [])],
      resolution: [...(policy.pauseStatuses?.resolution || [])],
    },
    updatedAt: policy.updatedAt || null,
  };
};

const safeCalendarError = () =>
  ApiError.unavailable('The Helpdesk SLA business calendar is temporarily unavailable.');

export const helpdeskSlaService = (deps = {}) => {
  const PolicyModel = deps.PolicyModel || HelpdeskSlaPolicy;
  const QueueModel = deps.QueueModel || HelpdeskQueue;
  const TicketModel = deps.TicketModel || HelpdeskTicket;
  const MessageModel = deps.MessageModel || HelpdeskMessage;
  const UserModel = deps.UserModel || User;
  const holidayReader = deps.holidayReader || getHolidaysForUser;
  const now = deps.now || (() => new Date());
  const notificationIntentsEnabled = deps.notificationIntentsEnabled !== false;

  const requireTenant = (companyId) => {
    if (!companyId) throw ApiError.forbidden('A tenant is required for Helpdesk SLA access.');
  };

  const requireQueueId = (queueId) => {
    if (!ID_RE.test(String(queueId || ''))) throw ApiError.badRequest('queueId is invalid.');
  };

  const findQueue = async (companyId, queueId) => {
    try {
      return await applyQueryOptions(
        QueueModel.findOne({ _id: queueId, companyId }),
        { select: '_id companyId enabled name' },
      );
    } catch {
      throw ApiError.unavailable('Helpdesk queue data is temporarily unavailable.');
    }
  };

  const findPolicy = async (companyId, queueId) => {
    try {
      return await applyQueryOptions(
        PolicyModel.findOne({ companyId, queueId }),
        { select: '-updatedBy' },
      );
    } catch {
      throw ApiError.unavailable('Helpdesk SLA policy is temporarily unavailable.');
    }
  };

  const getQueuePolicy = async ({ companyId, queueId } = {}) => {
    requireTenant(companyId);
    requireQueueId(queueId);
    const queue = await findQueue(companyId, queueId);
    if (!queue) throw ApiError.notFound('Helpdesk queue not found.');
    const policy = await findPolicy(companyId, queue._id);
    return {
      configured: Boolean(policy),
      policy: serializePolicy(policy),
    };
  };

  const updateQueuePolicy = async ({ companyId, queueId, actorId, input = {} } = {}) => {
    requireTenant(companyId);
    requireQueueId(queueId);
    const queue = await findQueue(companyId, queueId);
    if (!queue) throw ApiError.notFound('Helpdesk queue not found.');
    const checked = validateHelpdeskSlaPolicy(input);
    if (!checked.ok) throw ApiError.badRequest(checked.errors[0] || 'Helpdesk SLA policy is invalid.');

    // Compare-and-set the policy version so parallel administrators cannot
    // silently overwrite one another's schedule/targets.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await findPolicy(companyId, queue._id);
      if (!current) {
        try {
          const created = await PolicyModel.create({
            companyId,
            queueId: queue._id,
            ...checked.value,
            version: 1,
            updatedBy: actorId || null,
          });
          return { configured: true, policy: serializePolicy(created) };
        } catch (error) {
          if (error?.code === 11000) continue;
          if (error?.statusCode) throw error;
          throw ApiError.unavailable('Helpdesk SLA policy could not be saved.');
        }
      }

      const currentPlain = plain(current);
      let updated;
      try {
        updated = await applyQueryOptions(
          PolicyModel.findOneAndUpdate(
            {
              companyId,
              queueId: queue._id,
              version: Number(currentPlain.version) || 1,
            },
            {
              $set: {
                ...checked.value,
                updatedBy: actorId || null,
              },
              $inc: { version: 1 },
            },
            { returnDocument: 'after', runValidators: true },
          ),
          { select: '-updatedBy', lean: false },
        );
      } catch (error) {
        if (error?.statusCode) throw error;
        throw ApiError.unavailable('Helpdesk SLA policy could not be saved.');
      }
      if (updated) return { configured: true, policy: serializePolicy(updated) };
    }
    throw ApiError.conflict('The SLA policy changed while it was being updated. Refresh and try again.');
  };

  const requesterHolidayContext = async ({ companyId, requesterId }) => {
    try {
      const requester = await applyQueryOptions(
        UserModel.findOne({ _id: requesterId, companyId }),
        { select: '_id department branch' },
      );
      if (!requester) throw safeCalendarError();
      return {
        department: requester.department?._id || requester.department || null,
        branch: typeof requester.branch === 'string' ? requester.branch : '',
      };
    } catch (error) {
      if (error?.statusCode) throw error;
      throw safeCalendarError();
    }
  };

  const isHolidaySensitive = (snapshot) =>
    snapshot?.clockMode === 'BUSINESS_HOURS' && snapshot.excludeHolidays === true;

  const loadHolidayRows = async ({
    companyId,
    requesterId,
    holidayContext,
    snapshots = [],
    from,
    to,
  }) => {
    const relevant = snapshots.filter(isHolidaySensitive);
    if (!relevant.length) return [];
    if (!requesterId || !holidayContext) throw safeCalendarError();

    const timeZone = relevant[0].timeZone;
    if (!timeZone) throw safeCalendarError();
    const fromDate = toDate(from);
    const toDateValue = toDate(to);
    if (!fromDate || !toDateValue) throw safeCalendarError();
    // Pad the local date range so timezones on opposite sides of UTC do not
    // omit a holiday which intersects the requested instant range.
    const fromKey = DateTime.fromJSDate(fromDate, { zone: timeZone }).minus({ days: 2 }).toISODate();
    const toKey = DateTime.fromJSDate(toDateValue, { zone: timeZone }).plus({ days: 2 }).toISODate();
    if (!fromKey || !toKey) throw safeCalendarError();

    try {
      const rows = await holidayReader(
        companyId,
        {
          _id: requesterId,
          department: holidayContext.department || null,
          branch: holidayContext.branch || '',
        },
        { from: fromKey, to: toKey },
      );
      if (!Array.isArray(rows)) throw safeCalendarError();
      return rows;
    } catch (error) {
      if (error?.statusCode) throw error;
      throw safeCalendarError();
    }
  };

  const holidayRangeFor = (anchor, { future = true } = {}) => {
    const instant = toDate(anchor) || toDate(now());
    return {
      from: new Date(instant.getTime() - FIVE_YEAR_MS),
      to: new Date(instant.getTime() + (future ? FIVE_YEAR_MS : 0)),
    };
  };

  const initializeTicketSla = async ({
    companyId,
    queueId,
    requesterId,
    priority,
    createdAt,
  } = {}) => {
    requireTenant(companyId);
    const startedAt = toDate(createdAt) || toDate(now());
    const policyDoc = await findPolicy(companyId, queueId);
    const policy = serializePolicy(policyDoc);
    if (!policy?.enabled) return null;
    if (!HELPDESK_PRIORITIES.includes(priority)) {
      throw ApiError.badRequest('Ticket priority is not supported by Helpdesk SLA.');
    }

    let holidayContext = null;
    let holidays = [];
    if (isHolidaySensitive(policy)) {
      holidayContext = await requesterHolidayContext({ companyId, requesterId });
      const range = holidayRangeFor(startedAt);
      holidays = await loadHolidayRows({
        companyId,
        requesterId,
        holidayContext,
        snapshots: [policy],
        ...range,
      });
    }

    const sla = createHelpdeskSlaState({
      policy,
      policyQueueId: queueId,
      priority,
      startedAt,
      holidayContext,
      holidays,
    });
    if (!sla) {
      throw new ApiError(422, `The Helpdesk SLA schedule cannot produce a deadline within ${HELPDESK_SLA_MAX_SEARCH_DAYS} days.`);
    }
    return sla;
  };

  const holidaysForTransition = async ({ companyId, requesterId, sla, extraPolicy = null, at }) => {
    const snapshots = [sla, extraPolicy].filter(Boolean);
    if (!snapshots.some(isHolidaySensitive)) return [];
    const range = holidayRangeFor(at);
    return loadHolidayRows({
      companyId,
      requesterId,
      holidayContext: sla.holidayContext,
      snapshots,
      ...range,
    });
  };

  const applyStatusTransition = async ({
    companyId,
    ticket,
    fromStatus,
    toStatus,
    at,
  } = {}) => {
    if (!ticket?.sla) return null;
    const when = toDate(at) || toDate(now());
    const holidays = await holidaysForTransition({
      companyId,
      requesterId: ticket.user,
      sla: plain(ticket.sla),
      at: when,
    });
    try {
      return transitionHelpdeskSlaStatus({
        sla: plain(ticket.sla),
        fromStatus,
        toStatus,
        now: when,
        holidays,
        queueId: ticket.queueId,
      });
    } catch (error) {
      if (error?.statusCode) throw error;
      if (error instanceof RangeError) {
        throw new ApiError(422, 'The Helpdesk SLA schedule cannot produce a valid deadline.');
      }
      throw error;
    }
  };

  const applyPriorityChange = async ({ companyId, ticket, priority, at } = {}) => {
    if (!ticket?.sla) return null;
    const when = toDate(at) || toDate(now());
    const sla = plain(ticket.sla);
    const holidays = await holidaysForTransition({
      companyId,
      requesterId: ticket.user,
      sla,
      at: when,
    });
    try {
      return rebaseHelpdeskSla({
        sla,
        priority,
        now: when,
        holidays,
        currentQueueId: ticket.queueId,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ApiError(422, 'The Helpdesk SLA schedule cannot produce a valid deadline.');
      }
      throw error;
    }
  };

  const applyQueueTransfer = async ({ companyId, ticket, queueId, priority, at } = {}) => {
    if (!ticket?.sla) return null;
    requireQueueId(queueId);
    const when = toDate(at) || toDate(now());
    const currentSla = plain(ticket.sla);
    const targetPolicyDoc = await findPolicy(companyId, queueId);
    const targetPolicy = serializePolicy(targetPolicyDoc);
    const effectivePolicy = targetPolicy?.enabled ? targetPolicy : null;
    const holidays = await holidaysForTransition({
      companyId,
      requesterId: ticket.user,
      sla: currentSla,
      extraPolicy: effectivePolicy,
      at: when,
    });
    try {
      return rebaseHelpdeskSla({
        sla: currentSla,
        priority,
        now: when,
        holidays,
        policy: effectivePolicy,
        policyQueueId: effectivePolicy ? queueId : null,
        currentQueueId: queueId,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ApiError(422, 'The Helpdesk SLA schedule cannot produce a valid deadline.');
      }
      throw error;
    }
  };

  const findEarliestQualifyingReply = async ({ companyId, ticket }) => {
    const message = await applyQueryOptions(
      MessageModel.findOne({
        companyId,
        ticketId: ticket._id,
        messageType: 'PUBLIC',
        authorUserId: { $ne: ticket.user },
      }),
      { select: 'createdAt', sort: { createdAt: 1, _id: 1 } },
    );
    return toDate(message?.createdAt);
  };

  const withSlaNotificationIntent = ({ ticket, previousSla, nextSla, filter, at }) => {
    if (!notificationIntentsEnabled) return { filter, update: { $set: { sla: nextSla } } };
    const append = buildHelpdeskTicketNotificationAppend({
      ticket,
      eventTypes: diffHelpdeskSlaNotificationEvents(previousSla, nextSla),
      at,
    });
    if (!append) return { filter, update: { $set: { sla: nextSla } } };

    const update = { $set: { sla: nextSla }, ...append.update };
    update.$set = { ...update.$set, ...(append.update.$set || {}) };
    return {
      filter: addHelpdeskNotificationSequenceFilter(filter, ticket),
      update,
    };
  };

  const persistFirstResponse = async ({ companyId, ticketId, createdAt } = {}) => {
    requireTenant(companyId);
    if (!ticketId) return { updated: false, recoveryPending: true };
    const messageCreatedAt = toDate(createdAt) || toDate(now());

    // The message is already immutable and committed. A failure to update its
    // SLA projection must not turn a saved reply into a failed/duplicated post;
    // the due sweep re-derives the earliest message from Mongo before a breach.
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const ticket = await applyQueryOptions(
          TicketModel.findOne({
            _id: ticketId,
            companyId,
            ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
          }),
          {
            select: '_id companyId user queueId ticketNumber sla notificationSequence ' +
              'notificationProcessedSequence notificationEvents notificationGap',
          },
        );
        if (!ticket?.sla) return { updated: false, recoveryPending: false };
        let earliestReplyAt;
        try {
          earliestReplyAt = await findEarliestQualifyingReply({ companyId, ticket });
        } catch {
          // Do not complete the response clock from only the latest in-memory
          // event: the earliest committed reply is Mongo-authoritative. The due
          // sweep will retry the sorted, tenant/ticket-scoped lookup.
          return { updated: false, recoveryPending: true };
        }
        const timestamp = earliestReplyAt || messageCreatedAt;
        const when = toDate(now());
        const nextSla = applyHelpdeskSlaDueEvents({
          sla: plain(ticket.sla),
          now: when,
          firstResponseAt: timestamp,
          queueId: ticket.queueId,
        });
        const mutation = withSlaNotificationIntent({
          ticket,
          previousSla: ticket.sla,
          nextSla,
          at: when,
          filter: {
            _id: ticket._id,
            companyId,
            ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
            'sla.version': Number(ticket.sla.version) || 1,
          },
        });
        const updated = await TicketModel.findOneAndUpdate(
          mutation.filter,
          mutation.update,
          { returnDocument: 'after', runValidators: true, timestamps: false },
        );
        if (updated) return { updated: true, recoveryPending: false };
      }
    } catch {
      return { updated: false, recoveryPending: true };
    }
    return { updated: false, recoveryPending: true };
  };

  const reconcileOneDueTicket = async ({ candidate, nowAt }) => {
    const companyId = candidate?.companyId;
    const ticketId = candidate?._id;
    if (!companyId || !ticketId) return { processed: false, skipped: true };
    const ticket = await applyQueryOptions(
      TicketModel.findOne({
        _id: ticketId,
        companyId,
        ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      }),
      {
        select: '_id companyId user queueId ticketNumber status sla notificationSequence ' +
          'notificationProcessedSequence notificationEvents notificationGap',
      },
    );
    if (!ticket?.sla) return { processed: false, skipped: true };
    const storedNextAction = toDate(ticket.sla.nextActionAt);
    if (!storedNextAction || storedNextAction > nowAt) return { processed: false, skipped: true };

    // Re-derive the earliest immutable public staff reply even when the
    // projection already says COMPLETED. This repairs an earlier timestamp
    // after a concurrent/retried post without depending on process memory.
    const persistedFirstResponseAt = toDate(ticket.sla.firstResponse?.firstResponseAt)
      || toDate(ticket.sla.firstResponse?.completedAt);
    const earliestReplyAt = await findEarliestQualifyingReply({ companyId, ticket });
    const firstResponseAt = earliestReplyAt || persistedFirstResponseAt;

    const nextSla = applyHelpdeskSlaDueEvents({
      sla: plain(ticket.sla),
      now: nowAt,
      firstResponseAt,
      queueId: ticket.queueId,
    });
    const mutation = withSlaNotificationIntent({
      ticket,
      previousSla: ticket.sla,
      nextSla,
      at: nowAt,
      filter: {
        _id: ticket._id,
        companyId,
        ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
        'sla.version': Number(ticket.sla.version) || 1,
        'sla.nextActionAt': storedNextAction,
      },
    });
    const updated = await TicketModel.findOneAndUpdate(
      mutation.filter,
      mutation.update,
      { returnDocument: 'after', runValidators: true, timestamps: false },
    );
    return updated
      ? { processed: true, skipped: false }
      : { processed: false, skipped: true };
  };

  const reconcileDueTickets = async ({ limit = 100, now: at } = {}) => {
    const nowAt = toDate(at) || toDate(now());
    const batchSize = boundedBatchSize(limit);
    const candidates = await applyQueryOptions(
      TicketModel.find({
        ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
        'sla.nextActionAt': { $lte: nowAt },
      }),
      {
        select: '_id companyId sla.nextActionAt',
        sort: { 'sla.nextActionAt': 1, companyId: 1, _id: 1 },
        limit: batchSize,
      },
    );
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of candidates || []) {
      try {
        const result = await reconcileOneDueTicket({ candidate, nowAt });
        if (result.processed) processed += 1;
        else skipped += 1;
      } catch {
        // The next indexed sweep retries this Mongo-authoritative event. Do not
        // log ticket contents, message bodies, or cross-tenant queue payloads.
        failed += 1;
      }
    }
    return {
      inspected: (candidates || []).length,
      processed,
      skipped,
      failed,
      limit: batchSize,
    };
  };

  const stopTicketSla = async ({ companyId, ticket, status, at } = {}) => {
    if (!ticket?.sla) return null;
    return applyStatusTransition({
      companyId,
      ticket,
      fromStatus: ticket.status,
      toStatus: status,
      at,
    });
  };

  return {
    getQueuePolicy,
    updateQueuePolicy,
    initializeTicketSla,
    applyStatusTransition,
    applyPriorityChange,
    applyQueueTransfer,
    persistFirstResponse,
    reconcileDueTickets,
    stopTicketSla,
  };
};
