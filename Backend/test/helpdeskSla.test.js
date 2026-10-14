// PHASE 38.5 — tenant Helpdesk SLA policies, clocks, and durable recovery.
// Hermetic by design: no live Mongo, Redis, notification delivery, SMTP, or
// production worker is started by this suite.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV ||= 'test';
process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_helpdesk_sla_test';

const [rulesModule, serviceModule, conversationServiceModule, ticketModelModule, policyModelModule, messageModelModule, routeModule, validatorModule, controllerModule] = await Promise.all([
  import('../src/services/helpdesk/helpdeskSlaRules.js'),
  import('../src/services/helpdesk/helpdeskSlaService.js'),
  import('../src/services/helpdesk/helpdeskConversationService.js'),
  import('../src/models/HelpdeskTicket.js'),
  import('../src/models/HelpdeskSlaPolicy.js'),
  import('../src/models/HelpdeskMessage.js'),
  import('../src/routes/helpdeskRoutes.js'),
  import('../src/validators/helpdeskValidator.js'),
  import('../src/controllers/helpdeskController.js'),
]);

const {
  validateHelpdeskSlaPolicy,
  createHelpdeskSlaState,
  transitionHelpdeskSlaStatus,
  applyHelpdeskSlaDueEvents,
  rebaseHelpdeskSla,
  serializeHelpdeskSla,
} = rulesModule;
const { helpdeskSlaService } = serviceModule;
const { helpdeskConversationService } = conversationServiceModule;
const HelpdeskTicket = ticketModelModule.default;
const HelpdeskSlaPolicy = policyModelModule.default;
const HelpdeskMessage = messageModelModule.default;
const helpdeskRouter = routeModule.default;
const { helpdeskSlaPolicyValidator } = validatorModule;
const helpdeskController = controllerModule;

const oid = (number) => Number(number).toString(16).padStart(24, '0');
const COMPANY_A = oid(100);
const COMPANY_B = oid(200);
const REQUESTER = oid(1);
const AGENT = oid(2);
const QUEUE_A = oid(900);
const QUEUE_B = oid(901);
const TICKET_ID = oid(3000);
const MINUTE = 60_000;
const clone = (value) => value == null ? value : structuredClone(value);

const valueOf = (value) => {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === 'object' && typeof value.toHexString === 'function') return value.toHexString();
  if (value && typeof value === 'object' && value._id !== undefined) return valueOf(value._id);
  return value;
};
const getPath = (value, path) => String(path).split('.').reduce(
  (current, part) => current == null ? undefined : current[part],
  value,
);
const setPath = (value, path, next) => {
  const parts = String(path).split('.');
  let current = value;
  while (parts.length > 1) {
    const part = parts.shift();
    current[part] ??= {};
    current = current[part];
  }
  current[parts[0]] = clone(next);
};
const matchesValue = (actual, expected) => {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    const operators = Object.keys(expected).filter((key) => key.startsWith('$'));
    if (operators.length) {
      return operators.every((operator) => {
        const left = valueOf(actual);
        const right = valueOf(expected[operator]);
        if (operator === '$in') return expected.$in.some((entry) => matchesValue(actual, entry));
        if (operator === '$ne') return !matchesValue(actual, expected.$ne);
        if (operator === '$exists') return expected.$exists ? actual !== undefined : actual === undefined;
        if (operator === '$lte') return left !== undefined && left <= right;
        if (operator === '$lt') return left !== undefined && left < right;
        if (operator === '$gte') return left !== undefined && left >= right;
        if (operator === '$gt') return left !== undefined && left > right;
        if (operator === '$type') return expected.$type === 'date' ? actual instanceof Date : true;
        return false;
      });
    }
  }
  if (expected === null) return actual === null || actual === undefined;
  return valueOf(actual) === valueOf(expected);
};
const matches = (row, filter = {}) => Object.entries(filter).every(([key, expected]) => {
  if (key === '$and') return expected.every((part) => matches(row, part));
  if (key === '$or') return expected.some((part) => matches(row, part));
  return matchesValue(getPath(row, key), expected);
});

const sortRows = (rows, sortSpec) => {
  if (!sortSpec) return rows;
  return rows.sort((left, right) => {
    for (const [field, direction] of Object.entries(sortSpec)) {
      const a = valueOf(getPath(left, field));
      const b = valueOf(getPath(right, field));
      if (a === b) continue;
      if (a === undefined || a === null) return -1 * direction;
      if (b === undefined || b === null) return 1 * direction;
      return (a < b ? -1 : 1) * direction;
    }
    return 0;
  });
};

const makeQuery = (resolver, onOptions = () => {}) => {
  let sortSpec = null;
  let limitCount = null;
  const chain = {
    select() { return chain; },
    sort(value) { sortSpec = value; return chain; },
    limit(value) { limitCount = value; return chain; },
    lean() { return chain; },
    then(resolve, reject) {
      return Promise.resolve()
        .then(() => resolver({ sortSpec, limitCount }))
        .then((result) => {
          onOptions({ sortSpec, limitCount });
          if (Array.isArray(result) && sortSpec) {
            result.sort((left, right) => {
              for (const [field, direction] of Object.entries(sortSpec)) {
                const a = valueOf(getPath(left, field));
                const b = valueOf(getPath(right, field));
                if (a === b) continue;
                if (a === undefined || a === null) return -1 * direction;
                if (b === undefined || b === null) return 1 * direction;
                return (a < b ? -1 : 1) * direction;
              }
              return 0;
            });
          }
          if (Array.isArray(result) && Number.isInteger(limitCount)) return result.slice(0, limitCount);
          return result;
        })
        .then(resolve, reject);
    },
  };
  return chain;
};

