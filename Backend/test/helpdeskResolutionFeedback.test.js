// PHASE 38.7 — resolution confirmation, requester reopen, feedback, and auto-close.
// Every service transition runs against deterministic in-memory Mongo-style fakes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  makeFakeHelpdeskFenceModel,
  makeFakeHelpdeskLifecycleEventModel,
  runFakeHelpdeskTransaction,
} from './helpers/helpdeskTransactions.js';

process.env.NODE_ENV ||= 'test';
process.env.REDIS_ENABLED ||= 'false';

const [ticketServiceModule, slaServiceModule, lifecycleRulesModule, ticketModelModule, lifecycleModelModule, configModelModule, validatorModule, autoCloseDispatcherModule] = await Promise.all([
  import('../src/services/helpdesk/helpdeskTicketService.js'),
  import('../src/services/helpdesk/helpdeskSlaService.js'),
  import('../src/services/helpdesk/helpdeskLifecycleRules.js'),
  import('../src/models/HelpdeskTicket.js'),
  import('../src/models/HelpdeskTicketLifecycleEvent.js'),
  import('../src/models/HelpdeskTenantConfig.js'),
  import('../src/validators/helpdeskValidator.js'),
  import('../src/services/helpdesk/helpdeskAutoCloseDispatcher.js'),
]);

const { helpdeskTicketService } = ticketServiceModule;
const { helpdeskSlaService } = slaServiceModule;
const {
  HELPDESK_AUTO_CLOSE_BATCH_MAX,
  HELPDESK_AUTO_CLOSE_DELAY_DEFAULT_HOURS,
  HELPDESK_FEEDBACK_COMMENT_MAX,
  HELPDESK_REOPEN_WINDOW_DEFAULT_HOURS,
  normalizeHelpdeskFeedback,
  normalizeHelpdeskReopenReason,
} = lifecycleRulesModule;
const HelpdeskTicket = ticketModelModule.default;
const HelpdeskTicketLifecycleEvent = lifecycleModelModule.default;
const HelpdeskTenantConfig = configModelModule.default;
const validators = validatorModule;
const routesPath = fileURLToPath(new URL('../src/routes/helpdeskRoutes.js', import.meta.url));
const controllerPath = fileURLToPath(new URL('../src/controllers/helpdeskController.js', import.meta.url));
const servicePath = fileURLToPath(new URL('../src/services/helpdesk/helpdeskTicketService.js', import.meta.url));
const { startHelpdeskAutoCloseDispatcher, HELPDESK_AUTO_CLOSE_RECONCILE_INTERVAL_MS } = autoCloseDispatcherModule;

