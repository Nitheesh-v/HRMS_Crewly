import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  makeFakeHelpdeskFenceModel,
  makeHelpdeskFenceRaceHarness,
  runFakeHelpdeskTransaction,
} from './helpers/helpdeskTransactions.js';

process.env.NODE_ENV ||= 'test';
process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_helpdesk_agents_test';

const [
  rulesModule,
  ticketServiceModule,
  queueServiceModule,
  ticketModelModule,
  routeModule,
  controllerModule,
  validatorModule,
  auditMiddlewareModule,
  auditModelModule,
  kindModule,
] = await Promise.all([
  import('../src/services/helpdesk/helpdeskRules.js'),
  import('../src/services/helpdesk/helpdeskTicketService.js'),
  import('../src/services/helpdesk/helpdeskQueueService.js'),
  import('../src/models/HelpdeskTicket.js'),
  import('../src/routes/helpdeskRoutes.js'),
  import('../src/controllers/helpdeskController.js'),
  import('../src/validators/helpdeskValidator.js'),
  import('../src/middlewares/auditTrail.js'),
  import('../src/models/AuditLog.js'),
  import('../src/utils/supportTicketKinds.js'),
]);

const {
  HELPDESK_QUEUE_TICKET_LIST_QUERY_FIELDS,
  normalizeHelpdeskQueueTicketListQuery,
  validateHelpdeskTransferInput,
} = rulesModule;
const { helpdeskTicketService } = ticketServiceModule;
const { helpdeskQueueService } = queueServiceModule;
const HelpdeskTicket = ticketModelModule.default;
const helpdeskRouter = routeModule.default;
const helpdeskController = controllerModule;
const {
  helpdeskQueueTicketListQueryValidator,
  helpdeskTicketAssignmentValidator,
  helpdeskTicketClaimValidator,
  helpdeskTicketPriorityValidator,
  helpdeskTicketStatusValidator,
  helpdeskTicketTransferValidator,
} = validatorModule;
const { auditTrail } = auditMiddlewareModule;
const AuditLog = auditModelModule.default;
const { SUPPORT_TICKET_KIND } = kindModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (relative) => fs.readFileSync(path.join(backendRoot, relative), 'utf8');

const oid = (number) => Number(number).toString(16).padStart(24, '0');
const COMPANY_A = oid(100);
const COMPANY_B = oid(200);
const REQUESTER = oid(1);
const AGENT = oid(2);
const AGENT_TWO = oid(3);
const RESTRICTED_AGENT = oid(4);
const QUEUE_MANAGER = oid(5);
const MANAGER_AGENT = oid(6);
const REVIEWER = oid(7);
const ORG_MANAGER = oid(8);
const DESTINATION_AGENT = oid(9);
const INACTIVE_AGENT = oid(10);
const OTHER_TENANT_USER = oid(201);
const QUEUE_A = oid(900);
const QUEUE_B = oid(901);
const FOREIGN_QUEUE = oid(902);
const QUEUE_C = oid(903);
const CATEGORY_A = oid(910);
const CATEGORY_B = oid(911);
const FOREIGN_CATEGORY = oid(912);
const CATEGORY_C = oid(913);

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const idOf = (value) =>
  value && typeof value === 'object' && value._id !== undefined
    ? idOf(value._id)
    : String(value ?? '');
const getPath = (value, dottedPath) =>
  String(dottedPath).split('.').reduce(
    (current, part) => current == null ? undefined : current[part],
    value,
  );

const matchesValue = (actual, expected) => {
  if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    if (Object.hasOwn(expected, '$in')) {
      return expected.$in.some((candidate) => matchesValue(actual, candidate));
    }
    if (Object.hasOwn(expected, '$ne')) return !matchesValue(actual, expected.$ne);
    if (Object.hasOwn(expected, '$exists')) return expected.$exists ? actual !== undefined : actual === undefined;
    if (Object.hasOwn(expected, '$type')) return expected.$type === 'string' ? typeof actual === 'string' : true;
    return true;
  }
  if (expected === null) return actual === null || actual === undefined;
  return idOf(actual) === idOf(expected);
};

const matches = (row, filter = {}) => Object.entries(filter).every(([key, expected]) => {
  if (key === '$and') return expected.every((part) => matches(row, part));
  if (key === '$or') return expected.some((part) => matches(row, part));
  return matchesValue(getPath(row, key), expected);
});

const project = (value, fields) => {
  if (!fields) return value;
  const selected = String(fields).split(/\s+/).filter((field) => field && !field.startsWith('-'));
  const projectOne = (row) => {
    if (!row) return row;
    const result = {};
    if (row._id !== undefined) result._id = row._id;
    for (const field of selected) {
      const fieldValue = getPath(row, field);
      if (fieldValue !== undefined) result[field] = fieldValue;
    }
    return result;
  };
  return Array.isArray(value) ? value.map(projectOne) : projectOne(value);
};

const makeQuery = (resolver) => {
  let projection = null;
  let sortSpec = null;
  let skipCount = 0;
  let limitCount = null;
  const chain = {
    select(fields) { projection = fields; return chain; },
    sort(spec) { sortSpec = spec; return chain; },
    skip(amount) { skipCount = amount; return chain; },
    limit(amount) { limitCount = amount; return chain; },
    lean() { return chain; },
    then(onFulfilled, onRejected) {
      return Promise.resolve()
        .then(() => resolver({ projection, sortSpec, skipCount, limitCount }))
        .then((value) => {
          let result = value;
          if (Array.isArray(result)) {
            result = [...result];
            if (sortSpec) {
              result.sort((left, right) => {
                for (const [field, direction] of Object.entries(sortSpec)) {
                  const a = getPath(left, field);
                  const b = getPath(right, field);
                  if (a === b) continue;
                  const leftValue = a instanceof Date ? a.getTime() : a;
                  const rightValue = b instanceof Date ? b.getTime() : b;
                  return (leftValue > rightValue ? 1 : -1) * direction;
                }
                return 0;
              });
            }
            result = result.slice(skipCount);
            if (Number.isInteger(limitCount)) result = result.slice(0, limitCount);
          }
          result = project(result, projection);
          // Mongoose query results are detached documents, not live references to the test store.
          return clone(result);
        })
        .then(onFulfilled, onRejected);
    },
  };
  return chain;
};

const makeQueue = (queueId, { companyId = COMPANY_A, ...overrides } = {}) => ({
  _id: queueId,
  companyId,
  name: queueId === QUEUE_A ? 'People Operations' : queueId === QUEUE_B ? 'IT Operations' : 'Security Operations',
  enabled: true,
  categories: [
    {
      _id: queueId === QUEUE_A ? CATEGORY_A : queueId === QUEUE_B ? CATEGORY_B : CATEGORY_C,
      name: queueId === QUEUE_A ? 'Account access' : queueId === QUEUE_B ? 'Device access' : 'Security access',
      enabled: true,
    },
  ],
  agents: [AGENT, AGENT_TWO, RESTRICTED_AGENT, MANAGER_AGENT, DESTINATION_AGENT],
  managers: [QUEUE_MANAGER, MANAGER_AGENT],
  confidentiality: {
    enabled: true,
    agentIds: [RESTRICTED_AGENT, MANAGER_AGENT],
    reviewerIds: [REVIEWER],
  },
  ...clone(overrides),
});

