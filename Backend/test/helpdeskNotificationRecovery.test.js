// PHASE 38.7 — durable Helpdesk notification retry and realtime recovery.
// Mongo, Redis, NATS, sockets, email providers and external network are not used.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV ||= 'test';
process.env.REDIS_ENABLED ||= 'false';

const [serviceModule, rulesModule, dispatcherModule, realtimeNudgeModule, chatKeysModule] = await Promise.all([
  import('../src/services/helpdesk/helpdeskNotificationService.js'),
  import('../src/services/helpdesk/helpdeskNotificationRules.js'),
  import('../src/services/helpdesk/helpdeskNotificationDispatcher.js'),
  import('../src/socket/realtimeNudge.js'),
  import('../src/utils/chatKeys.js'),
]);
const { helpdeskNotificationService, resolveHelpdeskNotificationRecipientIds } = serviceModule;
const { helpdeskNotificationRetryDelay } = rulesModule;
const { startHelpdeskNotificationDispatcher, HELPDESK_NOTIFICATION_RECONCILE_INTERVAL_MS } = dispatcherModule;
const { bindRealtimeNudge, unbindRealtimeNudge, notifyHelpdeskNotificationsChanged } = realtimeNudgeModule;
const { userRoom } = chatKeysModule;

const COMPANY = '000000000000000000000064';
const REQUESTER = '000000000000000000000101';
const GENERAL_AGENT = '000000000000000000000201';
const RESTRICTED_AGENT = '000000000000000000000202';
const QUEUE_ID = '000000000000000000000501';
const TICKET_ID = '000000000000000000000601';
const NOW = new Date('2026-05-15T12:00:00.000Z');

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const id = (value) => String(value?._id || value || '');

const query = (resolver) => {
  let sortSpec = null;
  let limitCount = null;
  const chain = {
    select() { return chain; },
    lean() { return chain; },
    sort(value) { sortSpec = value; return chain; },
    limit(value) { limitCount = value; return chain; },
    then(onFulfilled, onRejected) {
      return Promise.resolve().then(resolver).then((value) => {
        let result = clone(value);
        if (Array.isArray(result)) {
          if (sortSpec) {
            const fields = Object.entries(sortSpec);
            result.sort((left, right) => {
              for (const [field, direction] of fields) {
                const leftValue = String(field).split('.').reduce((part, key) => part?.[key], left);
                const rightValue = String(field).split('.').reduce((part, key) => part?.[key], right);
                if (String(leftValue ?? '') === String(rightValue ?? '')) continue;
                return (leftValue > rightValue ? 1 : -1) * direction;
              }
              return 0;
            });
          }
          if (Number.isInteger(limitCount)) result = result.slice(0, limitCount);
        }
        return result;
      }).then(onFulfilled, onRejected);
    },
  };
  return chain;
};

const makeTicket = () => ({
  _id: TICKET_ID,
  companyId: COMPANY,
  ticketKind: 'HELPDESK',
  ticketNumber: 'HD-000601',
  user: REQUESTER,
  queueId: QUEUE_ID,
  assignedTo: RESTRICTED_AGENT,
  isConfidential: true,
  status: 'closed',
  subject: 'Private subject must never leave Mongo',
  message: 'Private ticket description must never be sent',
  resolutionCycle: 1,
  resolvedAt: new Date(NOW.getTime() - 60_000),
  closedAt: new Date(NOW.getTime() - 30_000),
  closedBy: REQUESTER,
  closureReason: 'REQUESTER_CONFIRMED',
  lifecycleSequence: 1,
  notificationSequence: 1,
  notificationProcessedSequence: 0,
  notificationEvents: [{
    sequence: 1,
    type: 'TICKET_RESOLUTION_CONFIRMED',
    milestone: null,
    createdAt: NOW,
    state: 'PENDING',
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseUntil: null,
  }],
  sla: null,
});

const makeQueue = () => ({
  _id: QUEUE_ID,
  companyId: COMPANY,
  enabled: true,
  agents: [GENERAL_AGENT, RESTRICTED_AGENT],
  managers: [],
  confidentiality: { enabled: true, agentIds: [RESTRICTED_AGENT], reviewerIds: [] },
});

