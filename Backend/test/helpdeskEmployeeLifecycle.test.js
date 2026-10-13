// PHASE 38.2 — EMPLOYEE HELPDESK TICKET LIFECYCLE (hermetic)
// Tests use injected in-memory models; no live Mongo, Redis, network, or HR side effects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_helpdesk_lifecycle_test';

const [
  rulesModule,
  ticketServiceModule,
  ticketModelModule,
  routeModule,
  controllerModule,
  validatorModule,
  kindModule,
] = await Promise.all([
  import('../src/services/helpdesk/helpdeskRules.js'),
  import('../src/services/helpdesk/helpdeskTicketService.js'),
  import('../src/models/HelpdeskTicket.js'),
  import('../src/routes/helpdeskRoutes.js'),
  import('../src/controllers/helpdeskController.js'),
  import('../src/validators/helpdeskValidator.js'),
  import('../src/utils/supportTicketKinds.js'),
]);

const { normalizeHelpdeskTicketListQuery, validateHelpdeskTicketCreateInput } = rulesModule;
const { helpdeskTicketService } = ticketServiceModule;
const HelpdeskTicket = ticketModelModule.default;
const helpdeskRouter = routeModule.default;
const helpdeskController = controllerModule;
const { helpdeskTicketCreateValidator, helpdeskTicketListQueryValidator } = validatorModule;
const { SUPPORT_TICKET_KIND } = kindModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const root = path.join(backendRoot, '..');
const read = (relative) => fs.readFileSync(path.join(backendRoot, relative), 'utf8');
const readRoot = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const oid = (number) => Number(number).toString(16).padStart(24, '0');
const COMPANY_A = oid(100);
const COMPANY_B = oid(200);
const REQUESTER = oid(1);
const OTHER_EMPLOYEE = oid(2);
const QUEUE_AGENT = oid(3);
const QUEUE_MANAGER = oid(4);
const QUEUE_A = oid(900);
const QUEUE_B = oid(901);
const CATEGORY_A = oid(910);
const CATEGORY_B = oid(911);

const clone = (value) => value == null ? value : structuredClone(value);
const norm = (value) => {
  if (value && typeof value === 'object' && value._id !== undefined) return norm(value._id);
  if (value instanceof Date) return value.getTime();
  return String(value ?? '');
};
const getPath = (value, dottedPath) =>
  String(dottedPath).split('.').reduce((current, part) => current == null ? undefined : current[part], value);

const matchesValue = (actual, expected) => {
  if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    if (Object.hasOwn(expected, '$in')) return expected.$in.some((candidate) => norm(actual) === norm(candidate));
    if (Object.hasOwn(expected, '$ne')) return norm(actual) !== norm(expected.$ne);
    if (Object.hasOwn(expected, '$regex')) {
      const expression = expected.$regex instanceof RegExp
        ? expected.$regex
        : new RegExp(expected.$regex, expected.$options || '');
      return expression.test(String(actual ?? ''));
    }
    return true;
  }
  if (expected === null) return actual === null || actual === undefined;
  return norm(actual) === norm(expected);
};
const matches = (row, filter = {}) => Object.entries(filter).every(([key, expected]) => {
  if (key === '$and') return expected.every((part) => matches(row, part));
  if (key === '$or') return expected.some((part) => matches(row, part));
  return matchesValue(getPath(row, key), expected);
});

const project = (value, fields) => {
  if (!fields) return value;
  const include = String(fields).split(/\s+/).filter((field) => field && !field.startsWith('-'));
  const one = (row) => {
    if (!row) return row;
    const result = {};
    if (row._id !== undefined) result._id = row._id;
    for (const field of include) {
      const fieldValue = getPath(row, field);
      if (fieldValue !== undefined) result[field] = fieldValue;
    }
    return result;
  };
  return Array.isArray(value) ? value.map(one) : one(value);
};

const makeQuery = (resolver) => {
  let projection = null;
  let sortSpec = null;
  let skipCount = 0;
  let limitCount = null;
  let wantsLean = false;
  const chain = {
    select(fields) { projection = fields; return chain; },
    sort(spec) { sortSpec = spec; return chain; },
    skip(amount) { skipCount = amount; return chain; },
    limit(amount) { limitCount = amount; return chain; },
    lean() { wantsLean = true; return chain; },
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
                  if (a === undefined || a === null) return -1 * direction;
                  if (b === undefined || b === null) return 1 * direction;
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
          return wantsLean ? clone(result) : result;
        })
        .then(onFulfilled, onRejected);
    },
  };
  return chain;
};