const makeTicket = (number, overrides = {}) => ({
  _id: oid(3000 + number),
  companyId: COMPANY_A,
  ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
  user: REQUESTER,
  ticketNumber: `HD-${String(number).padStart(6, '0')}`,
  queueId: QUEUE_A,
  categoryId: CATEGORY_A,
  categoryName: 'Account access',
  subject: `Request ${number}`,
  message: `Private description ${number}`,
  status: 'open',
  priority: 'normal',
  requestedPriority: null,
  assignedTo: null,
  isConfidential: false,
  createdAt: new Date(`2026-01-${String(number).padStart(2, '0')}T09:00:00.000Z`),
  updatedAt: new Date(`2026-01-${String(number).padStart(2, '0')}T10:00:00.000Z`),
  ...clone(overrides),
});

const makeTicketModel = (seed = []) => {
  const rows = seed.map(clone);
  const calls = { find: [], findOne: [], findOneAndUpdate: [], countDocuments: [] };
  let updatedAt = new Date('2026-02-01T00:00:00.000Z');
  return {
    rows,
    calls,
    find(filter) {
      const call = { filter: clone(filter), projection: null, sort: null, skip: 0, limit: null };
      calls.find.push(call);
      return makeQuery((options) => {
        Object.assign(call, {
          projection: options.projection,
          sort: options.sortSpec,
          skip: options.skipCount,
          limit: options.limitCount,
        });
        return rows.filter((row) => matches(row, filter));
      });
    },
    findOne(filter) {
      const call = { filter: clone(filter), projection: null };
      calls.findOne.push(call);
      return makeQuery((options) => {
        call.projection = options.projection;
        return rows.find((row) => matches(row, filter)) || null;
      });
    },
    findOneAndUpdate(filter, update, options = {}) {
      const { session, ...recordedOptions } = options;
      calls.findOneAndUpdate.push({
        filter: clone(filter),
        update: clone(update),
        options: clone(recordedOptions),
        hasSession: Boolean(session),
      });
      return makeQuery(() => {
        const row = rows.find((candidate) => matches(candidate, filter));
        if (!row) return null;
        Object.assign(row, clone(update.$set || {}));
        updatedAt = new Date(updatedAt.getTime() + 1000);
        row.updatedAt = updatedAt;
        return clone(row);
      });
    },
    async countDocuments(filter) {
      calls.countDocuments.push(clone(filter));
      return rows.filter((row) => matches(row, filter)).length;
    },
  };
};

const makeQueueModel = (seed = [makeQueue(QUEUE_A), makeQueue(QUEUE_B)]) => {
  const rows = seed.map(clone);
  const calls = { find: [], findOne: [] };
  return {
    rows,
    calls,
    find(filter) {
      calls.find.push(clone(filter));
      return makeQuery(() => rows.filter((row) => matches(row, filter)));
    },
    findOne(filter) {
      calls.findOne.push(clone(filter));
      return makeQuery(() => rows.find((row) => matches(row, filter)) || null);
    },
  };
};

const makeUserModel = () => {
  const rows = [
    { _id: REQUESTER, companyId: COMPANY_A, status: 'ACTIVE', name: 'Requester', department: oid(77) },
    { _id: AGENT, companyId: COMPANY_A, status: 'ACTIVE', name: 'Agent', department: oid(77) },
    { _id: AGENT_TWO, companyId: COMPANY_A, status: 'ACTIVE', name: 'Agent Two' },
    { _id: RESTRICTED_AGENT, companyId: COMPANY_A, status: 'ACTIVE', name: 'Restricted Agent' },
    { _id: QUEUE_MANAGER, companyId: COMPANY_A, status: 'ACTIVE', name: 'Queue Manager' },
    { _id: MANAGER_AGENT, companyId: COMPANY_A, status: 'ACTIVE', name: 'Manager Agent' },
    { _id: REVIEWER, companyId: COMPANY_A, status: 'ACTIVE', name: 'Reviewer' },
    { _id: ORG_MANAGER, companyId: COMPANY_A, status: 'ACTIVE', role: 'MANAGER', name: 'Reporting Manager', department: oid(77), reportingTo: REQUESTER },
    { _id: DESTINATION_AGENT, companyId: COMPANY_A, status: 'ACTIVE', name: 'Destination Agent' },
    { _id: INACTIVE_AGENT, companyId: COMPANY_A, status: 'INACTIVE', name: 'Inactive Agent' },
    { _id: OTHER_TENANT_USER, companyId: COMPANY_B, status: 'ACTIVE', name: 'Foreign Agent' },
  ];
  const calls = { findOne: [] };
  return {
    rows,
    calls,
    find(filter) {
      return makeQuery(() => rows.filter((row) => matches(row, filter)));
    },
    findOne(filter) {
      calls.findOne.push(clone(filter));
      return makeQuery(() => rows.find((row) => matches(row, filter)) || null);
    },
  };
};

const NOOP_SLA_SERVICE = {
  async initializeTicketSla() { return null; },
  async applyStatusTransition() { return null; },
  async applyPriorityChange() { return null; },
  async applyQueueTransfer() { return null; },
  async persistFirstResponse() { return { updated: false }; },
};

const makeWorld = ({ tickets = [], queues, config = {}, transactionRunner = runFakeHelpdeskTransaction, FenceModel: suppliedFenceModel } = {}) => {
  const TicketModel = makeTicketModel(tickets);
  const QueueModel = makeQueueModel(queues);
  const UserModel = makeUserModel();
  const FenceModel = suppliedFenceModel || makeFakeHelpdeskFenceModel();
  const configService = {
    calls: [],
    async getConfig({ companyId }) {
      this.calls.push(companyId);
      return { confidentialTicketsEnabled: true, ...clone(config) };
    },
  };
  const queueService = helpdeskQueueService({ QueueModel, UserModel, FenceModel, transactionRunner });
  const ticketService = helpdeskTicketService({
    TicketModel,
    QueueModel,
    UserModel,
    FenceModel,
    transactionRunner,
    configService,
    slaService: NOOP_SLA_SERVICE,
  });
  return { TicketModel, QueueModel, UserModel, FenceModel, configService, queueService, ticketService };
};