const makeTicketModel = (ticket) => ({
  ticket,
  calls: { find: [], findOne: [], findOneAndUpdate: [] },
  find(filter) {
    this.calls.find.push(clone(filter));
    return query(() => [this.ticket]);
  },
  findOne(filter) {
    this.calls.findOne.push(clone(filter));
    const result = id(filter._id) === id(this.ticket._id)
      && id(filter.companyId) === id(this.ticket.companyId)
      && filter.ticketKind === this.ticket.ticketKind
      ? this.ticket
      : null;
    return query(() => result);
  },
  findOneAndUpdate(filter, update, options = {}) {
    this.calls.findOneAndUpdate.push({ filter: clone(filter), update: clone(update), options: clone(options) });
    return query(() => {
      const eventFilter = filter.notificationEvents?.$elemMatch;
      if (id(filter._id) !== id(this.ticket._id)
        || id(filter.companyId) !== id(this.ticket.companyId)
        || filter.ticketKind !== this.ticket.ticketKind
        || Number(filter.notificationSequence) !== this.ticket.notificationSequence
        || (filter.notificationProcessedSequence?.$in
          && !filter.notificationProcessedSequence.$in.some((value) => Number(value || 0) === this.ticket.notificationProcessedSequence))) {
        return null;
      }
      const event = this.ticket.notificationEvents.find((candidate) =>
        (!eventFilter || Number(candidate.sequence) === Number(eventFilter.sequence))
        && (!eventFilter?.state || candidate.state === eventFilter.state)
        && (!eventFilter?.leaseUntil || candidate.leaseUntil?.getTime() === eventFilter.leaseUntil.getTime())
        && (!eventFilter?.nextAttemptAt?.$lte || candidate.nextAttemptAt?.getTime() <= eventFilter.nextAttemptAt.$lte.getTime()));
      if (!event) return null;

      const claim = Object.hasOwn(update.$inc || {}, 'notificationEvents.$[event].attemptCount');
      if (claim) {
        const leaseUntil = update.$set['notificationEvents.$[event].leaseUntil'];
        event.leaseUntil = clone(leaseUntil);
        event.nextAttemptAt = clone(update.$set['notificationEvents.$[event].nextAttemptAt']);
        event.attemptCount += update.$inc['notificationEvents.$[event].attemptCount'];
      } else {
        for (const [path, value] of Object.entries(update.$set || {})) {
          if (path.startsWith('notificationEvents.$[event].')) {
            const field = path.split('.').at(-1);
            event[field] = clone(value);
          }
        }
        if (Object.hasOwn(update.$set || {}, 'notificationProcessedSequence')) {
          this.ticket.notificationProcessedSequence = update.$set.notificationProcessedSequence;
        }
      }
      return this.ticket;
    });
  },
});

const makeWorld = () => {
  const TicketModel = makeTicketModel(makeTicket());
  const queue = makeQueue();
  const notifications = new Map();
  const notifierCalls = [];
  const realtimeCalls = [];
  let failFirstBulkWrite = true;
  const NotificationModel = {
    async bulkWrite(operations) {
      notifierCalls.push(clone(operations));
      if (failFirstBulkWrite) {
        failFirstBulkWrite = false;
        throw new Error('simulated temporary Mongo outbox delivery failure');
      }
      for (const operation of operations) {
        const doc = operation.updateOne.update.$setOnInsert;
        const key = `${doc.companyId}:${doc.user}:${doc.eventKey}`;
        if (!notifications.has(key)) notifications.set(key, clone(doc));
      }
    },
  };
  const service = helpdeskNotificationService({
    TicketModel,
    MessageModel: { find() { return query(() => []); } },
    QueueModel: { findOne(filter) { return query(() => id(filter.companyId) === COMPANY && id(filter._id) === QUEUE_ID ? queue : null); } },
    UserModel: { find(filter) {
      const allowed = filter._id?.$in || [];
      return query(() => [RESTRICTED_AGENT, GENERAL_AGENT]
        .filter((userId) => allowed.some((candidate) => id(candidate) === userId))
        .map((userId) => ({ _id: userId, companyId: COMPANY, status: 'ACTIVE' })));
    } },
    PreferenceModel: { find() { return query(() => []); } },
    NotificationModel,
    realtimePublisher: {
      async notify(input) {
        realtimeCalls.push(clone(input));
        throw new Error('simulated Redis/socket outage');
      },
    },
    now: () => NOW,
  });
  return { TicketModel, service, notifications, notifierCalls, realtimeCalls };
};

test('confidential recipient selection honors queue arrays, restricted-agent membership, and safe fallbacks', () => {
  const ticket = makeTicket();
  const queue = makeQueue();
  assert.deepEqual(resolveHelpdeskNotificationRecipientIds({ ticket, queue, eventType: 'TICKET_RESOLUTION_CONFIRMED' }), [RESTRICTED_AGENT]);
  assert.deepEqual(resolveHelpdeskNotificationRecipientIds({ ticket: { ...ticket, assignedTo: GENERAL_AGENT }, queue, eventType: 'TICKET_RESOLUTION_CONFIRMED' }), []);
  assert.deepEqual(resolveHelpdeskNotificationRecipientIds({ ticket: { ...ticket, assignedTo: '000000000000000000000999' }, queue, eventType: 'TICKET_RESOLUTION_CONFIRMED' }), []);
  assert.deepEqual(resolveHelpdeskNotificationRecipientIds({ ticket: { ...ticket, companyId: '000000000000000000000065' }, queue, eventType: 'TICKET_RESOLUTION_CONFIRMED' }), []);
  assert.deepEqual(resolveHelpdeskNotificationRecipientIds({ ticket, queue, eventType: 'UNSUPPORTED_INTERNAL_EVENT' }), []);
});