const makeQueue = (overrides = {}) => ({
  _id: QUEUE_A,
  companyId: COMPANY_A,
  name: 'People Support',
  enabled: true,
  categories: [{ _id: CATEGORY_A, name: 'Account access', enabled: true }],
  agents: [QUEUE_AGENT],
  managers: [QUEUE_MANAGER],
  confidentiality: { enabled: true, agentIds: [QUEUE_AGENT], reviewerIds: [] },
  ...clone(overrides),
});

const makeTicket = (number, overrides = {}) => {
  const day = String(number).padStart(2, '0');
  return {
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
    createdAt: new Date(`2026-01-${day}T09:00:00.000Z`),
    updatedAt: new Date(`2026-01-${day}T10:00:00.000Z`),
    ...clone(overrides),
  };
};

const makeTicketModel = (seed = []) => {
  const rows = seed.map(clone);
  const calls = { find: [], findOne: [], countDocuments: [], create: [], findOneAndUpdate: [] };
  let nextId = 8000;
  return {
    rows,
    calls,
    find(filter) {
      const call = { filter: clone(filter), projection: null, sort: null, skip: 0, limit: null };
      calls.find.push(call);
      return makeQuery((options) => {
        call.projection = options.projection;
        call.sort = options.sortSpec;
        call.skip = options.skipCount;
        call.limit = options.limitCount;
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
    async countDocuments(filter) {
      calls.countDocuments.push(clone(filter));
      return rows.filter((row) => matches(row, filter)).length;
    },
    async create(input) {
      calls.create.push(clone(input));
      const row = {
        _id: oid(nextId++),
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        updatedAt: new Date('2026-02-01T00:00:00.000Z'),
        ...clone(input),
      };
      rows.push(row);
      return clone(row);
    },
    findOneAndUpdate(filter, update, options) {
      calls.findOneAndUpdate.push({ filter: clone(filter), update: clone(update), options: clone(options) });
      return makeQuery(() => {
        const row = rows.find((candidate) => matches(candidate, filter));
        if (!row) return null;
        Object.assign(row, clone(update.$set || {}));
        row.updatedAt = new Date('2026-03-01T00:00:00.000Z');
        return row;
      });
    },
  };
};

const makeQueueModel = (seed = [makeQueue()]) => {
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

const makeSequenceModel = () => {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    async findOneAndUpdate(filter, update, options = {}) {
      calls.push({ filter: clone(filter), update: clone(update), options: clone(options) });
      const key = `${filter.companyId}:${filter.key}`;
      const row = rows.get(key) || { companyId: filter.companyId, key: filter.key, value: 0 };
      row.value += update.$inc?.value || 0;
      rows.set(key, row);
      return clone(row);
    },
  };
};

const makeWorld = ({ tickets = [], queues = [makeQueue()], config = {}, configFailure = null } = {}) => {
  const TicketModel = makeTicketModel(tickets);
  const QueueModel = makeQueueModel(queues);
  const SequenceModel = makeSequenceModel();
  const configService = {
    calls: [],
    async getConfig({ companyId }) {
      this.calls.push(companyId);
      if (configFailure) throw configFailure;
      return {
        enabled: true,
        allowEmployeeTickets: true,
        attachmentsEnabled: false,
        confidentialTicketsEnabled: true,
        defaultPriority: 'normal',
        ...clone(config),
      };
    },
  };
  const ticketService = helpdeskTicketService({ TicketModel, QueueModel, SequenceModel, configService });
  return { TicketModel, QueueModel, SequenceModel, configService, ticketService };
};

const createInput = (overrides = {}) => ({
  queueId: QUEUE_A,
  categoryId: CATEGORY_A,
  subject: '  Laptop access  ',
  description: ' Please provision access to the company laptop. ',
  ...overrides,
});

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

const sourceWithoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');

const validTicketsForLists = () => [
  makeTicket(1, { subject: 'Literal .* fragment', message: 'contains description-only-secret' }),
  makeTicket(2, { status: 'assigned', priority: 'high', queueId: QUEUE_B, categoryId: CATEGORY_B }),
  makeTicket(3, { status: 'in_progress', priority: 'high', updatedAt: new Date('2026-02-11T10:00:00.000Z') }),
  makeTicket(4, { status: 'open', priority: 'normal' }),
  makeTicket(5, { status: 'resolved', priority: 'low' }),
  makeTicket(6, { user: OTHER_EMPLOYEE, subject: 'Other employee ticket' }),
  makeTicket(7, { companyId: COMPANY_B, subject: 'Other tenant ticket' }),
  makeTicket(8, { ticketKind: 'LEGACY', subject: 'Legacy support ticket' }),
];

// ── Creation ───────────────────────────────────────────────────────────────
test('employee creation reuses tenant config, queue/category and atomic numbers with safe defaults', async () => {
  const world = makeWorld();
  const ticket = await world.ticketService.createTicket({
    companyId: COMPANY_A,
    requesterId: REQUESTER,
    input: createInput({ confidential: true, requestedPriority: 'urgent' }),
  });

  assert.equal(ticket.ticketNumber, 'HD-000001');
  assert.equal(ticket.requesterId, REQUESTER);
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.priority, 'normal');
  assert.equal(ticket.requestedPriority, 'urgent');
  assert.equal(ticket.assignedTo, null);
  assert.equal(ticket.confidential, true);
  assert.equal(ticket.description, 'Please provision access to the company laptop.');
  assert.deepEqual(world.configService.calls, [COMPANY_A]);
  assert.equal(world.SequenceModel.calls.length, 1);
  assert.equal(world.SequenceModel.calls[0].filter.companyId, COMPANY_A);
  assert.equal(world.TicketModel.calls.create.length, 1);
  const stored = world.TicketModel.calls.create[0];
  assert.equal(stored.companyId, COMPANY_A);
  assert.equal(stored.user, REQUESTER);
  assert.equal(stored.ticketKind, 'HELPDESK');
  assert.equal(stored.queueId, QUEUE_A);
  assert.equal(stored.categoryId, CATEGORY_A);
  assert.equal(stored.assignedTo, null);
  assert.equal(Object.hasOwn(stored, 'company'), false);
  assert.equal(Object.hasOwn(stored, 'createdBy'), false);
  assert.equal(Object.hasOwn(stored, 'statusFromClient'), false);
});

test('creation rejects identity/authority overrides, coerced body strings, disabled intake, and config failures closed', async () => {
  const base = createInput();
  for (const field of [
    'companyId', 'company', 'userId', 'user', 'employeeId', 'employee',
    'requesterId', 'requester', 'createdBy', 'ticketNumber', 'assignedTo', 'status',
  ]) {
    assert.throws(() => validateHelpdeskTicketCreateInput({ ...base, [field]: oid(333) }), /must not be supplied|Unsupported ticket field/);
  }
  assert.throws(() => validateHelpdeskTicketCreateInput({ ...base, subject: 123 }), /subject must be a string/);
  assert.throws(() => validateHelpdeskTicketCreateInput({ ...base, description: { text: 'x' } }), /description must be a string/);

  const invalidBody = { body: { ...base, requesterId: REQUESTER }, params: {}, query: {} };
  await expectStatus(runValidation(helpdeskTicketCreateValidator, invalidBody), 400);
  const validBody = { body: base, params: {}, query: {} };
  await runValidation(helpdeskTicketCreateValidator, validBody);

  const disabled = makeWorld({ config: { enabled: false } });
  await expectStatus(disabled.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: base }), 403);
  assert.equal(disabled.QueueModel.calls.findOne.length, 0);
  assert.equal(disabled.SequenceModel.calls.length, 0);

  const employeeIntakeOff = makeWorld({ config: { allowEmployeeTickets: false } });
  await expectStatus(employeeIntakeOff.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: base }), 403);

  const configUnavailable = makeWorld({ configFailure: new Error('database unavailable') });
  await assert.rejects(configUnavailable.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: base }), /database unavailable/);
  assert.equal(configUnavailable.QueueModel.calls.findOne.length, 0);
  assert.equal(configUnavailable.SequenceModel.calls.length, 0);
  assert.equal(configUnavailable.TicketModel.calls.create.length, 0);
});