const COMPANY_A = '000000000000000000000064';
const COMPANY_B = '000000000000000000000065';
const REQUESTER = '000000000000000000000101';
const AGENT = '000000000000000000000201';
const RESTRICTED_AGENT = '000000000000000000000202';
const REVIEWER = '000000000000000000000203';
const MANAGER = '000000000000000000000204';
const OTHER_EMPLOYEE = '000000000000000000000301';
const QUEUE_ID = '000000000000000000000501';
const QUEUE_B_ID = '000000000000000000000502';
const TICKET_ID = '000000000000000000000601';
const TICKET_B_ID = '000000000000000000000602';
const TICKET_NUMBER = 'HD-000601';
const NOW = new Date('2026-05-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const getPath = (source, pathText) => String(pathText).split('.').reduce((value, key) => value?.[key], source);
const setPath = (source, pathText, value) => {
  const pathParts = String(pathText).split('.');
  const last = pathParts.pop();
  let cursor = source;
  for (const part of pathParts) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[last] = clone(value);
};
const sameScalar = (left, right) => {
  if (left instanceof Date || right instanceof Date) {
    const leftTime = left instanceof Date ? left.getTime() : new Date(left).getTime();
    const rightTime = right instanceof Date ? right.getTime() : new Date(right).getTime();
    return leftTime === rightTime;
  }
  return String(left ?? '') === String(right ?? '');
};

const matchesValue = (actual, expected) => {
  if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
  if (!expected || typeof expected !== 'object' || expected instanceof Date || Array.isArray(expected)) {
    return sameScalar(actual, expected);
  }
  if ('$in' in expected && !expected.$in.some((candidate) =>
    candidate === null ? actual === null || actual === undefined : sameScalar(actual, candidate))) return false;
  if ('$exists' in expected && (actual !== undefined) !== expected.$exists) return false;
  if ('$ne' in expected && sameScalar(actual, expected.$ne)) return false;
  if ('$type' in expected && (expected.$type === 'date' ? !(actual instanceof Date) : typeof actual !== expected.$type)) return false;
  if ('$lte' in expected && !((actual instanceof Date ? actual.getTime() : Number(actual)) <= (expected.$lte instanceof Date ? expected.$lte.getTime() : Number(expected.$lte)))) return false;
  if ('$lt' in expected && !((actual instanceof Date ? actual.getTime() : Number(actual)) < (expected.$lt instanceof Date ? expected.$lt.getTime() : Number(expected.$lt)))) return false;
  if ('$eq' in expected && !sameScalar(actual, expected.$eq)) return false;
  return true;
};

const matchesFilter = (row, filter = {}) => Object.entries(filter).every(([key, expected]) => {
  if (key === '$or') return expected.some((part) => matchesFilter(row, part));
  if (key === '$and') return expected.every((part) => matchesFilter(row, part));
  return matchesValue(getPath(row, key), expected);
});

const makeQuery = (resolver) => {
  let sortSpec = null;
  let limitCount = null;
  const chain = {
    select() { return chain; },
    session() { return chain; },
    lean() { return chain; },
    sort(spec) { sortSpec = spec; return chain; },
    limit(amount) { limitCount = amount; return chain; },
    then(onFulfilled, onRejected) {
      return Promise.resolve().then(() => resolver()).then((value) => {
        let result = clone(value);
        if (Array.isArray(result)) {
          if (sortSpec) {
            const entries = Object.entries(sortSpec);
            result.sort((left, right) => {
              for (const [field, direction] of entries) {
                const a = getPath(left, field);
                const b = getPath(right, field);
                if (sameScalar(a, b)) continue;
                return (a > b ? 1 : -1) * direction;
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

const applyUpdate = (row, update) => {
  for (const [field, value] of Object.entries(update.$set || {})) setPath(row, field, value);
  for (const [field, value] of Object.entries(update.$inc || {})) {
    setPath(row, field, Number(getPath(row, field) || 0) + Number(value));
  }
  for (const [field, value] of Object.entries(update.$push || {})) {
    const old = getPath(row, field);
    const append = value?.$each || [value];
    let next = [...(Array.isArray(old) ? old : []), ...clone(append)];
    if (Number.isInteger(value?.$slice)) next = value.$slice < 0 ? next.slice(value.$slice) : next.slice(0, value.$slice);
    setPath(row, field, next);
  }
  for (const field of Object.keys(update.$unset || {})) {
    const pathParts = field.split('.');
    const last = pathParts.pop();
    const parent = pathParts.reduce((value, key) => value?.[key], row);
    if (parent) delete parent[last];
  }
};

const makeTicketModel = (seed = []) => {
  const rows = seed.map(clone);
  const calls = { find: [], findOne: [], findOneAndUpdate: [] };
  const model = {
    rows,
    calls,
    beforeFind: null,
    beforeFindOne: null,
    find(filter) {
      calls.find.push(clone(filter));
      return makeQuery(async () => {
        const snapshot = rows.filter((row) => matchesFilter(row, filter)).map(clone);
        if (model.beforeFind) await model.beforeFind({ filter: clone(filter), snapshot });
        return snapshot;
      });
    },
    findOne(filter) {
      calls.findOne.push(clone(filter));
      return makeQuery(async () => {
        const snapshot = rows.find((row) => matchesFilter(row, filter));
        const result = snapshot ? clone(snapshot) : null;
        if (model.beforeFindOne) await model.beforeFindOne({ filter: clone(filter), snapshot: result });
        return result;
      });
    },
    findOneAndUpdate(filter, update, options = {}) {
      calls.findOneAndUpdate.push({ filter: clone(filter), update: clone(update), options: { ...options } });
      return makeQuery(() => {
        const row = rows.find((candidate) => matchesFilter(candidate, filter));
        if (!row) return null;
        applyUpdate(row, update);
        row.updatedAt = new Date(NOW.getTime() + 1);
        return row;
      });
    },
  };
  return model;
};

const makeQueueModel = () => {
  const rows = [{
    _id: QUEUE_ID,
    companyId: COMPANY_A,
    name: 'People Operations',
    enabled: true,
    agents: [AGENT, RESTRICTED_AGENT],
    managers: [MANAGER],
    confidentiality: { enabled: true, agentIds: [RESTRICTED_AGENT], reviewerIds: [REVIEWER] },
  }, {
    _id: QUEUE_B_ID,
    companyId: COMPANY_B,
    name: 'People Operations B',
    enabled: true,
    agents: [],
    managers: [],
    confidentiality: { enabled: false, agentIds: [], reviewerIds: [] },
  }];
  return {
    rows,
    calls: [],
    findOne(filter) {
      this.calls.push(clone(filter));
      return makeQuery(() => rows.find((row) => matchesFilter(row, filter)) || null);
    },
  };
};

const makeSla = ({ completedAt = new Date(NOW.getTime() - 24 * HOUR), breachedAt = null } = {}) => ({
  version: 4,
  policyQueueId: QUEUE_ID,
  policyVersion: 2,
  appliedPriority: 'normal',
  clockMode: 'CALENDAR',
  timeZone: 'UTC',
  warningPercent: 80,
  pauseStatuses: { firstResponse: [], resolution: [] },
  firstResponse: {
    state: 'COMPLETED', targetMinutes: 60, activeElapsedMs: 30 * 60 * 1000,
    startedAt: new Date(NOW.getTime() - 48 * HOUR), resumedAt: null, pausedAt: null,
    dueAt: null, warningAt: null, warningEligibleAt: null, completedAt,
    lastCompletedAt: completedAt, firstResponseAt: completedAt, breachedAt: null, stoppedAt: null,
  },
  resolution: {
    state: 'COMPLETED', targetMinutes: 480, activeElapsedMs: 6 * HOUR,
    startedAt: new Date(NOW.getTime() - 48 * HOUR), resumedAt: null, pausedAt: null,
    dueAt: null, warningAt: null, warningEligibleAt: null, completedAt,
    lastCompletedAt: completedAt, firstResponseAt: null, breachedAt, stoppedAt: null,
  },
  escalation: { state: 'NONE', queueId: null, eligibleAt: null, triggers: [] },
  nextActionAt: null,
  holidayContext: { department: null, branch: '' },
});

const makeTicket = (overrides = {}) => {
  const resolvedAt = new Date(NOW.getTime() - 24 * HOUR);
  return {
    _id: TICKET_ID,
    companyId: COMPANY_A,
    user: REQUESTER,
    ticketKind: 'HELPDESK',
    ticketNumber: TICKET_NUMBER,
    queueId: QUEUE_ID,
    status: 'resolved',
    isConfidential: true,
    assignedTo: AGENT,
    priority: 'normal',
    resolvedAt,
    resolvedBy: AGENT,
    resolutionCycle: 1,
    reopenUntilAt: new Date(resolvedAt.getTime() + 72 * HOUR),
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    closedAt: null,
    closedBy: null,
    closureReason: null,
    resolutionConfirmedAt: null,
    resolutionConfirmedBy: null,
    autoCloseAt: null,
    lifecycleSequence: 0,
    notificationSequence: 0,
    notificationProcessedSequence: 0,
    notificationEvents: [],
    notificationGap: null,
    sla: makeSla(),
    createdAt: resolvedAt,
    updatedAt: resolvedAt,
    ...clone(overrides),
  };
};

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  allowEmployeeTickets: true,
  confidentialTicketsEnabled: true,
  allowEmployeeReopen: true,
  reopenWindowHours: 72,
  autoCloseEnabled: false,
  autoCloseDelayHours: 72,
});

const makeWorld = ({
  tickets = [makeTicket()],
  config = {},
  configByCompany = {},
  now = () => NOW,
  transactionRunner = runFakeHelpdeskTransaction,
  notificationIntentsEnabled,
} = {}) => {
  const TicketModel = makeTicketModel(tickets);
  const QueueModel = makeQueueModel();
  const FenceModel = makeFakeHelpdeskFenceModel();
  const LifecycleEventModel = makeFakeHelpdeskLifecycleEventModel();
  const tenantConfig = { ...DEFAULT_CONFIG, ...clone(config) };
  const configFor = (companyId) => ({
    ...tenantConfig,
    ...clone(configByCompany[String(companyId)] || {}),
  });
  const configService = {
    calls: [],
    async readConfig({ companyId, session } = {}) {
      this.calls.push({ companyId, sessionId: session?.id || null });
      return clone(configFor(companyId));
    },
    async getConfig({ companyId } = {}) {
      this.calls.push({ companyId, sessionId: null });
      return clone(configFor(companyId));
    },
  };
  const service = helpdeskTicketService({
    TicketModel,
    QueueModel,
    FenceModel,
    LifecycleEventModel,
    configService,
    slaService: helpdeskSlaService({ now }),
    transactionRunner,
    notificationIntentsEnabled,
    now,
  });
  return { TicketModel, QueueModel, FenceModel, LifecycleEventModel, configService, service, tenantConfig };
};

const expectStatus = async (promise, statusCode) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode);
    return true;
  });
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('tenant policy defaults, lifecycle fields, immutable history, and bounded indexes are declared', () => {
  assert.equal(DEFAULT_CONFIG.allowEmployeeReopen, true);
  assert.equal(DEFAULT_CONFIG.reopenWindowHours, HELPDESK_REOPEN_WINDOW_DEFAULT_HOURS);
  assert.equal(DEFAULT_CONFIG.autoCloseEnabled, false);
  assert.equal(DEFAULT_CONFIG.autoCloseDelayHours, HELPDESK_AUTO_CLOSE_DELAY_DEFAULT_HOURS);
  assert.equal(HELPDESK_AUTO_CLOSE_BATCH_MAX, 100);
  assert.equal(HELPDESK_FEEDBACK_COMMENT_MAX, 1000);
  assert.equal(HelpdeskTenantConfig.schema.path('allowEmployeeReopen').defaultValue, true);
  assert.equal(HelpdeskTenantConfig.schema.path('reopenWindowHours').defaultValue, 72);
  assert.equal(HelpdeskTenantConfig.schema.path('autoCloseEnabled').defaultValue, false);
  assert.equal(HelpdeskTenantConfig.schema.path('autoCloseDelayHours').defaultValue, 72);
  for (const field of ['resolvedAt', 'resolutionCycle', 'reopenUntilAt', 'reopenedAt', 'reopenedBy', 'reopenReason', 'closedAt', 'closedBy', 'closureReason', 'resolutionConfirmedAt', 'resolutionConfirmedBy', 'autoCloseAt', 'feedback', 'lifecycleSequence']) {
    assert.ok(HelpdeskTicket.schema.path(field), `ticket schema is missing ${field}`);
  }
  assert.deepEqual(HelpdeskTicketLifecycleEvent.schema.indexes().map(([keys, options]) => ({ keys, unique: options.unique === true })), [
    { keys: { companyId: 1, ticketId: 1, sequence: 1 }, unique: true },
    { keys: { companyId: 1, ticketId: 1, occurredAt: -1, sequence: -1 }, unique: false },
    { keys: { companyId: 1, eventType: 1, occurredAt: -1, ticketId: 1 }, unique: false },
  ]);
  for (const field of ['companyId', 'ticketId', 'sequence', 'eventType', 'actorType', 'actorId', 'occurredAt', 'resolutionCycle']) {
    assert.equal(HelpdeskTicketLifecycleEvent.schema.path(field).options.immutable, true, `${field} must be immutable`);
  }
});

test('normalizers reject invalid rating, blank reopen reasons, unsafe length, and non-string comments', () => {
  for (const rating of [0, 6, 1.5, '5', null]) {
    assert.throws(() => normalizeHelpdeskFeedback({ rating }), (error) => error.statusCode === 400);
  }
  assert.throws(() => normalizeHelpdeskFeedback({ rating: 5, comment: 'x'.repeat(HELPDESK_FEEDBACK_COMMENT_MAX + 1) }), (error) => error.statusCode === 400);
  assert.throws(() => normalizeHelpdeskFeedback({ rating: 5, comment: { text: 'private' } }), (error) => error.statusCode === 400);
  assert.throws(() => normalizeHelpdeskReopenReason('  \u0000  '), (error) => error.statusCode === 400);
  assert.throws(() => normalizeHelpdeskReopenReason('x'.repeat(501)), (error) => error.statusCode === 400);
  assert.deepEqual(normalizeHelpdeskFeedback({ rating: 4, comment: '<b>Helpful</b>\u0000' }), { rating: 4, comment: 'Helpful' });
  assert.equal(normalizeHelpdeskFeedback({ rating: 2 }).comment, null);
  assert.equal(normalizeHelpdeskReopenReason('  <i>Still broken</i>  '), 'Still broken');
});

test('only the authenticated requester can confirm a resolved ticket; retries are idempotent and tenant-fenced', async () => {
  const world = makeWorld();
  const confirmed = await world.service.confirmResolution({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER });
  assert.equal(confirmed.status, 'closed');
  assert.equal(confirmed.idempotent, false);
  assert.equal(world.TicketModel.rows[0].closureReason, 'REQUESTER_CONFIRMED');
  assert.equal(world.TicketModel.rows[0].closedBy, REQUESTER);
  assert.equal(world.TicketModel.rows[0].resolutionConfirmedBy, REQUESTER);
  assert.equal(world.TicketModel.rows[0].autoCloseAt, null);
  assert.equal(world.LifecycleEventModel.rows.length, 1);
  assert.equal(world.LifecycleEventModel.rows[0].eventType, 'REQUESTER_CONFIRMED_RESOLUTION');
  assert.equal(world.LifecycleEventModel.rows[0].actorId, REQUESTER);
  assert.equal(world.LifecycleEventModel.rows[0].actorType, 'USER');
  assert.equal(world.LifecycleEventModel.rows[0].sequence, 1);
  assert.equal(world.TicketModel.rows[0].notificationSequence, 1);
  assert.equal(world.TicketModel.rows[0].notificationEvents[0].type, 'TICKET_RESOLUTION_CONFIRMED');
  assert.equal(world.FenceModel.calls.length, 0, 'requester-owned actions do not require queue membership fences');

  const retry = await world.service.confirmResolution({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.status, 'closed');
  assert.equal(world.LifecycleEventModel.rows.length, 1);
  await expectStatus(world.service.confirmResolution({ companyId: COMPANY_A, requesterId: AGENT, ticketNumber: TICKET_NUMBER }), 404);
  await expectStatus(world.service.confirmResolution({ companyId: COMPANY_B, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER }), 404);
});

test('confirmation rejects unresolved and differently closed tickets without mutating lifecycle history', async () => {
  const open = makeWorld({ tickets: [makeTicket({ status: 'open', resolvedAt: null, reopenUntilAt: null })] });
  await expectStatus(open.service.confirmResolution({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER }), 409);
  assert.equal(open.LifecycleEventModel.rows.length, 0);

  const autoClosed = makeWorld({ tickets: [makeTicket({ status: 'closed', closureReason: 'AUTO_CLOSED' })] });
  await expectStatus(autoClosed.service.confirmResolution({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER }), 409);
  assert.equal(autoClosed.LifecycleEventModel.rows.length, 0);
});

test('staff resolution schedules tenant-configured reopen and auto-close deadlines under the authorization fence', async () => {
  const runningSla = makeSla();
  runningSla.resolution = {
    ...runningSla.resolution,
    state: 'RUNNING',
    resumedAt: new Date(NOW.getTime() - HOUR),
    completedAt: null,
    lastCompletedAt: null,
    dueAt: new Date(NOW.getTime() + 4 * HOUR),
    warningAt: new Date(NOW.getTime() + HOUR),
  };
  const world = makeWorld({
    tickets: [makeTicket({ status: 'in_progress', resolvedAt: null, resolvedBy: null, autoCloseAt: null, closureReason: null, closedBy: null, sla: runningSla, isConfidential: false })],
    config: { reopenWindowHours: 48, autoCloseEnabled: true, autoCloseDelayHours: 24 },
  });
  await world.service.updateStatus({ companyId: COMPANY_A, actorId: AGENT, ticketNumber: TICKET_NUMBER, status: 'resolved' });
  const stored = world.TicketModel.rows[0];
  assert.equal(stored.status, 'resolved');
  assert.equal(stored.resolvedAt.getTime(), NOW.getTime());
  assert.equal(stored.resolvedBy, AGENT);
  assert.equal(stored.resolutionCycle, 2);
  assert.equal(stored.reopenUntilAt.getTime(), NOW.getTime() + 48 * HOUR);
  assert.equal(stored.autoCloseAt.getTime(), NOW.getTime() + 24 * HOUR);
  assert.equal(stored.closedBy, null);
  assert.equal(stored.closureReason, null);
  assert.equal(stored.sla.resolution.completedAt.getTime(), NOW.getTime());
  assert.equal(world.LifecycleEventModel.rows[0].eventType, 'RESOLVED');
  assert.equal(world.LifecycleEventModel.rows[0].actorId, AGENT);
  assert.equal(world.FenceModel.calls.length, 1);
  assert.equal(world.FenceModel.calls[0].hasSession, true);
  assert.equal(world.FenceModel.calls[0].operations[0].filter.userId, AGENT);
});

test('requester reopen is tenant-configurable, window-bound, atomic, and preserves prior resolution/SLA history', async () => {
  const ownership = makeWorld();
  await expectStatus(ownership.service.reopenOwnTicket({ companyId: COMPANY_A, requesterId: AGENT, ticketNumber: TICKET_NUMBER, reason: 'Please reopen' }), 404);
  await expectStatus(ownership.service.reopenOwnTicket({ companyId: COMPANY_B, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, reason: 'Please reopen' }), 404);
  assert.equal(ownership.TicketModel.rows[0].status, 'resolved');

  const breachedAt = new Date(NOW.getTime() - 30 * HOUR);
  const world = makeWorld({ tickets: [makeTicket({ sla: makeSla({ breachedAt }) })] });
  const reopened = await world.service.reopenOwnTicket({
    companyId: COMPANY_A,
    requesterId: REQUESTER,
    ticketNumber: TICKET_NUMBER,
    reason: '  <strong>Still broken</strong>\u0000  ',
  });
  const stored = world.TicketModel.rows[0];
  assert.equal(reopened.status, 'in_progress');
  assert.equal(stored.status, 'in_progress');
  assert.equal(stored.reopenReason, 'Still broken');
  assert.equal(stored.resolutionCycle, 1);
  assert.equal(stored.resolvedAt.getTime(), new Date(NOW.getTime() - 24 * HOUR).getTime());
  assert.equal(stored.reopenUntilAt.getTime(), new Date(NOW.getTime() + 48 * HOUR).getTime());
  assert.equal(stored.reopenedBy, REQUESTER);
  assert.equal(stored.autoCloseAt, null);
  assert.equal(stored.sla.resolution.state, 'RUNNING');
  assert.equal(stored.sla.resolution.completedAt, null);
  assert.equal(stored.sla.resolution.lastCompletedAt.getTime(), new Date(NOW.getTime() - 24 * HOUR).getTime());
  assert.equal(stored.sla.resolution.breachedAt.getTime(), breachedAt.getTime());
  assert.equal(world.LifecycleEventModel.rows[0].eventType, 'REQUESTER_REOPENED');
  assert.equal(world.LifecycleEventModel.rows[0].reason, 'Still broken');
  assert.equal(world.LifecycleEventModel.rows[0].slaSnapshot.before.resolution.completedAt.getTime(), new Date(NOW.getTime() - 24 * HOUR).getTime());
  assert.equal(world.FenceModel.calls.length, 0);

  const disabled = makeWorld({ config: { allowEmployeeReopen: false } });
  await expectStatus(disabled.service.reopenOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, reason: 'Please reopen' }), 403);
  assert.equal(disabled.TicketModel.rows[0].status, 'resolved');
  assert.equal(disabled.LifecycleEventModel.rows.length, 0);

  const expired = makeWorld({ tickets: [makeTicket({ reopenUntilAt: new Date(NOW.getTime() - 1) })] });
  await expectStatus(expired.service.reopenOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, reason: 'Please reopen' }), 409);
  assert.equal(expired.TicketModel.rows[0].status, 'resolved');
  await expectStatus(world.service.reopenOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, reason: 'Please reopen' }), 409);
});

test('feedback is one-per-ticket under concurrency, sanitized, and returned only to requester or authorized confidential staff', async () => {
  const world = makeWorld();
  const first = await world.service.submitFeedback({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, rating: 5, comment: '  <b>Resolved quickly</b>\nthanks  ' });
  assert.deepEqual(first, { rating: 5, comment: 'Resolved quickly\nthanks', submittedAt: NOW });
  assert.equal(Object.hasOwn(first, 'submittedBy'), false);
  assert.equal(world.TicketModel.rows[0].feedback.submittedBy, REQUESTER);
  assert.equal(world.LifecycleEventModel.rows[0].eventType, 'FEEDBACK_SUBMITTED');
  assert.equal(world.TicketModel.rows[0].notificationSequence, 1);
  assert.equal(world.TicketModel.rows[0].notificationEvents[0].type, 'TICKET_FEEDBACK_SUBMITTED');

  const own = await world.service.getFeedback({ companyId: COMPANY_A, viewerId: REQUESTER, ticketNumber: TICKET_NUMBER, canReadOwn: true });
  assert.equal(own.feedback.rating, 5);
  assert.equal(own.feedback.comment, 'Resolved quickly\nthanks');
  assert.equal(Object.hasOwn(own, 'subject'), false);
  await expectStatus(world.service.getFeedback({ companyId: COMPANY_A, viewerId: OTHER_EMPLOYEE, ticketNumber: TICKET_NUMBER, canReadQueue: true }), 404);
  await expectStatus(world.service.getFeedback({ companyId: COMPANY_A, viewerId: AGENT, ticketNumber: TICKET_NUMBER, canReadQueue: true }), 404);
  await expectStatus(world.service.getFeedback({ companyId: COMPANY_A, viewerId: MANAGER, ticketNumber: TICKET_NUMBER, canReadQueue: true }), 404);
  assert.equal((await world.service.getFeedback({ companyId: COMPANY_A, viewerId: RESTRICTED_AGENT, ticketNumber: TICKET_NUMBER, canReadQueue: true })).feedback.rating, 5);
  assert.equal((await world.service.getFeedback({ companyId: COMPANY_A, viewerId: REVIEWER, ticketNumber: TICKET_NUMBER, canReadQueue: true })).feedback.rating, 5);
  await expectStatus(world.service.submitFeedback({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, rating: 4 }), 409);
  await expectStatus(world.service.submitFeedback({ companyId: COMPANY_B, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, rating: 4 }), 404);
  assert.equal(world.LifecycleEventModel.rows.length, 1);

  const wrongOwner = makeWorld();
  await expectStatus(wrongOwner.service.submitFeedback({ companyId: COMPANY_A, requesterId: AGENT, ticketNumber: TICKET_NUMBER, rating: 5 }), 404);
  assert.equal(wrongOwner.TicketModel.rows[0].feedback, undefined);
  assert.equal(wrongOwner.LifecycleEventModel.rows.length, 0);

  const competing = makeWorld();
  const bothRead = deferred();
  const releaseReads = deferred();
  let readCount = 0;
  competing.TicketModel.beforeFindOne = async ({ filter }) => {
    if (filter.ticketNumber !== TICKET_NUMBER || filter.companyId !== COMPANY_A) return;
    readCount += 1;
    if (readCount === 2) bothRead.resolve();
    await releaseReads.promise;
  };
  const left = competing.service.submitFeedback({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, rating: 3, comment: 'Left' });
  const right = competing.service.submitFeedback({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, rating: 4, comment: 'Right' });
  await bothRead.promise;
  releaseReads.resolve();
  const results = await Promise.allSettled([left, right]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.statusCode === 409).length, 1);
  assert.equal(competing.TicketModel.rows[0].feedback.rating === 3 || competing.TicketModel.rows[0].feedback.rating === 4, true);
  assert.equal(competing.LifecycleEventModel.rows.length, 1);
  assert.equal(competing.TicketModel.rows[0].notificationSequence, 1);
});