test('realtime Helpdesk change nudges are data-less, personal-room-only, deduplicated, and optional', () => {
  const emitted = [];
  bindRealtimeNudge({
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  });
  assert.equal(notifyHelpdeskNotificationsChanged([RESTRICTED_AGENT, RESTRICTED_AGENT, null]), true);
  assert.deepEqual(emitted, [{
    room: userRoom(RESTRICTED_AGENT),
    event: 'helpdesk:notifications:changed',
    payload: {},
  }]);
  unbindRealtimeNudge();
  assert.equal(notifyHelpdeskNotificationsChanged([RESTRICTED_AGENT]), false);
});

test('API notification recovery starts without Redis and stops overlapping/scheduled runs cleanly', async () => {
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let tick;
  let cleared = false;
  let unrefed = false;
  let calls = 0;
  let resolveInfo;
  const infoLogged = new Promise((resolve) => { resolveInfo = resolve; });
  const stop = startHelpdeskNotificationDispatcher({
    service: {
      async reconcilePendingNotifications({ limit }) {
        calls += 1;
        assert.equal(limit, 100);
        notifyStarted();
        return pending;
      },
    },
    log: {
      info() { resolveInfo(); },
      warn() {},
    },
    setIntervalFn(callback, interval) {
      assert.equal(interval, HELPDESK_NOTIFICATION_RECONCILE_INTERVAL_MS);
      tick = callback;
      return { unref() { unrefed = true; } };
    },
    clearIntervalFn() { cleared = true; },
  });
  await started;
  assert.equal(unrefed, true);
  tick();
  assert.equal(calls, 1, 'overlapping notification sweeps are suppressed');
  stop();
  tick();
  assert.equal(cleared, true);
  finish({ ticketsInspected: 1, ticketEventsDelivered: 1, ticketEventsFailed: 0, messagesInspected: 0, messagesDelivered: 0, messagesFailed: 0 });
  await infoLogged;
  await Promise.resolve();
  assert.equal(calls, 1, 'a stopped dispatcher does not run after a Redis/realtime outage');
});

test('Mongo-backed notification recovery retries transient delivery, keeps event identity, and treats realtime as best-effort', async () => {
  const world = makeWorld();
  const originalBusinessState = {
    status: world.TicketModel.ticket.status,
    closureReason: world.TicketModel.ticket.closureReason,
    lifecycleSequence: world.TicketModel.ticket.lifecycleSequence,
    resolvedAt: world.TicketModel.ticket.resolvedAt,
    closedAt: world.TicketModel.ticket.closedAt,
  };

  const first = await world.service.reconcilePendingNotifications({ limit: 10, now: NOW });
  assert.equal(first.ticketsInspected, 1);
  assert.equal(first.ticketEventsFailed, 1);
  assert.equal(first.ticketEventsDelivered, 0);
  assert.equal(world.notifications.size, 0);
  assert.equal(world.TicketModel.ticket.notificationProcessedSequence, 0);
  assert.equal(world.TicketModel.ticket.notificationEvents[0].state, 'PENDING');
  assert.equal(world.TicketModel.ticket.notificationEvents[0].attemptCount, 1);
  assert.equal(world.TicketModel.ticket.notificationEvents[0].nextAttemptAt.getTime(), NOW.getTime() + helpdeskNotificationRetryDelay(1));

  const retryAt = world.TicketModel.ticket.notificationEvents[0].nextAttemptAt;
  const retry = await world.service.reconcilePendingNotifications({ limit: 10, now: retryAt });
  assert.equal(retry.ticketEventsDelivered, 1);
  assert.equal(retry.ticketEventsFailed, 0);
  assert.equal(world.TicketModel.ticket.notificationProcessedSequence, 1);
  assert.equal(world.TicketModel.ticket.notificationEvents[0].state, 'DELIVERED');
  assert.equal(world.notifications.size, 1);
  assert.equal(world.notifierCalls.length, 2);
  assert.equal(world.realtimeCalls.length, 1);
  assert.deepEqual(world.realtimeCalls[0], { companyId: COMPANY, userIds: [RESTRICTED_AGENT] });

  const [notification] = [...world.notifications.values()];
  assert.equal(notification.user, RESTRICTED_AGENT);
  assert.equal(notification.type, 'SUPPORT');
  assert.equal(notification.title, 'Helpdesk update');
  assert.equal(notification.message, 'There is an update in Helpdesk.');
  assert.equal(notification.link, '/app/helpdesk');
  assert.equal(Object.hasOwn(notification, 'ticketNumber'), false);
  assert.equal(Object.hasOwn(notification, 'subject'), false);
  assert.equal(Object.hasOwn(notification, 'messageBody'), false);
  assert.equal(Object.hasOwn(notification, 'reason'), false);

  const repeated = await world.service.reconcilePendingNotifications({ limit: 10, now: retryAt });
  assert.equal(repeated.ticketEventsDelivered, 0);
  assert.equal(world.notifications.size, 1);
  assert.equal(world.notifierCalls.length, 2);
  assert.deepEqual({
    status: world.TicketModel.ticket.status,
    closureReason: world.TicketModel.ticket.closureReason,
    lifecycleSequence: world.TicketModel.ticket.lifecycleSequence,
    resolvedAt: world.TicketModel.ticket.resolvedAt,
    closedAt: world.TicketModel.ticket.closedAt,
  }, originalBusinessState);
});