test('creation revalidates tenant queue, enabled queue-local category, and confidentiality policy', async () => {
  const disabledQueue = makeWorld({ queues: [makeQueue({ enabled: false })] });
  await expectStatus(disabledQueue.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: createInput() }), 400);
  assert.equal(disabledQueue.SequenceModel.calls.length, 0);

  const disabledCategory = makeWorld({ queues: [makeQueue({ categories: [{ _id: CATEGORY_A, name: 'Account access', enabled: false }] })] });
  await expectStatus(disabledCategory.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: createInput() }), 400);
  assert.equal(disabledCategory.SequenceModel.calls.length, 0);

  const otherTenantQueue = makeWorld({ queues: [makeQueue({ companyId: COMPANY_B })] });
  await expectStatus(otherTenantQueue.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: createInput() }), 400);

  const crossQueueCategory = makeWorld({ queues: [makeQueue({ categories: [{ _id: CATEGORY_B, name: 'Other category', enabled: true }] })] });
  await expectStatus(crossQueueCategory.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: createInput() }), 400);

  const confidentialityOff = makeWorld({ config: { confidentialTicketsEnabled: false } });
  await expectStatus(confidentialityOff.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: createInput({ confidential: true }) }), 400);
  assert.equal(confidentialityOff.SequenceModel.calls.length, 0);
});