const makeTicketModel = (seed = []) => {
  const rows = seed.map(clone);
  const calls = { find: [], findOne: [], findOneAndUpdate: [] };
  return {
    rows,
    calls,
    find(filter) {
      calls.find.push({ filter: clone(filter), limit: null, sort: null });
      const call = calls.find.at(-1);
      return makeQuery(
        () => rows.filter((row) => matches(row, filter)).map(clone),
        ({ sortSpec, limitCount }) => Object.assign(call, { sort: sortSpec, limit: limitCount }),
      );
    },
    findOne(filter) {
      calls.findOne.push(clone(filter));
      return makeQuery(({ sortSpec }) => clone(sortRows(rows.filter((row) => matches(row, filter)).map(clone), sortSpec)[0] || null));
    },
    findOneAndUpdate(filter, update) {
      calls.findOneAndUpdate.push({ filter: clone(filter), update: clone(update) });
      return makeQuery(() => {
        const row = rows.find((entry) => matches(entry, filter));
        if (!row) return null;
        for (const [path, value] of Object.entries(update.$set || {})) setPath(row, path, value);
        for (const [path, amount] of Object.entries(update.$inc || {})) {
          setPath(row, path, Number(getPath(row, path) || 0) + amount);
        }
        return clone(row);
      });
    },
  };
};

const makeGenericModel = (seed = []) => {
  const rows = seed.map(clone);
  const calls = { find: [], findOne: [], findOneAndUpdate: [], create: [] };
  const model = {
    rows,
    calls,
    find(filter) {
      calls.find.push({ filter: clone(filter), limit: null, sort: null });
      const call = calls.find.at(-1);
      return makeQuery(
        () => rows.filter((row) => matches(row, filter)).map(clone),
        ({ sortSpec, limitCount }) => Object.assign(call, { sort: sortSpec, limit: limitCount }),
      );
    },
    findOne(filter) {
      calls.findOne.push(clone(filter));
      return makeQuery(({ sortSpec }) => clone(sortRows(rows.filter((row) => matches(row, filter)).map(clone), sortSpec)[0] || null));
    },
    findOneAndUpdate(filter, update) {
      calls.findOneAndUpdate.push({ filter: clone(filter), update: clone(update) });
      return makeQuery(() => {
        const row = rows.find((entry) => matches(entry, filter));
        if (!row) return null;
        for (const [path, value] of Object.entries(update.$set || {})) setPath(row, path, value);
        for (const [path, amount] of Object.entries(update.$inc || {})) {
          setPath(row, path, Number(getPath(row, path) || 0) + amount);
        }
        return clone(row);
      });
    },
    async create(input) {
      calls.create.push(clone(input));
      const row = { _id: oid(7000 + rows.length), createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...clone(input) };
      rows.push(row);
      return clone(row);
    },
  };
  return model;
};

const validPolicy = (overrides = {}) => {
  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const targets = Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
    priority,
    { firstResponseMinutes: 240, resolutionMinutes: 480 },
  ]));
  return {
    enabled: true,
    clockMode: 'CALENDAR',
    timeZone: 'UTC',
    excludeHolidays: false,
    weeklyHours: weekdays.map((weekday) => ({
      weekday,
      windows: ['MON', 'TUE', 'WED', 'THU', 'FRI'].includes(weekday)
        ? [{ start: '09:00', end: '17:00' }]
        : [],
    })),
    targets,
    warningPercent: 80,
    pauseStatuses: { firstResponse: [], resolution: ['waiting_for_employee'] },
    ...clone(overrides),
  };
};

const slaFor = ({
  policy = validPolicy(),
  priority = 'normal',
  startedAt = new Date('2026-02-02T09:00:00.000Z'),
  holidays = [],
  queueId = QUEUE_A,
} = {}) => {
  const checked = validateHelpdeskSlaPolicy(policy);
  assert.equal(checked.ok, true, checked.errors?.join('; '));
  return createHelpdeskSlaState({
    policy: { ...checked.value, version: 3 },
    policyQueueId: queueId,
    priority,
    startedAt,
    holidays,
    holidayContext: { department: null, branch: '' },
  });
};

const ticketWithSla = (sla, overrides = {}) => ({
  _id: TICKET_ID,
  companyId: COMPANY_A,
  ticketKind: 'HELPDESK',
  user: REQUESTER,
  queueId: QUEUE_A,
  ticketNumber: 'HD-000301',
  status: 'in_progress',
  priority: 'normal',
  sla: clone(sla),
  ...clone(overrides),
});

const modelRows = ({ tickets = [], messages = [], policies = [], queues = [], users = [] } = {}) => ({
  TicketModel: makeTicketModel(tickets),
  MessageModel: makeGenericModel(messages),
  PolicyModel: makeGenericModel(policies),
  QueueModel: makeGenericModel(queues),
  UserModel: makeGenericModel(users),
});

const serviceFor = (rows, overrides = {}) => helpdeskSlaService({
  ...rows,
  holidayReader: async () => [],
  now: () => new Date('2026-02-02T09:00:00.000Z'),
  ...overrides,
});

const routeFor = (method, path) => helpdeskRouter.stack
  .filter((layer) => layer.route?.path === path && layer.route.methods[method]);

const runValidators = async (validators, req) => {
  let error = null;
  for (const middleware of validators) {
    await new Promise((resolve) => middleware(req, {}, (caught) => {
      error = caught || error;
      resolve();
    }));
    if (error) break;
  }
  if (error) throw error;
};

// ── pure policy and timezone rules ────────────────────────────────────────