const attachQueueSaveSupport = (QueueModel) => {
  const findOne = QueueModel.findOne.bind(QueueModel);
  QueueModel.findOne = (filter) => {
    const query = findOne(filter);
    const then = query.then.bind(query);
    query.then = (onFulfilled, onRejected) => then((row) => {
      if (!row) return onFulfilled ? onFulfilled(null) : null;
      const document = clone(row);
      document.save = async () => {
        const stored = QueueModel.rows.find((candidate) => idOf(candidate._id) === idOf(document._id));
        for (const [key, value] of Object.entries(document)) {
          if (key !== 'save' && stored) stored[key] = clone(value);
        }
        return document;
      };
      return onFulfilled ? onFulfilled(document) : document;
    }, onRejected);
    return query;
  };
};

const expectStatus = async (promise, statusCode) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode);
    return true;
  });
};

const runValidation = async (validators, req) => {
  for (const middleware of validators) {
    if (typeof middleware.run === 'function') {
      await middleware.run(req);
    } else {
      await new Promise((resolve, reject) => {
        try {
          middleware(req, {}, (error) => error ? reject(error) : resolve());
        } catch (error) {
          reject(error);
        }
      });
    }
  }
};

const routeLayers = () => helpdeskRouter.stack.filter((layer) => layer.route);
const getRoute = (path, method) => routeLayers().find(
  (layer) => layer.route.path === path && layer.route.methods[method],
);

// Queue reads are bounded, tenant/discriminator scoped, confidentiality-filtered,
// description-free, and do not return hidden-record totals.
test('agent queue listing supports bounded page/search filters and minimizes rows', async () => {
  const tickets = [
    makeTicket(1, { subject: 'VPN access: first request' }),
    makeTicket(2, { subject: 'VPN access: second request' }),
    makeTicket(3, { subject: 'VPN confidential request', isConfidential: true }),
    makeTicket(4, { subject: 'Assigned request', assignedTo: AGENT }),
    makeTicket(5, { subject: 'Unassigned request' }),
    makeTicket(6, { subject: 'Other queue', queueId: QUEUE_B, categoryId: CATEGORY_B }),
    makeTicket(7, { companyId: COMPANY_B, subject: 'Foreign tenant request' }),
    makeTicket(8, { ticketKind: SUPPORT_TICKET_KIND.LEGACY, subject: 'Legacy support request' }),
  ];
  const world = makeWorld({ tickets });
  const pageOne = await world.ticketService.listQueueTickets({
    companyId: COMPANY_A,
    viewerId: AGENT,
    queueId: QUEUE_A,
    query: { search: 'VPN access', page: '1', limit: '1', sort: 'oldest' },
    canReadQueue: true,
  });
  assert.deepEqual(pageOne.tickets.map((ticket) => ticket.ticketNumber), ['HD-000001']);
  assert.deepEqual(pageOne.meta, { page: 1, limit: 1, hasMore: true });
  assert.equal(Object.hasOwn(pageOne.meta, 'total'), false);
  assert.equal(Object.hasOwn(pageOne.tickets[0], 'description'), false);
  assert.equal(Object.hasOwn(pageOne.tickets[0], 'requesterId'), false);
  assert.equal(Object.hasOwn(pageOne.tickets[0], 'message'), false);
  assert.deepEqual(pageOne.tickets[0].queue, { id: QUEUE_A, name: 'People Operations' });

  const pageTwo = await world.ticketService.listQueueTickets({
    companyId: COMPANY_A,
    viewerId: AGENT,
    queueId: QUEUE_A,
    query: { search: 'VPN access', page: '2', limit: '1', sort: 'oldest' },
    canReadQueue: true,
  });
  assert.deepEqual(pageTwo.tickets.map((ticket) => ticket.ticketNumber), ['HD-000002']);
  assert.equal(pageTwo.meta.hasMore, false);

  const call = world.TicketModel.calls.find[0];
  assert.equal(call.filter.companyId, COMPANY_A);
  assert.equal(call.filter.ticketKind, SUPPORT_TICKET_KIND.HELPDESK);
  assert.equal(call.filter.queueId, QUEUE_A);
  assert.ok(Array.isArray(call.filter.$and));
  assert.match(call.projection, /ticketNumber subject queueId categoryId categoryName status priority assignedTo/);
  assert.doesNotMatch(call.projection, /message|user|companyId|replies|platformNote/);
  assert.deepEqual(call.sort, { createdAt: 1, _id: 1 });
  assert.equal(call.skip, 0);
  assert.equal(call.limit, 2);
});

test('assigned-to-me and unassigned views use authenticated actor and never trust query identities', async () => {
  const world = makeWorld({ tickets: [
    makeTicket(1, { assignedTo: AGENT, status: 'assigned' }),
    makeTicket(2, { assignedTo: AGENT_TWO, status: 'assigned' }),
    makeTicket(3, { assignedTo: null, status: 'open' }),
    makeTicket(4, { assignedTo: AGENT, isConfidential: true, status: 'assigned' }),
  ] });

  const assigned = await world.ticketService.listAssignedToMe({
    companyId: COMPANY_A,
    viewerId: AGENT,
    queueId: QUEUE_A,
    query: { status: 'assigned' },
    canReadQueue: true,
  });
  assert.deepEqual(assigned.tickets.map((ticket) => ticket.ticketNumber), ['HD-000001']);
  assert.equal(world.TicketModel.calls.find[0].filter.assignedTo, AGENT);
  assert.equal(world.TicketModel.calls.find[0].filter.status, 'assigned');

  const unassigned = await world.ticketService.listUnassignedTickets({
    companyId: COMPANY_A,
    viewerId: AGENT,
    queueId: QUEUE_A,
    canReadQueue: true,
  });
  assert.deepEqual(unassigned.tickets.map((ticket) => ticket.ticketNumber), ['HD-000003']);
  assert.equal(world.TicketModel.calls.find[1].filter.assignedTo, null);
  assert.equal(world.TicketModel.calls.find[1].filter.companyId, COMPANY_A);

  for (const query of [
    { assignedTo: AGENT_TWO },
    { userId: REQUESTER },
    { companyId: COMPANY_B },
    { queueId: QUEUE_B },
    { actorId: AGENT_TWO },
    { page: '0' },
    { page: '10001' },
    { limit: '101' },
    { search: 'x'.repeat(61) },
    { search: ['one', 'two'] },
  ]) {
    const before = world.TicketModel.calls.find.length;
    await expectStatus(world.ticketService.listQueueTickets({
      companyId: COMPANY_A,
      viewerId: AGENT,
      queueId: QUEUE_A,
      query,
      canReadQueue: true,
    }), 400);
    assert.equal(world.TicketModel.calls.find.length, before);
  }

  assert.deepEqual(HELPDESK_QUEUE_TICKET_LIST_QUERY_FIELDS, [
    'status', 'priority', 'search', 'sort', 'page', 'limit',
  ]);
  assert.deepEqual(normalizeHelpdeskQueueTicketListQuery({}), {
    status: undefined,
    priority: undefined,
    search: '',
    sort: 'newest',
    page: 1,
    limit: 20,
  });
});