// ── My Tickets ────────────────────────────────────────────────────────────
test('My Tickets applies tenant/requester/discriminator scopes to rows and counts, with bounded stable pagination', async () => {
  const world = makeWorld({ tickets: validTicketsForLists() });
  const result = await world.ticketService.listMine({
    companyId: COMPANY_A,
    requesterId: REQUESTER,
    query: { page: '2', limit: '2', sort: 'newest' },
  });

  assert.deepEqual(result.tickets.map((ticket) => ticket.ticketNumber), ['HD-000003', 'HD-000002']);
  assert.deepEqual(result.meta, { page: 2, limit: 2, total: 5, pages: 3 });
  assert.deepEqual(world.TicketModel.calls.find[0].filter, {
    companyId: COMPANY_A,
    ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
    user: REQUESTER,
  });
  assert.deepEqual(world.TicketModel.calls.countDocuments[0], world.TicketModel.calls.find[0].filter);
  assert.equal(world.TicketModel.calls.find[0].skip, 2);
  assert.equal(world.TicketModel.calls.find[0].limit, 2);
  assert.match(world.TicketModel.calls.find[0].projection, /ticketNumber subject queueId categoryId categoryName status priority/);
  assert.doesNotMatch(world.TicketModel.calls.find[0].projection, /message|user|companyId|assignedTo/);
  assert.deepEqual(world.QueueModel.calls.find[0], { companyId: COMPANY_A, _id: { $in: [QUEUE_A, QUEUE_B] } });
});

test('My Tickets uses safe filters and literal search only over ticket number and subject, with explicit sort allowlist', async () => {
  const world = makeWorld({ tickets: validTicketsForLists() });
  const filtered = await world.ticketService.listMine({
    companyId: COMPANY_A,
    requesterId: REQUESTER,
    query: {
      status: 'open',
      priority: 'normal',
      queueId: QUEUE_A,
      search: '.*',
      sort: 'oldest',
    },
  });
  assert.deepEqual(filtered.tickets.map((ticket) => ticket.ticketNumber), ['HD-000001']);
  const filter = world.TicketModel.calls.find[0].filter;
  assert.equal(filter.status, 'open');
  assert.equal(filter.priority, 'normal');
  assert.equal(filter.queueId, QUEUE_A);
  assert.ok(Array.isArray(filter.$or));
  assert.deepEqual(Object.keys(filter.$or[0]).sort(), ['ticketNumber']);
  assert.deepEqual(Object.keys(filter.$or[1]).sort(), ['subject']);
  assert.ok(filter.$or.every((part) => !Object.hasOwn(part, 'message')));
  assert.deepEqual(world.TicketModel.calls.find[0].sort, { createdAt: 1, _id: 1 });

  const descriptionOnly = await world.ticketService.listMine({
    companyId: COMPANY_A,
    requesterId: REQUESTER,
    query: { search: 'description-only-secret' },
  });
  assert.equal(descriptionOnly.meta.total, 0);
  assert.deepEqual(descriptionOnly.tickets, []);

  const recent = await world.ticketService.listMine({ companyId: COMPANY_A, requesterId: REQUESTER, query: { sort: 'recently_updated' } });
  assert.equal(recent.tickets[0].ticketNumber, 'HD-000003');
  assert.deepEqual(world.TicketModel.calls.find.at(-1).sort, { updatedAt: -1, _id: -1 });
});