test('policy validation is strict, bounded, timezone-aware, and uses Helpdesk priority/status enums', () => {
  const valid = validateHelpdeskSlaPolicy(validPolicy());
  assert.equal(valid.ok, true);
  assert.deepEqual(Object.keys(valid.value.targets), ['low', 'normal', 'high', 'urgent']);
  assert.deepEqual(valid.value.pauseStatuses, {
    firstResponse: [],
    resolution: ['waiting_for_employee'],
  });

  assert.equal(validateHelpdeskSlaPolicy(validPolicy({ companyId: COMPANY_A })).ok, false);
  assert.equal(validateHelpdeskSlaPolicy(validPolicy({ timeZone: 'Mars/Olympus' })).ok, false);
  assert.equal(validateHelpdeskSlaPolicy(validPolicy({ clockMode: 'CALENDAR', excludeHolidays: true })).ok, false);
  assert.equal(validateHelpdeskSlaPolicy(validPolicy({ targets: { ...validPolicy().targets, critical: { firstResponseMinutes: 1, resolutionMinutes: 1 } } })).ok, false);
  assert.equal(validateHelpdeskSlaPolicy(validPolicy({ targets: { ...validPolicy().targets, urgent: { firstResponseMinutes: 10_081, resolutionMinutes: 1 } } })).ok, false);
  assert.equal(validateHelpdeskSlaPolicy(validPolicy({ warningPercent: '80' })).ok, false);
  assert.equal(validateHelpdeskSlaPolicy(validPolicy({ warningPercent: true })).ok, false);
  assert.equal(validateHelpdeskSlaPolicy(validPolicy({ targets: { ...validPolicy().targets, normal: { firstResponseMinutes: '240', resolutionMinutes: 480 } } })).ok, false);
  assert.equal(validateHelpdeskSlaPolicy(validPolicy({ pauseStatuses: { firstResponse: ['closed'], resolution: [] } })).ok, false);

  const overlapping = validPolicy();
  overlapping.weeklyHours.find((entry) => entry.weekday === 'MON').windows = [
    { start: '09:00', end: '12:00' },
    { start: '11:30', end: '17:00' },
  ];
  assert.equal(validateHelpdeskSlaPolicy(overlapping).ok, false);
});

test('business-hour deadlines use the configured IANA zone and skip tenant holidays', () => {
  const base = validPolicy({
    clockMode: 'BUSINESS_HOURS',
    timeZone: 'Asia/Kolkata',
    excludeHolidays: true,
    weeklyHours: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((weekday) => ({
      weekday,
      windows: ['MON', 'TUE', 'WED', 'THU', 'FRI'].includes(weekday)
        ? [{ start: '09:00', end: '17:00' }]
        : [],
    })),
  });
  const targets = Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
    priority,
    { firstResponseMinutes: 60, resolutionMinutes: 120 },
  ]));
  const sla = slaFor({
    policy: { ...base, targets },
    startedAt: new Date('2026-02-02T12:00:00.000Z'), // Monday, 17:30 in Asia/Kolkata
    holidays: [{ date: '2026-02-03', dates: ['2026-02-03'], isOptional: false }],
  });
  assert.equal(sla.firstResponse.dueAt.toISOString(), '2026-02-04T04:30:00.000Z'); // Wednesday 10:00 IST
  assert.equal(sla.firstResponse.warningAt.toISOString(), '2026-02-04T04:18:00.000Z');
  assert.equal(sla.resolution.dueAt.toISOString(), '2026-02-04T05:30:00.000Z');
});

test('unpicked optional holidays do not close a window, but picked holidays do', () => {
  const policy = validPolicy({ clockMode: 'BUSINESS_HOURS', timeZone: 'Asia/Kolkata', excludeHolidays: true });
  const targets = Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
    priority,
    { firstResponseMinutes: 60, resolutionMinutes: 120 },
  ]));
  const start = new Date('2026-02-02T03:30:00.000Z'); // Monday 09:00 IST
  const unpicked = slaFor({
    policy: { ...policy, targets },
    startedAt: start,
    holidays: [{ date: '2026-02-02', dates: ['2026-02-02'], isOptional: true, picked: false }],
  });
  const picked = slaFor({
    policy: { ...policy, targets },
    startedAt: start,
    holidays: [{ date: '2026-02-02', dates: ['2026-02-02'], isOptional: true, picked: true }],
  });
  assert.equal(unpicked.firstResponse.dueAt.toISOString(), '2026-02-02T04:30:00.000Z');
  assert.equal(picked.firstResponse.dueAt.toISOString(), '2026-02-03T04:30:00.000Z');
});

test('DST fall-back folds choose the first opening and last closing instant deterministically', () => {
  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const policy = validPolicy({
    clockMode: 'BUSINESS_HOURS',
    timeZone: 'America/New_York',
    weeklyHours: weekdays.map((weekday) => ({
      weekday,
      windows: weekday === 'SUN' ? [{ start: '01:00', end: '02:00' }] : [],
    })),
    targets: Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
      priority,
      { firstResponseMinutes: 90, resolutionMinutes: 90 },
    ])),
  });
  const sla = slaFor({ policy, startedAt: new Date('2026-11-01T04:00:00.000Z') });
  assert.equal(sla.firstResponse.dueAt.toISOString(), '2026-11-01T06:30:00.000Z');
});

test('DST spring-forward gaps resolve forward in the configured zone', () => {
  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const policy = validPolicy({
    clockMode: 'BUSINESS_HOURS',
    timeZone: 'America/New_York',
    weeklyHours: weekdays.map((weekday) => ({
      weekday,
      windows: weekday === 'SUN' ? [{ start: '02:30', end: '04:00' }] : [],
    })),
    targets: Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
      priority,
      { firstResponseMinutes: 30, resolutionMinutes: 30 },
    ])),
  });
  const sla = slaFor({ policy, startedAt: new Date('2026-03-08T05:00:00.000Z') });
  assert.equal(sla.firstResponse.dueAt.toISOString(), '2026-03-08T08:00:00.000Z');
});

// ── independent clocks, pause/resume, changes, and escalation ────────────