test('literal search does not treat regex metacharacters as executable patterns', async () => {
  const world = makeWorld({ tickets: [
    makeTicket(1, { subject: 'All access' }),
    makeTicket(2, { subject: '.*' }),
  ] });
  const literal = await world.ticketService.listQueueTickets({
    companyId: COMPANY_A,
    viewerId: AGENT,
    queueId: QUEUE_A,
    query: { search: '.*' },
    canReadQueue: true,
  });
  assert.deepEqual(literal.tickets.map((ticket) => ticket.ticketNumber), ['HD-000002']);
});

test('confidentiality remains narrower than queue management, org hierarchy, and generic read permission', async () => {
  const ticket = makeTicket(1, { subject: 'Confidential request', isConfidential: true });
  const ordinaryTicket = makeTicket(2, { subject: 'Ordinary request' });
  const world = makeWorld({ tickets: [ticket, ordinaryTicket] });

  await expectStatus(world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: AGENT,
    ticketNumber: ticket.ticketNumber,
    canReadQueue: true,
  }), 404);
  await expectStatus(world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: QUEUE_MANAGER,
    ticketNumber: ticket.ticketNumber,
    canReadQueue: true,
  }), 404);
  await expectStatus(world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: ORG_MANAGER,
    ticketNumber: ticket.ticketNumber,
    canReadQueue: true,
  }), 404);
  await expectStatus(world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: ORG_MANAGER,
    ticketNumber: ordinaryTicket.ticketNumber,
    canReadQueue: true,
  }), 404);
  await expectStatus(world.ticketService.listQueueTickets({
    companyId: COMPANY_A,
    viewerId: ORG_MANAGER,
    queueId: QUEUE_A,
    canReadQueue: true,
  }), 404);

  const reviewer = await world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: REVIEWER,
    ticketNumber: ticket.ticketNumber,
    canReadQueue: true,
  });
  assert.equal(reviewer.description, ticket.message);
  await expectStatus(world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: REVIEWER,
    ticketNumber: ticket.ticketNumber,
    status: 'in_progress',
  }), 404);
  await expectStatus(world.ticketService.claimTicket({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: ticket.ticketNumber,
  }), 404);

  const reviewerList = await world.ticketService.listQueueTickets({
    companyId: COMPANY_A,
    viewerId: REVIEWER,
    queueId: QUEUE_A,
    canReadQueue: true,
  });
  assert.deepEqual(reviewerList.tickets.map((row) => row.ticketNumber), [ticket.ticketNumber]);
  assert.equal(reviewerList.meta.total, undefined);

  const combinedWorld = makeWorld({
    tickets: [ticket, ordinaryTicket],
    queues: [
      makeQueue(QUEUE_A, {
        confidentiality: {
          enabled: true,
          agentIds: [RESTRICTED_AGENT, MANAGER_AGENT],
          reviewerIds: [AGENT],
        },
      }),
      makeQueue(QUEUE_B),
    ],
  });
  const agentReviewerList = await combinedWorld.ticketService.listQueueTickets({
    companyId: COMPANY_A,
    viewerId: AGENT,
    queueId: QUEUE_A,
    canReadQueue: true,
  });
  assert.deepEqual(new Set(agentReviewerList.tickets.map((row) => row.ticketNumber)),
    new Set([ticket.ticketNumber, ordinaryTicket.ticketNumber]));

  const restricted = await world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: RESTRICTED_AGENT,
    ticketNumber: ticket.ticketNumber,
    canReadQueue: true,
  });
  assert.equal(restricted.confidential, true);
});

test('agent detail DTO is explicitly allowlisted and never populates a User document', async () => {
  const ticket = makeTicket(1, {
    subject: 'Need secure access',
    message: 'Requester-only work details',
    payroll: { salary: 999999 },
    medical: { diagnosis: 'secret' },
    platformNote: 'internal-only legacy field',
    replies: [{ message: 'legacy reply' }],
  });
  const world = makeWorld({ tickets: [ticket] });
  const details = await world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: AGENT,
    ticketNumber: ticket.ticketNumber,
    canReadQueue: true,
  });
  assert.equal(details.description, ticket.message);
  assert.equal(details.requesterId, REQUESTER);
  for (const field of [
    '_id', 'companyId', 'user', 'message', 'payroll', 'medical', 'platformNote', 'replies',
    'email', 'name', 'salary', 'bankAccount', 'address', 'assignedSupportAgent',
  ]) {
    assert.equal(Object.hasOwn(details, field), false, `${field} must not be in the agent DTO`);
  }
  assert.equal(world.UserModel.calls.findOne.length, 0);
  assert.equal(world.TicketModel.calls.findOne[0].filter.companyId, COMPANY_A);
  assert.equal(world.TicketModel.calls.findOne[0].filter.ticketKind, SUPPORT_TICKET_KIND.HELPDESK);
});

test('atomic claim permits one active explicit queue agent to win and returns 409 to the concurrent loser', async () => {
  const ticket = makeTicket(1);
  const world = makeWorld({ tickets: [ticket] });
  const outcomes = await Promise.allSettled([
    world.ticketService.claimTicket({ companyId: COMPANY_A, actorId: AGENT, ticketNumber: ticket.ticketNumber }),
    world.ticketService.claimTicket({ companyId: COMPANY_A, actorId: AGENT, ticketNumber: ticket.ticketNumber }),
  ]);
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((row) => row.status === 'rejected').length, 1);
  const rejected = outcomes.find((row) => row.status === 'rejected');
  assert.equal(rejected.reason.statusCode, 409);
  assert.equal(world.TicketModel.rows[0].assignedTo, AGENT);
  assert.equal(world.TicketModel.rows[0].status, 'assigned');
  assert.equal(world.TicketModel.calls.findOneAndUpdate.length, 2);
  for (const call of world.TicketModel.calls.findOneAndUpdate) {
    assert.equal(call.filter.companyId, COMPANY_A);
    assert.equal(call.filter.ticketKind, SUPPORT_TICKET_KIND.HELPDESK);
    assert.equal(call.filter.ticketNumber, ticket.ticketNumber);
    assert.equal(call.filter.queueId, QUEUE_A);
    assert.equal(call.filter.status, 'open');
    assert.equal(call.filter.assignedTo, null);
    assert.deepEqual(call.update.$set, { assignedTo: AGENT, status: 'assigned' });
    assert.equal(call.options.runValidators, true);
  }

  await expectStatus(world.ticketService.claimTicket({
    companyId: COMPANY_A,
    actorId: ORG_MANAGER,
    ticketNumber: ticket.ticketNumber,
  }), 404);
});