test('auto-close is opt-in, tenant-configurable, Mongo-revalidated, and idempotent across workers', async () => {
  const dueAt = new Date(NOW.getTime() - 5_000);
  const disabled = makeWorld({ tickets: [makeTicket({ autoCloseAt: dueAt })] });
  const disabledSummary = await disabled.service.reconcileDueAutoClosures({ now: NOW });
  assert.deepEqual(disabledSummary, { inspected: 1, closed: 0, skipped: 1, failed: 0, limit: 100 });
  assert.equal(disabled.TicketModel.rows[0].status, 'resolved');
  assert.equal(disabled.TicketModel.rows[0].autoCloseAt, null);
  assert.equal(disabled.LifecycleEventModel.rows.length, 0);

  const tenantAware = makeWorld({
    tickets: [
      makeTicket({ autoCloseAt: dueAt }),
      makeTicket({
        _id: TICKET_B_ID,
        companyId: COMPANY_B,
        user: OTHER_EMPLOYEE,
        queueId: QUEUE_B_ID,
        ticketNumber: 'HD-000777',
        isConfidential: false,
        assignedTo: null,
        autoCloseAt: dueAt,
      }),
    ],
    configByCompany: { [COMPANY_B]: { autoCloseEnabled: true } },
  });
  const tenantSummary = await tenantAware.service.reconcileDueAutoClosures({ now: NOW });
  assert.equal(tenantSummary.closed, 1);
  assert.equal(tenantAware.TicketModel.rows.find((ticket) => ticket.companyId === COMPANY_A).status, 'resolved');
  assert.equal(tenantAware.TicketModel.rows.find((ticket) => ticket.companyId === COMPANY_A).autoCloseAt, null);
  assert.equal(tenantAware.TicketModel.rows.find((ticket) => ticket.companyId === COMPANY_B).status, 'closed');
  assert.equal(tenantAware.LifecycleEventModel.rows[0].companyId, COMPANY_B);

  const unresolved = makeWorld({ tickets: [makeTicket({ status: 'in_progress', autoCloseAt: dueAt })], config: { autoCloseEnabled: true } });
  const unresolvedSummary = await unresolved.service.reconcileDueAutoClosures({ now: NOW });
  assert.equal(unresolvedSummary.inspected, 0);
  assert.equal(unresolved.TicketModel.rows[0].status, 'in_progress');

  const enabled = makeWorld({ tickets: [makeTicket({ autoCloseAt: dueAt })], config: { autoCloseEnabled: true } });
  const [firstWorker, secondWorker] = await Promise.all([
    enabled.service.reconcileDueAutoClosures({ now: NOW }),
    enabled.service.reconcileDueAutoClosures({ now: NOW }),
  ]);
  assert.equal(firstWorker.closed + secondWorker.closed, 1);
  assert.equal(enabled.TicketModel.rows[0].status, 'closed');
  assert.equal(enabled.TicketModel.rows[0].closureReason, 'AUTO_CLOSED');
  assert.equal(enabled.TicketModel.rows[0].closedBy, null);
  assert.equal(enabled.TicketModel.rows[0].autoCloseAt, null);
  assert.equal(enabled.TicketModel.rows[0].sla.resolution.state, 'COMPLETED');
  assert.equal(enabled.TicketModel.rows[0].sla.resolution.completedAt.getTime(), new Date(NOW.getTime() - 24 * HOUR).getTime());
  assert.equal(enabled.LifecycleEventModel.rows.filter((event) => event.eventType === 'AUTO_CLOSED').length, 1);
  assert.equal(enabled.TicketModel.rows[0].notificationEvents.filter((event) => event.type === 'TICKET_AUTO_CLOSED').length, 1);
});