test('waiting-for-employee pauses the configured resolution clock but not the independent response clock', () => {
  const policy = validPolicy({
    clockMode: 'BUSINESS_HOURS',
    timeZone: 'Asia/Kolkata',
    targets: Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
      priority,
      { firstResponseMinutes: 240, resolutionMinutes: 120 },
    ])),
  });
  const sla = slaFor({ policy, startedAt: new Date('2026-02-02T03:30:00.000Z') }); // Monday 09:00 IST
  const paused = transitionHelpdeskSlaStatus({
    sla,
    fromStatus: 'in_progress',
    toStatus: 'waiting_for_employee',
    now: new Date('2026-02-02T04:30:00.000Z'), // 10:00 IST
    queueId: QUEUE_A,
  });
  assert.equal(paused.resolution.state, 'PAUSED');
  assert.equal(paused.resolution.activeElapsedMs, 60 * MINUTE);
  assert.equal(paused.resolution.dueAt, null);
  assert.equal(paused.firstResponse.state, 'RUNNING');
  assert.equal(paused.firstResponse.dueAt.toISOString(), '2026-02-02T07:30:00.000Z');

  const resumed = transitionHelpdeskSlaStatus({
    sla: paused,
    fromStatus: 'waiting_for_employee',
    toStatus: 'in_progress',
    now: new Date('2026-02-02T06:30:00.000Z'), // 12:00 IST
    queueId: QUEUE_A,
  });
  assert.equal(resumed.resolution.state, 'RUNNING');
  assert.equal(resumed.resolution.activeElapsedMs, 60 * MINUTE);
  assert.equal(resumed.resolution.dueAt.toISOString(), '2026-02-02T07:30:00.000Z');
  assert.equal(resumed.firstResponse.dueAt.toISOString(), '2026-02-02T07:30:00.000Z');
});

test('public response completes only its own clock and uses the earliest qualifying timestamp', () => {
  const startedAt = new Date('2026-02-02T09:00:00.000Z');
  const sla = slaFor({ startedAt });
  const later = applyHelpdeskSlaDueEvents({
    sla,
    now: new Date('2026-02-02T09:40:00.000Z'),
    firstResponseAt: new Date('2026-02-02T09:35:00.000Z'),
    queueId: QUEUE_A,
  });
  assert.equal(later.firstResponse.state, 'COMPLETED');
  assert.equal(later.firstResponse.firstResponseAt.toISOString(), '2026-02-02T09:35:00.000Z');
  assert.equal(later.resolution.state, 'RUNNING');

  const earlier = applyHelpdeskSlaDueEvents({
    sla: later,
    now: new Date('2026-02-02T09:41:00.000Z'),
    firstResponseAt: new Date('2026-02-02T09:20:00.000Z'),
    queueId: QUEUE_A,
  });
  assert.equal(earlier.firstResponse.firstResponseAt.toISOString(), '2026-02-02T09:20:00.000Z');
  assert.equal(earlier.firstResponse.completedAt.toISOString(), '2026-02-02T09:20:00.000Z');
});

test('resolution completes only on the authorized workflow input; reopen carries elapsed time forward', () => {
  const sla = slaFor({ startedAt: new Date('2026-02-02T09:00:00.000Z') });
  const resolved = transitionHelpdeskSlaStatus({
    sla,
    fromStatus: 'in_progress',
    toStatus: 'resolved',
    now: new Date('2026-02-02T10:00:00.000Z'),
    queueId: QUEUE_A,
  });
  assert.equal(resolved.resolution.state, 'COMPLETED');
  assert.equal(resolved.resolution.completedAt.toISOString(), '2026-02-02T10:00:00.000Z');
  assert.equal(resolved.firstResponse.state, 'RUNNING');

  const reopened = transitionHelpdeskSlaStatus({
    sla: resolved,
    fromStatus: 'resolved',
    toStatus: 'in_progress',
    now: new Date('2026-02-02T11:00:00.000Z'),
    queueId: QUEUE_A,
  });
  assert.equal(reopened.resolution.state, 'RUNNING');
  assert.equal(reopened.resolution.activeElapsedMs, 60 * MINUTE);
  assert.equal(reopened.resolution.lastCompletedAt.toISOString(), '2026-02-02T10:00:00.000Z');
  assert.equal(reopened.resolution.dueAt.toISOString(), '2026-02-02T18:00:00.000Z');
});

test('warnings and breach state are durable, distinct per clock, and escalation routes to the current queue', () => {
  const startedAt = new Date('2026-02-02T09:00:00.000Z');
  const policy = validPolicy({
    targets: Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
      priority,
      { firstResponseMinutes: 60, resolutionMinutes: 120 },
    ])),
  });
  const sla = slaFor({ policy, startedAt });
  const warning = applyHelpdeskSlaDueEvents({
    sla,
    now: new Date('2026-02-02T09:49:00.000Z'),
    queueId: QUEUE_A,
  });
  assert.equal(warning.firstResponse.warningEligibleAt.toISOString(), '2026-02-02T09:48:00.000Z');
  assert.equal(warning.escalation.state, 'NONE');

  const breached = applyHelpdeskSlaDueEvents({
    sla: warning,
    now: new Date('2026-02-02T10:01:00.000Z'),
    queueId: QUEUE_A,
  });
  assert.equal(breached.firstResponse.breachedAt.toISOString(), '2026-02-02T10:00:00.000Z');
  assert.equal(breached.escalation.state, 'ELIGIBLE');
  assert.deepEqual(breached.escalation.triggers, ['FIRST_RESPONSE']);
  assert.equal(breached.escalation.queueId, QUEUE_A);
  assert.equal(breached.nextActionAt.toISOString(), '2026-02-02T10:36:00.000Z'); // resolution warning

  const moved = rebaseHelpdeskSla({
    sla: breached,
    priority: 'urgent',
    now: new Date('2026-02-02T10:02:00.000Z'),
    currentQueueId: QUEUE_B,
  });
  assert.equal(moved.firstResponse.breachedAt.toISOString(), '2026-02-02T10:00:00.000Z');
  assert.equal(moved.escalation.state, 'ELIGIBLE');
  assert.equal(moved.escalation.queueId, QUEUE_B);
  assert.equal(moved.policyQueueId, QUEUE_A); // no destination policy: retain the originating snapshot
});