test('atomic status transitions enforce the central graph and assigned-state consistency', async () => {
  const unassigned = makeTicket(1);
  const world = makeWorld({ tickets: [unassigned] });
  await expectStatus(world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: unassigned.ticketNumber,
    status: 'assigned',
  }), 409);
  assert.equal(world.TicketModel.calls.findOneAndUpdate.length, 0);

  const inProgress = await world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: unassigned.ticketNumber,
    status: 'IN_PROGRESS',
  });
  assert.equal(inProgress.status, 'in_progress');
  const resolved = await world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: unassigned.ticketNumber,
    status: 'resolved',
  });
  assert.equal(resolved.status, 'resolved');
  const closed = await world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: unassigned.ticketNumber,
    status: 'closed',
  });
  assert.equal(closed.status, 'closed');
  await expectStatus(world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: unassigned.ticketNumber,
    status: 'in_progress',
  }), 409);

  const assignedTicket = makeTicket(3, { status: 'assigned', assignedTo: AGENT });
  world.TicketModel.rows.push(assignedTicket);
  const released = await world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: assignedTicket.ticketNumber,
    status: 'open',
  });
  assert.equal(released.status, 'open');
  assert.equal(released.assignedTo, null);
  const releaseCall = world.TicketModel.calls.findOneAndUpdate.at(-1);
  assert.equal(releaseCall.filter.status, 'assigned');
  assert.equal(releaseCall.filter.assignedTo, AGENT);
  assert.deepEqual(releaseCall.update.$set, { status: 'open', assignedTo: null });

  const invalidStatus = makeTicket(2);
  world.TicketModel.rows.push(invalidStatus);
  await expectStatus(world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: invalidStatus.ticketNumber,
    status: 'waiting_for_customer',
  }), 400);
});

test('concurrent status mutations compare current state and cannot silently overwrite each other', async () => {
  const ticket = makeTicket(1);
  const world = makeWorld({ tickets: [ticket] });
  const outcomes = await Promise.allSettled([
    world.ticketService.updateStatus({ companyId: COMPANY_A, actorId: AGENT, ticketNumber: ticket.ticketNumber, status: 'in_progress' }),
    world.ticketService.updateStatus({ companyId: COMPANY_A, actorId: AGENT, ticketNumber: ticket.ticketNumber, status: 'cancelled' }),
  ]);
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((row) => row.status === 'rejected').length, 1);
  assert.equal(outcomes.find((row) => row.status === 'rejected').reason.statusCode, 409);
  assert.ok(['in_progress', 'cancelled'].includes(world.TicketModel.rows[0].status));
  assert.equal(world.TicketModel.calls.findOneAndUpdate.length, 2);
  assert.ok(world.TicketModel.calls.findOneAndUpdate.every((call) =>
    call.filter.companyId === COMPANY_A
      && call.filter.ticketKind === SUPPORT_TICKET_KIND.HELPDESK
      && call.filter.status === 'open'
      && call.filter.queueId === QUEUE_A,
  ));
});

test('assignment/reassignment is manager-only, tenant/member-validated, and atomically conditional', async () => {
  const ticket = makeTicket(1);
  const world = makeWorld({ tickets: [ticket] });
  await expectStatus(world.ticketService.assignTicket({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: ticket.ticketNumber,
    assigneeId: AGENT_TWO,
  }), 404);

  const assigned = await world.ticketService.assignTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: ticket.ticketNumber,
    assigneeId: AGENT,
  });
  assert.equal(assigned.assignedTo, AGENT);
  assert.equal(assigned.status, 'assigned');
  const reassigned = await world.ticketService.assignTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: ticket.ticketNumber,
    assigneeId: AGENT_TWO,
  });
  assert.equal(reassigned.assignedTo, AGENT_TWO);
  assert.equal(reassigned.status, 'assigned');
  const reassignCall = world.TicketModel.calls.findOneAndUpdate.at(-1);
  assert.equal(reassignCall.filter.companyId, COMPANY_A);
  assert.equal(reassignCall.filter.ticketKind, SUPPORT_TICKET_KIND.HELPDESK);
  assert.equal(reassignCall.filter.status, 'assigned');
  assert.equal(reassignCall.filter.assignedTo, AGENT);
  assert.equal(reassignCall.update.$set.assignedTo, AGENT_TWO);
  assert.equal(reassignCall.options.runValidators, true);

  for (const invalidAssignee of [OTHER_TENANT_USER, INACTIVE_AGENT, ORG_MANAGER]) {
    const before = world.TicketModel.calls.findOneAndUpdate.length;
    await expectStatus(world.ticketService.assignTicket({
      companyId: COMPANY_A,
      actorId: QUEUE_MANAGER,
      ticketNumber: ticket.ticketNumber,
      assigneeId: invalidAssignee,
    }), 400);
    assert.equal(world.TicketModel.calls.findOneAndUpdate.length, before);
  }
});

test('concurrent assignment attempts compare ticket state and only one manager write succeeds', async () => {
  const ticket = makeTicket(1);
  const world = makeWorld({ tickets: [ticket] });
  const outcomes = await Promise.allSettled([
    world.ticketService.assignTicket({
      companyId: COMPANY_A,
      actorId: QUEUE_MANAGER,
      ticketNumber: ticket.ticketNumber,
      assigneeId: AGENT,
    }),
    world.ticketService.assignTicket({
      companyId: COMPANY_A,
      actorId: QUEUE_MANAGER,
      ticketNumber: ticket.ticketNumber,
      assigneeId: AGENT_TWO,
    }),
  ]);
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((row) => row.status === 'rejected').length, 1);
  assert.equal(outcomes.find((row) => row.status === 'rejected').reason.statusCode, 409);
  assert.ok([AGENT, AGENT_TWO].includes(world.TicketModel.rows[0].assignedTo));
  assert.equal(world.TicketModel.rows[0].status, 'assigned');
  assert.ok(world.TicketModel.calls.findOneAndUpdate.every((call) =>
    call.filter.companyId === COMPANY_A
      && call.filter.ticketKind === SUPPORT_TICKET_KIND.HELPDESK
      && call.filter.queueId === QUEUE_A
      && call.filter.status === 'open'
      && call.filter.assignedTo === null,
  ));
});