test('auto-close rejects stale worker candidates after requester reopen without a sleep-based race', async () => {
  const dueAt = new Date(NOW.getTime() - 10_000);
  const world = makeWorld({ tickets: [makeTicket({ autoCloseAt: dueAt })], config: { autoCloseEnabled: true } });
  const candidateCaptured = deferred();
  const releaseCandidateRead = deferred();
  world.TicketModel.beforeFind = async ({ filter, snapshot }) => {
    if (filter.status === 'resolved' && filter.autoCloseAt) {
      candidateCaptured.resolve(clone(snapshot));
      await releaseCandidateRead.promise;
    }
  };
  const autoCloseRun = world.service.reconcileDueAutoClosures({ now: NOW });
  const candidates = await candidateCaptured.promise;
  assert.equal(candidates.length, 1);
  await world.service.reopenOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: TICKET_NUMBER, reason: 'Not fixed yet' });
  releaseCandidateRead.resolve();
  const summary = await autoCloseRun;
  assert.equal(summary.closed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(world.TicketModel.rows[0].status, 'in_progress');
  assert.equal(world.TicketModel.rows[0].autoCloseAt, null);
  assert.deepEqual(world.LifecycleEventModel.rows.map((event) => event.eventType), ['REQUESTER_REOPENED']);
});