test('priority and queue rebase carries accrued active minutes and retains the frozen ticket snapshot', () => {
  const targets = validPolicy().targets;
  targets.normal = { firstResponseMinutes: 120, resolutionMinutes: 240 };
  targets.high = { firstResponseMinutes: 180, resolutionMinutes: 360 };
  const sla = slaFor({ policy: validPolicy({ targets }), startedAt: new Date('2026-02-02T09:00:00.000Z') });
  const rebased = rebaseHelpdeskSla({
    sla,
    priority: 'high',
    now: new Date('2026-02-02T09:30:00.000Z'),
    currentQueueId: QUEUE_A,
  });
  assert.equal(rebased.appliedPriority, 'high');
  assert.equal(rebased.firstResponse.targetMinutes, 180);
  assert.equal(rebased.firstResponse.activeElapsedMs, 30 * MINUTE);
  assert.equal(rebased.firstResponse.dueAt.toISOString(), '2026-02-02T12:00:00.000Z');
});

test('transfer into an SLA-enabled queue rebases active time on its policy without resetting elapsed minutes', () => {
  const sourceTargets = Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
    priority,
    { firstResponseMinutes: 60, resolutionMinutes: 120 },
  ]));
  const source = slaFor({
    policy: validPolicy({ targets: sourceTargets }),
    startedAt: new Date('2026-02-02T09:00:00Z'),
    queueId: QUEUE_A,
  });
  const destinationTargets = Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
    priority,
    { firstResponseMinutes: 120, resolutionMinutes: 240 },
  ]));
  const checked = validateHelpdeskSlaPolicy(validPolicy({ targets: destinationTargets }));
  const transferred = rebaseHelpdeskSla({
    sla: source,
    priority: 'normal',
    now: new Date('2026-02-02T09:30:00Z'),
    currentQueueId: QUEUE_B,
    policyQueueId: QUEUE_B,
    policy: { ...checked.value, version: 8 },
  });
  assert.equal(transferred.policyQueueId, QUEUE_B);
  assert.equal(transferred.policyVersion, 8);
  assert.equal(transferred.firstResponse.activeElapsedMs, 30 * MINUTE);
  assert.equal(transferred.firstResponse.targetMinutes, 120);
  assert.equal(transferred.firstResponse.dueAt.toISOString(), '2026-02-02T11:00:00.000Z');
  assert.equal(transferred.resolution.activeElapsedMs, 30 * MINUTE);
  assert.equal(transferred.resolution.dueAt.toISOString(), '2026-02-02T13:00:00.000Z');
});

test('closing or requester cancellation stops uncompleted clocks without inventing completion', () => {
  const sla = slaFor();
  const stopped = transitionHelpdeskSlaStatus({
    sla,
    fromStatus: 'open',
    toStatus: 'cancelled',
    now: new Date('2026-02-02T09:05:00.000Z'),
    queueId: QUEUE_A,
  });
  assert.equal(stopped.firstResponse.state, 'STOPPED');
  assert.equal(stopped.resolution.state, 'STOPPED');
  assert.equal(stopped.firstResponse.firstResponseAt, null);
  assert.equal(stopped.firstResponse.completedAt, null);
  assert.equal(stopped.nextActionAt, null);
});

test('requester SLA DTO omits operational escalation details while authorized staff DTO can see them', () => {
  const sla = slaFor();
  const withEscalation = {
    ...sla,
    escalation: { state: 'ELIGIBLE', queueId: QUEUE_A, eligibleAt: new Date('2026-02-02T10:00:00Z'), triggers: ['FIRST_RESPONSE'] },
  };
  const requester = serializeHelpdeskSla(withEscalation, { now: new Date('2026-02-02T09:00:00Z') });
  const staff = serializeHelpdeskSla(withEscalation, { includeEscalation: true, now: new Date('2026-02-02T09:00:00Z') });
  assert.equal(Object.hasOwn(requester, 'escalation'), false);
  assert.equal(staff.escalation.state, 'ELIGIBLE');
  assert.equal(staff.firstResponse.state, 'ON_TRACK');
});

// ── model/service persistence and access boundaries ───────────────────────

test('SLA models carry tenant/queue uniqueness and bounded due/message indexes', () => {
  const policyIndex = HelpdeskSlaPolicy.schema.indexes().find(([, options]) => options.name === 'helpdesk_sla_policy_tenant_queue_unique');
  const ticketIndex = HelpdeskTicket.schema.indexes().find(([, options]) => options.name === 'helpdesk_sla_due_reconcile');
  const messageIndex = HelpdeskMessage.schema.indexes().find(([, options]) => options.name === 'helpdesk_first_public_agent_reply');
  assert.deepEqual(policyIndex?.[0], { companyId: 1, queueId: 1 });
  assert.deepEqual(ticketIndex?.[0], { 'sla.nextActionAt': 1, companyId: 1, _id: 1 });
  assert.equal(ticketIndex?.[1]?.partialFilterExpression?.ticketKind, 'HELPDESK');
  assert.deepEqual(messageIndex?.[0], { companyId: 1, ticketId: 1, createdAt: 1, _id: 1 });
  assert.equal(messageIndex?.[1]?.partialFilterExpression?.messageType, 'PUBLIC');
});