test('confidential assignment and operational priority require restricted agent access', async () => {
  const ticket = makeTicket(1, { isConfidential: true });
  const world = makeWorld({ tickets: [ticket] });
  await expectStatus(world.ticketService.assignTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: ticket.ticketNumber,
    assigneeId: RESTRICTED_AGENT,
  }), 404);
  const assigned = await world.ticketService.assignTicket({
    companyId: COMPANY_A,
    actorId: MANAGER_AGENT,
    ticketNumber: ticket.ticketNumber,
    assigneeId: RESTRICTED_AGENT,
  });
  assert.equal(assigned.assignedTo, RESTRICTED_AGENT);

  const normalAgent = makeTicket(2, { isConfidential: true });
  world.TicketModel.rows.push(normalAgent);
  await expectStatus(world.ticketService.updatePriority({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: normalAgent.ticketNumber,
    priority: 'urgent',
  }), 404);
  const updated = await world.ticketService.updatePriority({
    companyId: COMPANY_A,
    actorId: RESTRICTED_AGENT,
    ticketNumber: normalAgent.ticketNumber,
    priority: 'URGENT',
  });
  assert.equal(updated.priority, 'urgent');

  const closed = makeTicket(3, { status: 'closed' });
  world.TicketModel.rows.push(closed);
  await expectStatus(world.ticketService.updatePriority({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: closed.ticketNumber,
    priority: 'high',
  }), 409);
});

test('priority writes use a conditional priority snapshot and reject concurrent stale writes', async () => {
  const ticket = makeTicket(1);
  const world = makeWorld({ tickets: [ticket] });
  const outcomes = await Promise.allSettled([
    world.ticketService.updatePriority({ companyId: COMPANY_A, actorId: AGENT, ticketNumber: ticket.ticketNumber, priority: 'high' }),
    world.ticketService.updatePriority({ companyId: COMPANY_A, actorId: AGENT, ticketNumber: ticket.ticketNumber, priority: 'urgent' }),
  ]);
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((row) => row.status === 'rejected').length, 1);
  assert.equal(outcomes.find((row) => row.status === 'rejected').reason.statusCode, 409);
  assert.ok(['high', 'urgent'].includes(world.TicketModel.rows[0].priority));
  assert.ok(world.TicketModel.calls.findOneAndUpdate.every((call) => call.filter.priority === 'normal'));
});

test('queue transfer requires both queue managers, an enabled destination category, and target-queue assignment', async () => {
  const ticket = makeTicket(1);
  const world = makeWorld({ tickets: [ticket] });
  const result = await world.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: ticket.ticketNumber,
    input: { queueId: QUEUE_B, categoryId: CATEGORY_B, assigneeId: DESTINATION_AGENT },
  });
  assert.equal(result.queue.id, QUEUE_B);
  assert.equal(result.category.id, CATEGORY_B);
  assert.equal(result.assignedTo, DESTINATION_AGENT);
  assert.equal(result.status, 'assigned');
  assert.equal(world.TicketModel.rows[0].queueId, QUEUE_B);
  assert.equal(world.TicketModel.calls.findOneAndUpdate.length, 1);
  const call = world.TicketModel.calls.findOneAndUpdate[0];
  assert.equal(call.filter.companyId, COMPANY_A);
  assert.equal(call.filter.ticketKind, SUPPORT_TICKET_KIND.HELPDESK);
  assert.equal(call.filter.queueId, QUEUE_A);
  assert.equal(call.filter.status, 'open');
  assert.equal(call.filter.assignedTo, null);
  assert.equal(call.update.$set.queueId, QUEUE_B);
  assert.equal(call.update.$set.assignedTo, DESTINATION_AGENT);

  const noManagerQueue = makeQueue(QUEUE_B, { managers: [MANAGER_AGENT] });
  const unauthorized = makeWorld({ tickets: [makeTicket(2)], queues: [makeQueue(QUEUE_A), noManagerQueue] });
  await expectStatus(unauthorized.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: 'HD-000002',
    input: { queueId: QUEUE_B, categoryId: CATEGORY_B },
  }), 404);

  const disabledQueue = makeQueue(QUEUE_B, { enabled: false });
  const disabled = makeWorld({ tickets: [makeTicket(3)], queues: [makeQueue(QUEUE_A), disabledQueue] });
  await expectStatus(disabled.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: 'HD-000003',
    input: { queueId: QUEUE_B, categoryId: CATEGORY_B },
  }), 404);

  const foreign = makeQueue(FOREIGN_QUEUE, { companyId: COMPANY_B });
  const foreignWorld = makeWorld({ tickets: [makeTicket(4)], queues: [makeQueue(QUEUE_A), foreign] });
  await expectStatus(foreignWorld.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: 'HD-000004',
    input: { queueId: FOREIGN_QUEUE, categoryId: CATEGORY_B },
  }), 404);

  const wrongCategory = makeWorld({ tickets: [makeTicket(5)] });
  await expectStatus(wrongCategory.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: 'HD-000005',
    input: { queueId: QUEUE_B, categoryId: CATEGORY_A },
  }), 400);
  assert.equal(wrongCategory.TicketModel.rows[0].queueId, QUEUE_A);
});

test('concurrent queue transfers compare the source queue and only one destination wins', async () => {
  const ticket = makeTicket(1);
  const world = makeWorld({
    tickets: [ticket],
    queues: [makeQueue(QUEUE_A), makeQueue(QUEUE_B), makeQueue(QUEUE_C)],
  });
  const outcomes = await Promise.allSettled([
    world.ticketService.transferTicket({
      companyId: COMPANY_A,
      actorId: QUEUE_MANAGER,
      ticketNumber: ticket.ticketNumber,
      input: { queueId: QUEUE_B, categoryId: CATEGORY_B },
    }),
    world.ticketService.transferTicket({
      companyId: COMPANY_A,
      actorId: QUEUE_MANAGER,
      ticketNumber: ticket.ticketNumber,
      input: { queueId: QUEUE_C, categoryId: CATEGORY_C },
    }),
  ]);
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((row) => row.status === 'rejected').length, 1);
  assert.equal(outcomes.find((row) => row.status === 'rejected').reason.statusCode, 409);
  assert.ok([QUEUE_B, QUEUE_C].includes(world.TicketModel.rows[0].queueId));
  assert.equal(world.TicketModel.rows[0].assignedTo, null);
  assert.equal(world.TicketModel.rows[0].status, 'open');
  assert.ok(world.TicketModel.calls.findOneAndUpdate.every((call) =>
    call.filter.companyId === COMPANY_A
      && call.filter.ticketKind === SUPPORT_TICKET_KIND.HELPDESK
      && call.filter.queueId === QUEUE_A
      && call.filter.status === 'open'
      && call.filter.assignedTo === null,
  ));
});