test('a fresh worker recovers a due close after a prior worker transaction failure', async () => {
  let workerUnavailable = true;
  const transactionRunner = async (work) => {
    if (workerUnavailable) throw new Error('simulated worker exit before commit');
    return work({ id: 'restarted-worker-session' });
  };
  const world = makeWorld({
    tickets: [makeTicket({ autoCloseAt: new Date(NOW.getTime() - 1) })],
    config: { autoCloseEnabled: true },
    transactionRunner,
  });
  const failed = await world.service.reconcileDueAutoClosures({ now: NOW });
  assert.equal(failed.failed, 1);
  assert.equal(world.TicketModel.rows[0].status, 'resolved');
  assert.equal(world.LifecycleEventModel.rows.length, 0);

  workerUnavailable = false;
  const restarted = await world.service.reconcileDueAutoClosures({ now: NOW });
  assert.equal(restarted.closed, 1);
  assert.equal(world.TicketModel.rows[0].status, 'closed');
  assert.equal(world.LifecycleEventModel.rows.length, 1);
});

test('auto-close dispatcher starts bounded recovery immediately and stops scheduled retries cleanly', async () => {
  const started = deferred();
  const finish = deferred();
  const infoLogged = deferred();
  let tick;
  let cleared = false;
  let unrefed = false;
  let calls = 0;
  const logs = [];
  const stop = startHelpdeskAutoCloseDispatcher({
    service: {
      async reconcileDueAutoClosures({ limit }) {
        calls += 1;
        assert.equal(limit, 100);
        started.resolve();
        return finish.promise;
      },
    },
    log: {
      info(message) { logs.push(message); infoLogged.resolve(); },
      warn(message) { logs.push(message); },
    },
    setIntervalFn(callback, interval) {
      assert.equal(interval, HELPDESK_AUTO_CLOSE_RECONCILE_INTERVAL_MS);
      tick = callback;
      return { unref() { unrefed = true; } };
    },
    clearIntervalFn() { cleared = true; },
  });
  await started.promise;
  assert.equal(unrefed, true);
  tick();
  assert.equal(calls, 1, 'overlapping sweeps are suppressed');
  stop();
  tick();
  assert.equal(cleared, true);
  finish.resolve({ inspected: 1, closed: 1, skipped: 0, failed: 0 });
  await infoLogged.promise;
  await Promise.resolve();
  assert.equal(calls, 1, 'a stopped dispatcher does not restart its timer callback');
  assert.match(logs[0], /closed=1/);
});