test('tenant queue policy read/update is scoped, validated beyond HTTP, versioned, and exposes no updater identity', async () => {
  const rows = modelRows({
    queues: [{ _id: QUEUE_A, companyId: COMPANY_A, enabled: true }],
  });
  const service = serviceFor(rows);
  const payload = validPolicy({ clockMode: 'BUSINESS_HOURS', timeZone: 'Asia/Kolkata' });
  const first = await service.updateQueuePolicy({ companyId: COMPANY_A, queueId: QUEUE_A, actorId: AGENT, input: payload });
  assert.equal(first.configured, true);
  assert.equal(first.policy.version, 1);
  assert.equal(Object.hasOwn(first.policy, 'updatedBy'), false);
  assert.equal(rows.PolicyModel.rows[0].companyId, COMPANY_A);
  assert.equal(rows.PolicyModel.rows[0].queueId, QUEUE_A);

  const second = await service.updateQueuePolicy({ companyId: COMPANY_A, queueId: QUEUE_A, actorId: AGENT, input: { ...payload, warningPercent: 70 } });
  assert.equal(second.policy.version, 2);
  assert.equal(second.policy.warningPercent, 70);
  assert.equal((await service.getQueuePolicy({ companyId: COMPANY_A, queueId: QUEUE_A })).policy.version, 2);
  await assert.rejects(
    service.updateQueuePolicy({ companyId: COMPANY_A, queueId: QUEUE_A, actorId: AGENT, input: { ...payload, companyId: COMPANY_B } }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    service.getQueuePolicy({ companyId: COMPANY_B, queueId: QUEUE_A }),
    (error) => error.statusCode === 404,
  );
});

test('ticket initialization snapshots the actual priority and fails closed when holiday data is unavailable', async () => {
  const checked = validateHelpdeskSlaPolicy(validPolicy({
    clockMode: 'BUSINESS_HOURS',
    timeZone: 'Asia/Kolkata',
    excludeHolidays: true,
  }));
  const rows = modelRows({
    queues: [{ _id: QUEUE_A, companyId: COMPANY_A, enabled: true }],
    policies: [{ companyId: COMPANY_A, queueId: QUEUE_A, ...checked.value, version: 4 }],
    users: [{ _id: REQUESTER, companyId: COMPANY_A, department: oid(77), branch: 'Coimbatore' }],
  });
  let holidayCalls = 0;
  const service = serviceFor(rows, {
    holidayReader: async (companyId, user, range) => {
      holidayCalls += 1;
      assert.equal(companyId, COMPANY_A);
      assert.equal(user._id, REQUESTER);
      assert.equal(user.branch, 'Coimbatore');
      assert.match(range.from, /^\d{4}-\d{2}-\d{2}$/);
      return [];
    },
  });
  const sla = await service.initializeTicketSla({
    companyId: COMPANY_A,
    queueId: QUEUE_A,
    requesterId: REQUESTER,
    priority: 'high',
    createdAt: new Date('2026-02-02T09:00:00Z'),
  });
  assert.equal(holidayCalls, 1);
  assert.equal(sla.policyQueueId, QUEUE_A);
  assert.equal(sla.policyVersion, 4);
  assert.equal(sla.appliedPriority, 'high');

  const failingService = serviceFor(rows, {
    holidayReader: async () => { throw new Error('holiday database unavailable'); },
  });
  await assert.rejects(
    failingService.initializeTicketSla({ companyId: COMPANY_A, queueId: QUEUE_A, requesterId: REQUESTER, priority: 'high', createdAt: new Date('2026-02-02T09:00:00Z') }),
    (error) => error.statusCode === 503,
  );

  let legacyHolidayReads = 0;
  const unconfigured = serviceFor(modelRows(), {
    holidayReader: async () => { legacyHolidayReads += 1; return []; },
  });
  assert.equal(await unconfigured.initializeTicketSla({
    companyId: COMPANY_A,
    queueId: QUEUE_A,
    requesterId: REQUESTER,
    priority: 'normal',
    createdAt: new Date('2020-01-01T00:00:00Z'),
  }), null);
  assert.equal(legacyHolidayReads, 0);
});

test('earliest agent public reply is re-derived from tenant/ticket-scoped Mongo messages and CAS persisted', async () => {
  const sla = slaFor({ startedAt: new Date('2026-02-02T09:00:00Z') });
  const ticket = ticketWithSla(sla);
  const rows = modelRows({
    tickets: [ticket],
    messages: [
      { _id: oid(21), companyId: COMPANY_A, ticketId: TICKET_ID, authorUserId: AGENT, messageType: 'PUBLIC', createdAt: new Date('2026-02-02T09:25:00Z') },
      { _id: oid(22), companyId: COMPANY_A, ticketId: TICKET_ID, authorUserId: REQUESTER, messageType: 'PUBLIC', createdAt: new Date('2026-02-02T09:10:00Z') },
      { _id: oid(23), companyId: COMPANY_A, ticketId: TICKET_ID, authorUserId: AGENT, messageType: 'INTERNAL', createdAt: new Date('2026-02-02T09:05:00Z') },
      { _id: oid(24), companyId: COMPANY_B, ticketId: TICKET_ID, authorUserId: AGENT, messageType: 'PUBLIC', createdAt: new Date('2026-02-02T09:01:00Z') },
    ],
  });
  const service = serviceFor(rows, { now: () => new Date('2026-02-02T09:30:00Z') });
  const result = await service.persistFirstResponse({ companyId: COMPANY_A, ticketId: TICKET_ID, createdAt: new Date('2026-02-02T09:25:00Z') });
  assert.equal(result.updated, true);
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.firstResponseAt.toISOString(), '2026-02-02T09:25:00.000Z');
  assert.equal(rows.TicketModel.rows[0].sla.resolution.state, 'RUNNING');
  const messageQuery = rows.MessageModel.calls.findOne[0];
  assert.equal(messageQuery.companyId, COMPANY_A);
  assert.equal(messageQuery.ticketId, TICKET_ID);
  assert.deepEqual(messageQuery.authorUserId, { $ne: REQUESTER });
  const updateFilter = rows.TicketModel.calls.findOneAndUpdate[0].filter;
  assert.equal(updateFilter.companyId, COMPANY_A);
  assert.equal(updateFilter.ticketKind, 'HELPDESK');
  assert.equal(updateFilter['sla.version'], sla.version);
});