test('confidential transfer preserves the restricted-agent allowlist and tenant policy', async () => {
  const ticket = makeTicket(1, { isConfidential: true });
  const world = makeWorld({ tickets: [ticket] });
  await expectStatus(world.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: ticket.ticketNumber,
    input: { queueId: QUEUE_B, categoryId: CATEGORY_B, assigneeId: RESTRICTED_AGENT },
  }), 404);

  const result = await world.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: MANAGER_AGENT,
    ticketNumber: ticket.ticketNumber,
    input: { queueId: QUEUE_B, categoryId: CATEGORY_B, assigneeId: RESTRICTED_AGENT },
  });
  assert.equal(result.confidential, true);
  assert.equal(result.queue.id, QUEUE_B);
  assert.equal(result.assignedTo, RESTRICTED_AGENT);
  assert.deepEqual(world.configService.calls, [COMPANY_A, COMPANY_A]);

  const disabledConfidentiality = makeWorld({
    tickets: [makeTicket(2, { isConfidential: true })],
    queues: [makeQueue(QUEUE_A), makeQueue(QUEUE_B, { confidentiality: { enabled: false, agentIds: [], reviewerIds: [] } })],
  });
  await expectStatus(disabledConfidentiality.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: MANAGER_AGENT,
    ticketNumber: 'HD-000002',
    input: { queueId: QUEUE_B, categoryId: CATEGORY_B, assigneeId: RESTRICTED_AGENT },
  }), 404);

  const tenantPolicyOff = makeWorld({
    tickets: [makeTicket(3, { isConfidential: true })],
    config: { confidentialTicketsEnabled: false },
  });
  await expectStatus(tenantPolicyOff.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: MANAGER_AGENT,
    ticketNumber: 'HD-000003',
    input: { queueId: QUEUE_B, categoryId: CATEGORY_B, assigneeId: RESTRICTED_AGENT },
  }), 409);
});

test('claim, status, priority, assignment, and transfer mutations all write tenant/queue/principal fences in-session', async () => {
  const world = makeWorld({ tickets: [makeTicket(1), makeTicket(2), makeTicket(3), makeTicket(4), makeTicket(5)] });
  await world.ticketService.claimTicket({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: 'HD-000001',
  });
  await world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: 'HD-000002',
    status: 'in_progress',
  });
  await world.ticketService.updatePriority({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: 'HD-000003',
    priority: 'high',
  });
  await world.ticketService.assignTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: 'HD-000004',
    assigneeId: AGENT,
  });
  await world.ticketService.transferTicket({
    companyId: COMPANY_A,
    actorId: MANAGER_AGENT,
    ticketNumber: 'HD-000005',
    input: { queueId: QUEUE_B, categoryId: CATEGORY_B, assigneeId: DESTINATION_AGENT },
  });

  assert.equal(world.FenceModel.calls.length, 6);
  assert.ok(world.FenceModel.calls.every((call) => call.hasSession));
  const fencePairs = world.FenceModel.calls.flatMap((call) => call.operations.map((operation) => [
    operation.filter.queueId,
    operation.filter.userId,
  ]));
  for (const pair of [
    [QUEUE_A, AGENT],
    [QUEUE_A, QUEUE_MANAGER],
    [QUEUE_A, MANAGER_AGENT],
    [QUEUE_B, MANAGER_AGENT],
    [QUEUE_B, DESTINATION_AGENT],
  ]) {
    assert.ok(fencePairs.some(([queueId, userId]) => queueId === pair[0] && userId === pair[1]));
  }
  assert.equal(world.FenceModel.rows.get(`${COMPANY_A}:${QUEUE_B}:${DESTINATION_AGENT}`).writeVersion, 1);
});

test('queue membership revocation wins a deterministic fence race and retries agent authorization', async () => {
  const FenceModel = makeFakeHelpdeskFenceModel();
  const fenceRace = makeHelpdeskFenceRaceHarness({
    FenceModel,
    pauseWhen: ({ operations, session }) => session.id.endsWith('-1')
      && operations.some((operation) => operation.updateOne.filter.userId === AGENT),
  });
  const ticket = makeTicket(1);
  const world = makeWorld({
    tickets: [ticket],
    FenceModel,
    transactionRunner: fenceRace.transactionRunner,
  });
  attachQueueSaveSupport(world.QueueModel);

  const protectedWrite = world.ticketService.updateStatus({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: ticket.ticketNumber,
    status: 'in_progress',
  });
  const paused = await fenceRace.waitForPausedWrite();
  assert.equal(paused.session.id, 'fake-helpdesk-session-1');

  await world.queueService.updateQueue({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    queueId: QUEUE_A,
    input: { agents: [AGENT_TWO, RESTRICTED_AGENT, MANAGER_AGENT, DESTINATION_AGENT] },
  });
  fenceRace.releasePausedWrite();

  await expectStatus(protectedWrite, 404);
  assert.equal(world.TicketModel.rows[0].status, 'open');
  assert.deepEqual(world.QueueModel.rows[0].agents, [AGENT_TWO, RESTRICTED_AGENT, MANAGER_AGENT, DESTINATION_AGENT]);
  const sharedPrincipalAttempts = fenceRace.raceAttempts.filter((attempt) =>
    attempt.operations.some((operation) => operation.filter.userId === AGENT),
  );
  assert.equal(sharedPrincipalAttempts.length, 2);
  assert.equal(sharedPrincipalAttempts[0].sessionId, 'fake-helpdesk-session-1');
  assert.equal(sharedPrincipalAttempts[1].sessionId, 'fake-helpdesk-session-2');
  assert.equal(FenceModel.rows.get(`${COMPANY_A}:${QUEUE_A}:${AGENT}`).writeVersion, 1);
  assert.equal(fenceRace.transactionCount, 3);
});

test('concurrent claim and transfer cannot leave a ticket with stale queue/assignee state', async () => {
  const ticket = makeTicket(1);
  const world = makeWorld({ tickets: [ticket] });
  const outcomes = await Promise.allSettled([
    world.ticketService.claimTicket({ companyId: COMPANY_A, actorId: MANAGER_AGENT, ticketNumber: ticket.ticketNumber }),
    world.ticketService.transferTicket({
      companyId: COMPANY_A,
      actorId: MANAGER_AGENT,
      ticketNumber: ticket.ticketNumber,
      input: { queueId: QUEUE_B, categoryId: CATEGORY_B },
    }),
  ]);
  assert.equal(outcomes.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((row) => row.status === 'rejected').length, 1);
  assert.equal(outcomes.find((row) => row.status === 'rejected').reason.statusCode, 409);
  const final = world.TicketModel.rows[0];
  if (final.queueId === QUEUE_B) {
    assert.equal(final.assignedTo, null);
    assert.equal(final.status, 'open');
  } else {
    assert.equal(final.queueId, QUEUE_A);
    assert.equal(final.assignedTo, MANAGER_AGENT);
    assert.equal(final.status, 'assigned');
  }
});