test('My Tickets list DTO is minimized and excludes descriptions, requester IDs, assignment and model internals', async () => {
  const world = makeWorld({ tickets: [makeTicket(1)] });
  const { tickets } = await world.ticketService.listMine({ companyId: COMPANY_A, requesterId: REQUESTER });
  const item = tickets[0];
  assert.deepEqual(Object.keys(item).sort(), [
    'category', 'confidential', 'createdAt', 'priority', 'queue', 'status', 'subject', 'ticketNumber', 'updatedAt',
  ]);
  assert.deepEqual(item.queue, { id: QUEUE_A, name: 'People Support' });
  assert.deepEqual(item.category, { id: CATEGORY_A, name: 'Account access' });
  for (const field of ['description', 'message', '_id', 'companyId', 'requesterId', 'user', 'assignedTo', 'requestedPriority']) {
    assert.equal(Object.hasOwn(item, field), false, `${field} must not be in list DTO`);
  }
});

test('My Tickets rejects identity query parameters, invalid filters, unbounded search and excessive pagination', async () => {
  const invalidQueries = [
    { userId: OTHER_EMPLOYEE },
    { employeeId: OTHER_EMPLOYEE },
    { requesterId: OTHER_EMPLOYEE },
    { companyId: COMPANY_B },
    { status: 'unknown' },
    { priority: 'p0' },
    { queueId: 'not-an-object-id' },
    { search: 'x'.repeat(61) },
    { search: ['two', 'values'] },
    { sort: 'message' },
    { page: '0' },
    { page: '10001' },
    { limit: '101' },
    { limit: '1.5' },
  ];
  for (const query of invalidQueries) {
    const world = makeWorld({ tickets: [makeTicket(1)] });
    await expectStatus(world.ticketService.listMine({ companyId: COMPANY_A, requesterId: REQUESTER, query }), 400);
    assert.equal(world.TicketModel.calls.find.length, 0);
    assert.equal(world.TicketModel.calls.countDocuments.length, 0);
  }

  await expectStatus(runValidation(helpdeskTicketListQueryValidator, {
    query: { userId: OTHER_EMPLOYEE }, params: {}, body: {},
  }), 400);
  await expectStatus(runValidation(helpdeskTicketListQueryValidator, {
    query: { search: 'x'.repeat(61) }, params: {}, body: {},
  }), 400);
  await runValidation(helpdeskTicketListQueryValidator, {
    query: { status: 'open', queueId: QUEUE_A, search: 'VPN', sort: 'newest', page: '1', limit: '20' },
    params: {}, body: {},
  });

  assert.deepEqual(normalizeHelpdeskTicketListQuery({}), {
    status: undefined,
    priority: undefined,
    queueId: undefined,
    search: '',
    sort: 'newest',
    page: 1,
    limit: 20,
  });
});