test('concurrent public-reply callbacks converge on Mongo earliest timestamp through version CAS', async () => {
  const sla = slaFor({ startedAt: new Date('2026-02-02T09:00:00Z') });
  const messages = [
    { _id: oid(41), companyId: COMPANY_A, ticketId: TICKET_ID, authorUserId: AGENT, messageType: 'PUBLIC', createdAt: new Date('2026-02-02T09:30:00Z') },
    { _id: oid(42), companyId: COMPANY_A, ticketId: TICKET_ID, authorUserId: AGENT, messageType: 'PUBLIC', createdAt: new Date('2026-02-02T09:20:00Z') },
  ];
  const rows = modelRows({ tickets: [ticketWithSla(sla)], messages });
  const service = serviceFor(rows, { now: () => new Date('2026-02-02T09:40:00Z') });
  const [laterResult, earlierResult] = await Promise.all([
    service.persistFirstResponse({ companyId: COMPANY_A, ticketId: TICKET_ID, createdAt: messages[0].createdAt }),
    service.persistFirstResponse({ companyId: COMPANY_A, ticketId: TICKET_ID, createdAt: messages[1].createdAt }),
  ]);
  assert.equal(laterResult.updated, true);
  assert.equal(earlierResult.updated, true);
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.firstResponseAt.toISOString(), '2026-02-02T09:20:00.000Z');
  assert.equal(rows.TicketModel.rows[0].sla.version, sla.version + 2);
});

test('message-history read failure leaves the response clock untouched for durable recovery', async () => {
  const sla = slaFor({ startedAt: new Date('2026-02-02T09:00:00Z') });
  const rows = modelRows({ tickets: [ticketWithSla(sla)] });
  rows.MessageModel.findOne = () => makeQuery(() => { throw new Error('temporary message-history outage'); });
  const service = serviceFor(rows, { now: () => new Date('2026-02-02T09:30:00Z') });
  const result = await service.persistFirstResponse({
    companyId: COMPANY_A,
    ticketId: TICKET_ID,
    createdAt: new Date('2026-02-02T09:25:00Z'),
  });
  assert.deepEqual(result, { updated: false, recoveryPending: true });
  assert.equal(rows.TicketModel.rows[0].sla.version, sla.version);
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.state, 'RUNNING');
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.firstResponseAt, null);
});

test('reconciliation corrects a completed response projection to the earliest committed qualifying reply', async () => {
  const policy = validPolicy({
    targets: Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
      priority,
      { firstResponseMinutes: 60, resolutionMinutes: 120 },
    ])),
  });
  const ticket = ticketWithSla(slaFor({ policy, startedAt: new Date('2026-02-02T09:00:00Z') }));
  const messages = [
    { _id: oid(31), companyId: COMPANY_A, ticketId: TICKET_ID, authorUserId: AGENT, messageType: 'PUBLIC', createdAt: new Date('2026-02-02T09:30:00Z') },
  ];
  const rows = modelRows({ tickets: [ticket], messages });
  const service = serviceFor(rows, { now: () => new Date('2026-02-02T09:31:00Z') });
  await service.persistFirstResponse({ companyId: COMPANY_A, ticketId: TICKET_ID, createdAt: messages[0].createdAt });
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.firstResponseAt.toISOString(), '2026-02-02T09:30:00.000Z');

  rows.MessageModel.rows.push({
    _id: oid(30),
    companyId: COMPANY_A,
    ticketId: TICKET_ID,
    authorUserId: AGENT,
    messageType: 'PUBLIC',
    createdAt: new Date('2026-02-02T09:20:00Z'),
  });
  const result = await service.reconcileDueTickets({ now: new Date('2026-02-02T10:37:00Z') });
  assert.equal(result.processed, 1);
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.firstResponseAt.toISOString(), '2026-02-02T09:20:00.000Z');
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.completedAt.toISOString(), '2026-02-02T09:20:00.000Z');
});

test('reconciliation persists warnings then breaches/escalation idempotently and is bounded by the due index', async () => {
  const start = new Date('2026-02-02T09:00:00Z');
  const policy = validPolicy({
    targets: Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
      priority,
      { firstResponseMinutes: 60, resolutionMinutes: 120 },
    ])),
  });
  const ticket = ticketWithSla(slaFor({ policy, startedAt: start }));
  const rows = modelRows({ tickets: [ticket] });
  const service = serviceFor(rows);

  const warningAt = new Date('2026-02-02T09:48:00Z');
  const warningResult = await service.reconcileDueTickets({ now: new Date('2026-02-02T09:49:00Z'), limit: 9999 });
  assert.equal(warningResult.processed, 1);
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.warningEligibleAt.toISOString(), warningAt.toISOString());
  assert.equal(rows.TicketModel.calls.find[0].limit, 250);
  assert.equal(rows.TicketModel.calls.find[0].filter.ticketKind, 'HELPDESK');

  const repeated = await service.reconcileDueTickets({ now: new Date('2026-02-02T09:49:00Z') });
  assert.equal(repeated.inspected, 0);

  const breachResult = await service.reconcileDueTickets({ now: new Date('2026-02-02T10:01:00Z') });
  assert.equal(breachResult.processed, 1);
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.breachedAt.toISOString(), '2026-02-02T10:00:00.000Z');
  assert.equal(rows.TicketModel.rows[0].sla.escalation.state, 'ELIGIBLE');
  assert.equal(rows.TicketModel.rows[0].sla.escalation.queueId, QUEUE_A);
  assert.deepEqual(rows.TicketModel.rows[0].sla.escalation.triggers, ['FIRST_RESPONSE']);
  assert.equal((await service.reconcileDueTickets({ now: new Date('2026-02-02T10:05:00Z') })).inspected, 0);

  const scopedRead = rows.TicketModel.calls.findOne.at(-1);
  assert.equal(scopedRead.companyId, COMPANY_A);
  assert.equal(scopedRead.ticketKind, 'HELPDESK');
});