test('requester routes validate bounded feedback/reopen payloads and derive actor/tenant from middleware', async () => {
  const runValidation = async (chains, req) => {
    for (const chain of chains) {
      if (typeof chain.run === 'function') {
        await chain.run(req);
      } else {
        await new Promise((resolve, reject) => {
          try {
            chain(req, {}, (error) => error ? reject(error) : resolve());
          } catch (error) {
            reject(error);
          }
        });
      }
    }
  };
  const baseReq = { params: { ticketNumber: TICKET_NUMBER }, query: {}, body: {}, headers: {} };
  await runValidation(validators.helpdeskTicketConfirmResolutionValidator, clone(baseReq));
  await runValidation(validators.helpdeskTicketReopenValidator, { ...clone(baseReq), body: { reason: 'Still broken' } });
  await runValidation(validators.helpdeskTicketFeedbackValidator, { ...clone(baseReq), body: { rating: '5', comment: 'Good support' } });
  const validPolicyReq = { ...clone(baseReq), body: { allowEmployeeReopen: true, reopenWindowHours: '72', autoCloseEnabled: true, autoCloseDelayHours: '24' } };
  await runValidation(validators.helpdeskConfigUpdateValidator, validPolicyReq);
  assert.equal(validPolicyReq.body.reopenWindowHours, 72);
  assert.equal(validPolicyReq.body.autoCloseDelayHours, 24);
  await assert.rejects(runValidation(validators.helpdeskConfigUpdateValidator, { ...clone(baseReq), body: { reopenWindowHours: '0' } }), (error) => error.statusCode === 400);
  await assert.rejects(runValidation(validators.helpdeskConfigUpdateValidator, { ...clone(baseReq), body: { autoCloseEnabled: 'maybe' } }), (error) => error.statusCode === 400);
  await assert.rejects(runValidation(validators.helpdeskTicketReopenValidator, { ...clone(baseReq), body: { reason: 'x'.repeat(501) } }), (error) => error.statusCode === 400);
  await assert.rejects(runValidation(validators.helpdeskTicketFeedbackValidator, { ...clone(baseReq), body: { rating: '6' } }), (error) => error.statusCode === 400);
  await assert.rejects(runValidation(validators.helpdeskTicketFeedbackValidator, { ...clone(baseReq), body: { rating: '5', companyId: COMPANY_B } }), (error) => error.statusCode === 400);

  const routes = fs.readFileSync(routesPath, 'utf8');
  const controller = fs.readFileSync(controllerPath, 'utf8');
  const service = fs.readFileSync(servicePath, 'utf8');
  assert.match(routes, /\/tickets\/mine\/:ticketNumber\/confirm-resolution/);
  assert.match(routes, /\/tickets\/mine\/:ticketNumber\/reopen/);
  assert.match(routes, /\/tickets\/mine\/:ticketNumber\/feedback/);
  assert.match(routes, /requirePermission\(['"]HELPDESK_TICKET_READ_SELF['"]\)/);
  assert.match(controller, /const companyId = req\.companyId;/);
  assert.match(controller, /const requesterId = req\.user\._id;/);
  assert.match(controller, /ticketService\.confirmResolution\(\{ companyId, requesterId, ticketNumber \}\)/);
  assert.match(controller, /ticketService\.reopenOwnTicket\(\{\s*companyId,\s*requesterId,\s*ticketNumber,\s*reason:\s*input\.reason,\s*\}\)/);
  assert.match(controller, /ticketService\.submitFeedback\(\{\s*companyId,\s*requesterId,\s*ticketNumber,\s*rating:\s*input\.rating,\s*comment:\s*input\.comment,\s*\}\)/);
  assert.doesNotMatch(service, /requesterId\s*:\s*input\./);
});