test('transfer input and HTTP validators reject authority overrides and unsupported filters', async () => {
  for (const field of ['companyId', 'userId', 'requesterId', 'actorId', 'assignedTo', 'reviewedBy', 'auditId']) {
    assert.throws(() => validateHelpdeskTransferInput({
      queueId: QUEUE_B,
      categoryId: CATEGORY_B,
      [field]: REQUESTER,
    }), (error) => error.statusCode === 400);
  }
  assert.deepEqual(validateHelpdeskTransferInput({ queueId: QUEUE_B, categoryId: CATEGORY_B }), {
    queueId: QUEUE_B,
    categoryId: CATEGORY_B,
    assigneeId: null,
  });
  for (const input of [
    { queueId: [QUEUE_B], categoryId: CATEGORY_B },
    { queueId: QUEUE_B, categoryId: { id: CATEGORY_B } },
    { queueId: QUEUE_B, categoryId: CATEGORY_B, assigneeId: null },
  ]) {
    assert.throws(() => validateHelpdeskTransferInput(input), (error) => error.statusCode === 400);
  }

  await runValidation(helpdeskTicketTransferValidator, {
    body: { queueId: QUEUE_B, categoryId: CATEGORY_B, assigneeId: DESTINATION_AGENT },
    params: { ticketNumber: 'HD-000001' },
    query: {},
  });
  await expectStatus(runValidation(helpdeskTicketTransferValidator, {
    body: { queueId: QUEUE_B, categoryId: CATEGORY_B, companyId: COMPANY_B },
    params: { ticketNumber: 'HD-000001' },
    query: {},
  }), 400);
  await expectStatus(runValidation(helpdeskTicketClaimValidator, {
    body: { actorId: AGENT },
    params: { ticketNumber: 'HD-000001' },
    query: {},
  }), 400);
  for (const [validators, body] of [
    [helpdeskTicketAssignmentValidator, { assigneeId: AGENT, actorId: QUEUE_MANAGER }],
    [helpdeskTicketPriorityValidator, { priority: 'urgent', companyId: COMPANY_A }],
    [helpdeskTicketStatusValidator, { status: 'resolved', requesterId: REQUESTER }],
  ]) {
    await expectStatus(runValidation(validators, {
      body,
      params: { ticketNumber: 'HD-000001' },
      query: {},
    }), 400);
  }
  await runValidation(helpdeskQueueTicketListQueryValidator, {
    query: { status: 'open', search: 'VPN', sort: 'newest', page: '1', limit: '20' },
    params: { queueId: QUEUE_A },
    body: {},
  });
  await expectStatus(runValidation(helpdeskQueueTicketListQueryValidator, {
    query: { assignedTo: AGENT },
    params: { queueId: QUEUE_A },
    body: {},
  }), 400);
});

test('agent route registrations reuse existing endpoints and gate new operations through Helpdesk permissions', () => {
  const expectations = [
    ['/queues/:queueId/tickets', 'get', helpdeskController.listQueueTickets],
    ['/queues/:queueId/tickets/assigned-to-me', 'get', helpdeskController.listAssignedTicketsToMe],
    ['/queues/:queueId/tickets/unassigned', 'get', helpdeskController.listUnassignedTickets],
    ['/tickets/:ticketNumber/claim', 'patch', helpdeskController.claimTicket],
    ['/tickets/:ticketNumber/assignment', 'patch', helpdeskController.assignTicket],
    ['/tickets/:ticketNumber/priority', 'patch', helpdeskController.updateTicketPriority],
    ['/tickets/:ticketNumber/status', 'patch', helpdeskController.updateTicketStatus],
    ['/tickets/:ticketNumber/transfer', 'patch', helpdeskController.transferTicket],
  ];
  for (const [pathName, method, handler] of expectations) {
    const layer = getRoute(pathName, method);
    assert.ok(layer, `${method.toUpperCase()} ${pathName} must be registered`);
    assert.equal(layer.route.stack.at(-1).handle, handler);
    assert.ok(layer.route.stack.length > 2, 'route retains authentication, tenant, RBAC and validation middleware');
  }
  const source = read('src/routes/helpdeskRoutes.js');
  const controllerSource = read('src/controllers/helpdeskController.js');
  assert.match(controllerSource, /const companyId = req\.companyId/);
  assert.match(controllerSource, /const actorId = req\.user\._id/);
  assert.match(controllerSource, /const viewerId = req\.user\._id/);
  assert.doesNotMatch(controllerSource, /req\.body\??\.(?:companyId|actorId|assignedTo|requesterId)/);
  assert.match(source, /requirePermission\('HELPDESK_TICKET_READ'\)/);
  assert.match(source, /requirePermission\('HELPDESK_TICKET_MANAGE'\)/);
  assert.match(source, /checkWriteAccess/);
  assert.doesNotMatch(source, /\b(?:Department|reportingTo|role === ['"]MANAGER)/);
  assert.ok(HelpdeskTicket.schema.indexes().some(([keys, options]) =>
    keys.companyId === 1 && keys.queueId === 1 && keys.assignedTo === 1
      && keys.createdAt === -1 && keys._id === -1
      && options.partialFilterExpression?.ticketKind === 'HELPDESK',
  ));
  assert.ok(HelpdeskTicket.schema.indexes().some(([keys, options]) =>
    keys.companyId === 1 && keys.queueId === 1 && keys.updatedAt === -1
      && options.partialFilterExpression?.ticketKind === 'HELPDESK',
  ));
});

test('global auditTrail logs safe Helpdesk operation metadata, never body descriptions', () => {
  const originalCreate = AuditLog.create;
  const auditRows = [];
  AuditLog.create = async (entry) => {
    auditRows.push(clone(entry));
    return entry;
  };

  try {
    const operations = [
      ['claim', 'Claimed a Helpdesk ticket'],
      ['assignment', 'Changed a Helpdesk ticket assignment'],
      ['priority', 'Changed a Helpdesk ticket priority'],
      ['status', 'Changed a Helpdesk ticket status'],
      ['transfer', 'Transferred a Helpdesk ticket'],
    ];
    for (const [operation] of operations) {
      let finish;
      const req = {
        method: 'PATCH',
        originalUrl: `/api/helpdesk/tickets/HD-000001/${operation}`,
        companyId: COMPANY_A,
        user: { _id: AGENT, name: 'Test Agent', role: 'EMPLOYEE' },
        ip: '127.0.0.1',
        body: { description: 'DO_NOT_AUDIT_THIS_TEXT', subject: 'private subject' },
      };
      const res = {
        statusCode: 200,
        on(event, listener) {
          assert.equal(event, 'finish');
          finish = listener;
        },
      };
      auditTrail(req, res, () => {});
      finish();
    }

    assert.deepEqual(auditRows.map((row) => row.action), operations.map(([, action]) => action));
    for (const row of auditRows) {
      assert.equal(row.companyId, COMPANY_A);
      assert.equal(row.actor, AGENT);
      assert.equal(row.statusCode, 200);
      assert.equal(row.method, 'PATCH');
      assert.equal(Object.hasOwn(row, 'description'), false);
      assert.equal(JSON.stringify(row).includes('DO_NOT_AUDIT_THIS_TEXT'), false);
      assert.equal(JSON.stringify(row).includes('private subject'), false);
    }
  } finally {
    AuditLog.create = originalCreate;
  }
});