test('a due worker fails closed instead of declaring a first-response breach if reply history cannot be read', async () => {
  const policy = validPolicy({
    targets: Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
      priority,
      { firstResponseMinutes: 10, resolutionMinutes: 60 },
    ])),
  });
  const ticket = ticketWithSla(slaFor({ policy, startedAt: new Date('2026-02-02T09:00:00Z') }));
  const rows = modelRows({ tickets: [ticket] });
  const originalFindOne = rows.MessageModel.findOne;
  rows.MessageModel.findOne = () => makeQuery(() => { throw new Error('Mongo message lookup failed'); });
  const service = serviceFor(rows);
  const result = await service.reconcileDueTickets({ now: new Date('2026-02-02T09:20:00Z') });
  assert.equal(result.failed, 1);
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.breachedAt, null);
  assert.equal(rows.TicketModel.rows[0].sla.escalation.state, 'NONE');

  rows.MessageModel.findOne = originalFindOne;
  const recovered = await service.reconcileDueTickets({ now: new Date('2026-02-02T09:20:00Z') });
  assert.equal(recovered.processed, 1);
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.breachedAt.toISOString(), '2026-02-02T09:10:00.000Z');
  assert.equal(rows.TicketModel.rows[0].sla.escalation.state, 'ELIGIBLE');
});

test('concurrent worker instances use SLA version CAS so only one transition wins', async () => {
  const policy = validPolicy({
    targets: Object.fromEntries(['low', 'normal', 'high', 'urgent'].map((priority) => [
      priority,
      { firstResponseMinutes: 10, resolutionMinutes: 60 },
    ])),
  });
  const rows = modelRows({ tickets: [ticketWithSla(slaFor({ policy, startedAt: new Date('2026-02-02T09:00:00Z') }))] });
  const first = serviceFor(rows);
  const second = serviceFor(rows);
  const [left, right] = await Promise.all([
    first.reconcileDueTickets({ now: new Date('2026-02-02T09:12:00Z') }),
    second.reconcileDueTickets({ now: new Date('2026-02-02T09:12:00Z') }),
  ]);
  assert.equal(left.processed + right.processed, 1);
  assert.equal(rows.TicketModel.rows[0].sla.firstResponse.breachedAt.toISOString(), '2026-02-02T09:10:00.000Z');
  assert.equal(rows.TicketModel.rows[0].sla.escalation.state, 'ELIGIBLE');
});

test('only authorized public staff replies start first-response SLA; requester replies and internal notes do not', async () => {
  let objectIdCounter = 6100;
  class FakeObjectId {
    constructor() { this.hex = oid(objectIdCounter++); }
    toHexString() { return this.hex; }
    toString() { return this.hex; }
  }
  const postMessage = async ({ actorId, messageType, canReadOwn, canReadQueue, canManage }) => {
    const rows = modelRows({
      tickets: [ticketWithSla(slaFor({ startedAt: new Date('2026-02-02T09:00:00Z') }))],
      queues: [{
        _id: QUEUE_A,
        companyId: COMPANY_A,
        agents: [AGENT],
        managers: [],
        confidentiality: { enabled: false, agentIds: [], reviewerIds: [] },
      }],
    });
    const persisted = [];
    const messages = [];
    const MessageModel = {
      async create(input) {
        const message = { ...input, createdAt: new Date('2026-02-02T09:15:00Z') };
        messages.push(message);
        return message;
      },
    };
    const service = helpdeskConversationService({
      ...rows,
      MessageModel,
      ObjectId: FakeObjectId,
      slaService: { persistFirstResponse: async (input) => persisted.push(input) },
      now: () => new Date('2026-02-02T09:15:00Z'),
    });
    const result = await service.createMessage({
      companyId: COMPANY_A,
      actorId,
      actorDisplayName: actorId === REQUESTER ? 'Requester' : 'Agent',
      ticketNumber: 'HD-000301',
      body: 'A test public response',
      messageType,
      canReadOwn,
      canReadQueue,
      canManage,
    });
    return { persisted, messages, result };
  };

  const agentPublic = await postMessage({ actorId: AGENT, messageType: 'public', canReadOwn: false, canReadQueue: true, canManage: true });
  assert.equal(agentPublic.persisted.length, 1);
  assert.equal(agentPublic.persisted[0].companyId, COMPANY_A);
  assert.equal(agentPublic.messages[0].messageType, 'PUBLIC');

  const agentInternal = await postMessage({ actorId: AGENT, messageType: 'internal', canReadOwn: false, canReadQueue: true, canManage: true });
  assert.equal(agentInternal.persisted.length, 0);
  assert.equal(agentInternal.messages[0].messageType, 'INTERNAL');

  const requesterPublic = await postMessage({ actorId: REQUESTER, messageType: 'public', canReadOwn: true, canReadQueue: false, canManage: false });
  assert.equal(requesterPublic.persisted.length, 0);
  assert.equal(requesterPublic.messages[0].messageType, 'PUBLIC');
});

test('authorized APIs register tenant queue policy and ticket SLA reads without trusting client company identity', async () => {
  assert.ok(routeFor('get', '/admin/queues/:queueId/sla-policy').length);
  const policyRoute = routeFor('put', '/admin/queues/:queueId/sla-policy')[0];
  assert.ok(policyRoute);
  assert.ok(policyRoute.route.stack.some((layer) => layer.handle.name === 'checkWriteAccess'));
  assert.ok(routeFor('get', '/tickets/:ticketNumber/sla').length);
  assert.equal(typeof helpdeskController.getQueueSlaPolicy, 'function');
  assert.equal(typeof helpdeskController.updateQueueSlaPolicy, 'function');
  assert.equal(typeof helpdeskController.getTicketSla, 'function');

  const req = { params: { queueId: QUEUE_A }, body: validPolicy() };
  await runValidators(helpdeskSlaPolicyValidator, req);
  const forged = { params: { queueId: QUEUE_A }, body: { ...validPolicy(), companyId: COMPANY_B } };
  await assert.rejects(runValidators(helpdeskSlaPolicyValidator, forged));
});