// ── Authorized details ─────────────────────────────────────────────────────
test('requester ticket details are owner-scoped, safe, and never expose another employee/tenant ticket', async () => {
  const confidential = makeTicket(1, { isConfidential: true, assignedTo: QUEUE_AGENT });
  const world = makeWorld({ tickets: [confidential] });
  const details = await world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: REQUESTER,
    ticketNumber: confidential.ticketNumber,
    canReadOwn: true,
  });

  assert.equal(details.ticketNumber, confidential.ticketNumber);
  assert.equal(details.description, confidential.message);
  assert.deepEqual(details.queue, { id: QUEUE_A, name: 'People Support' });
  assert.deepEqual(details.category, { id: CATEGORY_A, name: 'Account access' });
  assert.equal(details.requesterId, REQUESTER);
  for (const field of ['_id', 'companyId', 'user', 'assignedTo', 'requestedPriority', 'message']) {
    assert.equal(Object.hasOwn(details, field), false, `${field} must not be in employee details`);
  }
  assert.deepEqual(world.TicketModel.calls.findOne[0].filter, {
    companyId: COMPANY_A,
    ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
    user: REQUESTER,
    ticketNumber: confidential.ticketNumber,
  });

  await expectStatus(world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: OTHER_EMPLOYEE,
    ticketNumber: confidential.ticketNumber,
    canReadOwn: true,
  }), 404);
  assert.equal(world.TicketModel.calls.findOne.at(-1).filter.user, OTHER_EMPLOYEE);

  await expectStatus(world.ticketService.getTicket({
    companyId: COMPANY_B,
    viewerId: REQUESTER,
    ticketNumber: confidential.ticketNumber,
    canReadOwn: true,
  }), 404);
  assert.equal(world.TicketModel.calls.findOne.at(-1).filter.companyId, COMPANY_B);
});

test('authorized staff detail lane and confidentiality gate remain intact', async () => {
  const publicTicket = makeTicket(1, { isConfidential: false });
  const world = makeWorld({ tickets: [publicTicket] });
  const staffDetails = await world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: QUEUE_AGENT,
    ticketNumber: publicTicket.ticketNumber,
    canReadQueue: true,
  });
  assert.equal(staffDetails.ticketNumber, publicTicket.ticketNumber);
  assert.equal(staffDetails.requesterId, REQUESTER);

  const secretWorld = makeWorld({ tickets: [makeTicket(2, { isConfidential: true })] });
  await expectStatus(secretWorld.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: QUEUE_MANAGER,
    ticketNumber: 'HD-000002',
    canReadQueue: true,
  }), 404);
});

// ── Cancellation ──────────────────────────────────────────────────────────
test('cancellation is atomic, requester-scoped, only open/assigned, and history remains listable', async () => {
  const open = makeTicket(1, { status: 'open' });
  const assigned = makeTicket(2, { status: 'assigned', assignedTo: QUEUE_AGENT });
  const world = makeWorld({ tickets: [open, assigned] });
  const cancelledOpen = await world.ticketService.cancelOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: open.ticketNumber });
  const cancelledAssigned = await world.ticketService.cancelOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: assigned.ticketNumber });

  assert.equal(cancelledOpen.status, 'cancelled');
  assert.equal(cancelledAssigned.status, 'cancelled');
  assert.equal(world.TicketModel.rows.length, 2);
  assert.equal(world.TicketModel.calls.findOneAndUpdate.length, 2);
  for (const call of world.TicketModel.calls.findOneAndUpdate) {
    assert.deepEqual(call.filter.status, { $in: ['open', 'assigned'] });
    assert.equal(call.filter.companyId, COMPANY_A);
    assert.equal(call.filter.user, REQUESTER);
    assert.equal(call.filter.ticketKind, 'HELPDESK');
    assert.deepEqual(call.update, { $set: { status: 'cancelled' } });
    assert.deepEqual(call.options, { returnDocument: 'after', runValidators: true });
  }
  const history = await world.ticketService.listMine({ companyId: COMPANY_A, requesterId: REQUESTER });
  assert.deepEqual(history.tickets.map((ticket) => ticket.status), ['cancelled', 'cancelled']);
});

test('stale/concurrent cancellation cannot overwrite another status; losers get deterministic conflict', async () => {
  const stale = makeTicket(1, { status: 'in_progress' });
  const world = makeWorld({ tickets: [stale] });
  await expectStatus(world.ticketService.cancelOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: stale.ticketNumber }), 409);
  assert.equal(world.TicketModel.rows[0].status, 'in_progress');

  const concurrentTicket = makeTicket(2, { status: 'open' });
  const concurrentWorld = makeWorld({ tickets: [concurrentTicket] });
  const outcomes = await Promise.allSettled([
    concurrentWorld.ticketService.cancelOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: concurrentTicket.ticketNumber }),
    concurrentWorld.ticketService.cancelOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: concurrentTicket.ticketNumber }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.statusCode, 409);
  assert.equal(concurrentWorld.TicketModel.rows[0].status, 'cancelled');
  assert.equal(concurrentWorld.TicketModel.calls.findOneAndUpdate.length, 2);
});

test('cancellation does not disclose or mutate another requester/tenant ticket and conflicts on terminal history', async () => {
  const ownClosed = makeTicket(1, { status: 'closed' });
  const otherEmployee = makeTicket(2, { user: OTHER_EMPLOYEE, status: 'open' });
  const otherTenant = makeTicket(3, { companyId: COMPANY_B, status: 'open' });
  const world = makeWorld({ tickets: [ownClosed, otherEmployee, otherTenant] });

  await expectStatus(world.ticketService.cancelOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: ownClosed.ticketNumber }), 409);
  await expectStatus(world.ticketService.cancelOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: otherEmployee.ticketNumber }), 404);
  await expectStatus(world.ticketService.cancelOwnTicket({ companyId: COMPANY_A, requesterId: REQUESTER, ticketNumber: otherTenant.ticketNumber }), 404);
  assert.equal(world.TicketModel.rows[0].status, 'closed');
  assert.equal(world.TicketModel.rows[1].status, 'open');
  assert.equal(world.TicketModel.rows[2].status, 'open');
  assert.equal(world.TicketModel.calls.findOneAndUpdate.every((call) => call.filter.user === REQUESTER), true);
});

// ── Routes, source boundaries, indexes ─────────────────────────────────────
test('static GET /tickets/mine dispatch target precedes generic ticket-number detail route', () => {
  const routeLayers = helpdeskRouter.stack.filter((layer) => layer.route);
  const mineIndex = routeLayers.findIndex((layer) => layer.route.path === '/tickets/mine' && layer.route.methods.get);
  const detailIndex = routeLayers.findIndex((layer) => layer.route.path === '/tickets/:ticketNumber' && layer.route.methods.get);
  assert.ok(mineIndex >= 0);
  assert.ok(detailIndex >= 0);
  assert.ok(mineIndex < detailIndex);
  assert.equal(routeLayers[mineIndex].route.stack.at(-1).handle, helpdeskController.listMyTickets);
  assert.equal(routeLayers[detailIndex].route.stack.at(-1).handle, helpdeskController.getTicket);
});

test('requester list indexes are partial to Helpdesk and include deterministic sort tie-breakers', () => {
  const indexes = HelpdeskTicket.schema.indexes();
  assert.ok(indexes.some(([keys, options]) =>
    keys.companyId === 1 && keys.user === 1 && keys.createdAt === -1 && keys._id === -1
      && options.partialFilterExpression?.ticketKind === 'HELPDESK',
  ));
  assert.ok(indexes.some(([keys, options]) =>
    keys.companyId === 1 && keys.user === 1 && keys.updatedAt === -1 && keys._id === -1
      && options.partialFilterExpression?.ticketKind === 'HELPDESK',
  ));
});

test('Phase 38.2 code stays isolated from forbidden HR, notification, AI, realtime, and attachment workflows', () => {
  const service = sourceWithoutComments(read('src/services/helpdesk/helpdeskTicketService.js'));
  const controller = sourceWithoutComments(read('src/controllers/helpdeskController.js'));
  const rules = sourceWithoutComments(read('src/services/helpdesk/helpdeskRules.js'));
  const phaseDocs = readRoot('docs/PHASE_38_2_EMPLOYEE_TICKET_LIFECYCLE.md');

  assert.doesNotMatch(service, /Attendance|LeaveModel|Payroll|DepartmentModel|Notification|NATS|socket\.io|socket\.emit|attachment/i);
  assert.doesNotMatch(service, /console\.(log|info|warn|error)|logger\.(info|warn|error)/);
  assert.match(controller, /const companyId = req\.companyId;/);
  assert.match(controller, /const requesterId = req\.user\._id;/);
  assert.doesNotMatch(controller, /companyId\s*=\s*req\.(body|query)|requesterId\s*=\s*req\.(body|query)/);
  assert.match(rules, /Unsupported Helpdesk ticket filter/);
  assert.match(phaseDocs, /No Helpdesk frontend/i);
  assert.match(phaseDocs, /auditTrail/i);
});
