// ═══════════════════════════════════════════════════════════════════════════
// PHASE 38.1 — EMPLOYEE HELPDESK BACKEND FOUNDATION (hermetic)
//
// No live Mongo, Redis, sockets, notifications, or network calls. The real
// rules/services/models/RBAC catalogue run against small in-memory model fakes.
// Structural pins below strip comments before inspecting production source.
// ═══════════════════════════════════════════════════════════════════════════
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  makeFakeHelpdeskFenceModel,
  runFakeHelpdeskTransaction,
} from './helpers/helpdeskTransactions.js';

process.env.NODE_ENV ||= 'test';
process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_helpdesk_test';

const [
  rules,
  queueModule,
  ticketModule,
  configModule,
  numberModule,
  kindModule,
  controllerModule,
  registry,
  permissionService,
  helpdeskTicketModule,
  supportTicketModule,
  helpdeskQueueModelModule,
  helpdeskConfigModelModule,
  helpdeskFenceModelModule,
  mongooseModule,
] = await Promise.all([
  import('../src/services/helpdesk/helpdeskRules.js'),
  import('../src/services/helpdesk/helpdeskQueueService.js'),
  import('../src/services/helpdesk/helpdeskTicketService.js'),
  import('../src/services/helpdesk/helpdeskTenantConfigService.js'),
  import('../src/services/helpdesk/helpdeskTicketNumbers.js'),
  import('../src/utils/supportTicketKinds.js'),
  import('../src/controllers/helpdeskController.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/utils/permissionService.js'),
  import('../src/models/HelpdeskTicket.js'),
  import('../src/models/SupportTicket.js'),
  import('../src/models/HelpdeskQueue.js'),
  import('../src/models/HelpdeskTenantConfig.js'),
  import('../src/models/HelpdeskAuthorizationFence.js'),
  import('mongoose'),
]);

const {
  HELPDESK_PRIORITIES,
  HELPDESK_TICKET_STATUSES,
  HELPDESK_TICKET_TRANSITIONS,
  canTransitionHelpdeskTicket,
  validateHelpdeskTicketCreateInput,
  validateHelpdeskPriority,
  validateHelpdeskStatusTransition,
} = rules;
const { helpdeskQueueService } = queueModule;
const { helpdeskTicketService } = ticketModule;
const { helpdeskTenantConfigService } = configModule;
const { HELPDESK_TICKET_SEQUENCE_KEY, nextHelpdeskTicketNumber } = numberModule;
const { SUPPORT_TICKET_KIND, legacySupportTicketFilter, isLegacySupportTicket } = kindModule;
const { assertHelpdeskPermission } = controllerModule;
const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = registry;
const { getSystemPermissionVersion } = permissionService;
const HelpdeskTicket = helpdeskTicketModule.default;
const SupportTicket = supportTicketModule.default;
const HelpdeskQueue = helpdeskQueueModelModule.default;
const HelpdeskTenantConfig = helpdeskConfigModelModule.default;
const HelpdeskAuthorizationFence = helpdeskFenceModelModule.default;
const mongoose = mongooseModule.default;

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const root = path.join(backendRoot, '..');
const read = (relative) => fs.readFileSync(path.join(backendRoot, relative), 'utf8');
const readRoot = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const oid = (number) => Number(number).toString(16).padStart(24, '0');
const COMPANY_A = oid(100);
const COMPANY_B = oid(200);
const REQUESTER = oid(1);
const AGENT = oid(2);
const RESTRICTED_AGENT = oid(3);
const QUEUE_MANAGER = oid(4);
const CONFIDENTIAL_REVIEWER = oid(5);
const EMPLOYEE = oid(6);
const REPORTING_MANAGER = oid(7);
const OTHER_TENANT_USER = oid(201);
const QUEUE_A = oid(900);
const QUEUE_B = oid(901);
const CATEGORY_A = oid(910);
const CATEGORY_B = oid(911);

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
    if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
      return expected.$in.some((candidate) => norm(actual) === norm(candidate));
    }
    if (Object.prototype.hasOwnProperty.call(expected, '$ne')) {
      return norm(actual) !== norm(expected.$ne);
    }
    if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
      return expected.$exists ? actual !== undefined : actual === undefined;
    }
    if (Object.prototype.hasOwnProperty.call(expected, '$type')) {
      if (expected.$type === 'string') return typeof actual === 'string';
      return true;
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

const clone = (value) => value == null ? value : structuredClone(value);

const query = (resolver) => {
  let leanResult = false;
  let sortSpec = null;
  let skipCount = 0;
  let limitCount = null;
  let selectedFields = null;
  const chain = {
    select(fields) { selectedFields = fields; return chain; },
    sort(spec) { sortSpec = spec; return chain; },
    limit(amount) { limitCount = amount; return chain; },
    skip(amount) { skipCount = amount; return chain; },
    populate() { return chain; },
    lean() { leanResult = true; return chain; },
    then(onFulfilled, onRejected) {
      return Promise.resolve()
        .then(() => resolver({ selectedFields, sortSpec, limitCount }))
        .then((value) => {
          let result = value;
          if (Array.isArray(result)) {
            result = [...result];
            if (sortSpec) {
              const entries = Object.entries(sortSpec);
              result.sort((left, right) => {
                for (const [field, direction] of entries) {
                  const a = getPath(left, field);
                  const b = getPath(right, field);
                  if (a === b) continue;
                  return (a > b ? 1 : -1) * direction;
                }
                return 0;
              });
            }
            result = result.slice(skipCount);
            if (Number.isInteger(limitCount)) result = result.slice(0, limitCount);
          }
          return leanResult ? clone(result) : result;
        })
        .then(onFulfilled, onRejected);
    },
  };
  return chain;
};

const documentFor = (row, persist) => {
  const document = clone(row);
  Object.defineProperty(document, 'save', {
    enumerable: false,
    value: async () => {
      persist(Object.fromEntries(Object.entries(document)));
      return document;
    },
  });
  return document;
};

const makeUserModel = (seed = []) => {
  const rows = seed.map((row) => clone(row));
  const calls = { find: [], findOne: [], selects: [], populates: [] };
  return {
    rows,
    calls,
    find(filter) {
      calls.find.push(clone(filter));
      return query(({ selectedFields }) => {
        if (selectedFields) calls.selects.push(selectedFields);
        return rows.filter((row) => matches(row, filter));
      });
    },
    findOne(filter) {
      calls.findOne.push(clone(filter));
      return query(({ selectedFields }) => {
        if (selectedFields) calls.selects.push(selectedFields);
        return rows.find((row) => matches(row, filter)) || null;
      });
    },
  };
};

const makeQueueModel = () => {
  const rows = [];
  const calls = { find: [], findOne: [], create: [] };
  let nextId = 1000;
  const persist = (row, value) => {
    for (const key of Object.keys(row)) delete row[key];
    Object.assign(row, clone(value));
  };
  const model = {
    rows,
    calls,
    find(filter) {
      calls.find.push(clone(filter));
      return query(() => rows.filter((row) => matches(row, filter)));
    },
    findOne(filter) {
      calls.findOne.push(clone(filter));
      return query(() => {
        const row = rows.find((candidate) => matches(candidate, filter));
        return row ? documentFor(row, (value) => persist(row, value)) : null;
      });
    },
    async create(input) {
      calls.create.push(clone(input));
      if (rows.some((row) => row.companyId === input.companyId && row.nameKey === input.nameKey)) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      const queueId = oid(nextId++);
      const row = {
        _id: queueId,
        description: '',
        enabled: true,
        categories: [],
        agents: [],
        managers: [],
        confidentiality: { enabled: false, agentIds: [], reviewerIds: [] },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...clone(input),
        categories: (input.categories || []).map((category) => ({ _id: oid(nextId++), ...clone(category) })),
      };
      rows.push(row);
      return documentFor(row, (value) => persist(row, value));
    },
  };
  return model;
};

const makeConfigModel = ({ fail = false, seed = [], duplicateFirstUpsert = false } = {}) => {
  const rows = new Map(seed.map((row) => [String(row.companyId), clone(row)]));
  const calls = [];
  let duplicateThrown = false;
  return {
    rows,
    calls,
    fail,
    async findOneAndUpdate(filter, update, options = {}) {
      calls.push({ filter: clone(filter), update: clone(update), options: clone(options) });
      if (fail) throw new Error('database unavailable');
      const key = String(filter.companyId);
      if (duplicateFirstUpsert && options.upsert && !duplicateThrown) {
        duplicateThrown = true;
        rows.set(key, {
          companyId: filter.companyId,
          enabled: false,
          allowEmployeeTickets: true,
          attachmentsEnabled: false,
          confidentialTicketsEnabled: false,
          defaultPriority: 'normal',
        });
        const error = new Error('simulated concurrent tenant config insert');
        error.code = 11000;
        throw error;
      }
      const existing = rows.get(key);
      if (existing) {
        Object.assign(existing, clone(update.$set || {}));
        return clone(existing);
      }
      if (!options.upsert) return null;
      const created = {
        companyId: filter.companyId,
        enabled: false,
        allowEmployeeTickets: true,
        attachmentsEnabled: false,
        confidentialTicketsEnabled: false,
        defaultPriority: 'normal',
        ...clone(update.$setOnInsert || {}),
        ...clone(update.$set || {}),
      };
      rows.set(key, created);
      return clone(created);
    },
  };
};

const makeSequenceModel = ({ duplicateFirstUpsert = false } = {}) => {
  const rows = new Map();
  const calls = [];
  let duplicateThrown = false;
  return {
    rows,
    calls,
    async findOneAndUpdate(filter, update, options = {}) {
      calls.push({ filter: clone(filter), update: clone(update), options: clone(options) });
      const key = `${filter.companyId}:${filter.key}`;
      if (duplicateFirstUpsert && options.upsert && !duplicateThrown) {
        duplicateThrown = true;
        rows.set(key, { companyId: filter.companyId, key: filter.key, value: 0 });
        const error = new Error('simulated concurrent upsert winner');
        error.code = 11000;
        throw error;
      }
      let row = rows.get(key);
      if (!row && options.upsert) {
        row = { companyId: filter.companyId, key: filter.key, value: 0 };
        rows.set(key, row);
      }
      if (!row) return null;
      row.value += update.$inc?.value || 0;
      return clone(row);
    },
  };
};

const makeTicketModel = () => {
  const rows = [];
  const calls = { find: [], findOne: [], findOneAndUpdate: [], create: [] };
  let nextId = 3000;
  const persist = (row, value) => {
    for (const key of Object.keys(row)) delete row[key];
    Object.assign(row, clone(value));
  };
  return {
    rows,
    calls,
    find(filter) {
      calls.find.push(clone(filter));
      return query(() => rows.filter((row) => matches(row, filter)));
    },
    findOne(filter) {
      calls.findOne.push(clone(filter));
      return query(() => {
        const row = rows.find((candidate) => matches(candidate, filter));
        return row ? documentFor(row, (value) => persist(row, value)) : null;
      });
    },
    findOneAndUpdate(filter, update, options = {}) {
      calls.findOneAndUpdate.push({ filter: clone(filter), update: clone(update), options: clone(options) });
      return query(() => {
        const row = rows.find((candidate) => matches(candidate, filter));
        if (!row) return null;
        Object.assign(row, clone(update.$set || {}));
        row.updatedAt = new Date('2026-01-02T00:00:00.000Z');
        return documentFor(row, (value) => persist(row, value));
      });
    },
    async create(input) {
      calls.create.push(clone(input));
      const ticket = {
        _id: oid(nextId++),
        status: 'open',
        priority: 'normal',
        requestedPriority: null,
        assignedTo: null,
        isConfidential: false,
        createdAt: new Date(`2026-01-${String(rows.length + 1).padStart(2, '0')}T00:00:00.000Z`),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...clone(input),
      };
      rows.push(ticket);
      return documentFor(ticket, (value) => persist(ticket, value));
    },
  };
};

const makeUsers = () => makeUserModel([
  { _id: REQUESTER, companyId: COMPANY_A, department: oid(77), reportingTo: REPORTING_MANAGER, status: 'ACTIVE', name: 'Requester', email: 'requester@example.test', salary: 123456 },
  { _id: AGENT, companyId: COMPANY_A, status: 'ACTIVE', name: 'Queue Agent', email: 'agent@example.test', bankAccount: 'secret' },
  { _id: RESTRICTED_AGENT, companyId: COMPANY_A, status: 'ACTIVE', name: 'Restricted Agent', email: 'restricted@example.test' },
  { _id: QUEUE_MANAGER, companyId: COMPANY_A, status: 'ACTIVE', name: 'Queue Manager', email: 'manager@example.test' },
  { _id: CONFIDENTIAL_REVIEWER, companyId: COMPANY_A, status: 'ACTIVE', name: 'Confidential Reviewer', email: 'reviewer@example.test' },
  { _id: EMPLOYEE, companyId: COMPANY_A, status: 'ACTIVE', name: 'Employee', email: 'employee@example.test' },
  { _id: REPORTING_MANAGER, companyId: COMPANY_A, department: oid(77), status: 'ACTIVE', name: 'Reporting Manager', email: 'reporting@example.test' },
  { _id: OTHER_TENANT_USER, companyId: COMPANY_B, status: 'ACTIVE', name: 'Other Tenant', email: 'other@example.test' },
]);

const NOOP_SLA_SERVICE = {
  async initializeTicketSla() { return null; },
  async applyStatusTransition() { return null; },
  async applyPriorityChange() { return null; },
  async applyQueueTransfer() { return null; },
  async stopTicketSla() { return null; },
  async persistFirstResponse() { return { updated: false }; },
};

const makeWorld = (options = {}) => {
  const QueueModel = makeQueueModel();
  const TicketModel = makeTicketModel();
  const UserModel = makeUsers();
  const FenceModel = makeFakeHelpdeskFenceModel();
  const ConfigModel = makeConfigModel();
  const SequenceModel = makeSequenceModel();
  const configService = helpdeskTenantConfigService({ ConfigModel });
  const transactionRunner = runFakeHelpdeskTransaction;
  const queueService = helpdeskQueueService({ QueueModel, UserModel, FenceModel, transactionRunner });
  const ticketService = helpdeskTicketService({
    TicketModel,
    QueueModel,
    UserModel,
    FenceModel,
    transactionRunner,
    ConfigModel,
    SequenceModel,
    configService,
    slaService: NOOP_SLA_SERVICE,
    notificationIntentsEnabled: options.notificationIntentsEnabled,
  });
  return { QueueModel, TicketModel, UserModel, FenceModel, ConfigModel, SequenceModel, configService, queueService, ticketService, transactionRunner };
};

const makeQueueInput = (overrides = {}) => ({
  name: 'People Operations',
  categories: [{ name: 'Access request', description: 'Account access' }],
  agents: [AGENT, RESTRICTED_AGENT],
  managers: [QUEUE_MANAGER],
  confidentiality: {
    enabled: true,
    agentIds: [RESTRICTED_AGENT],
    reviewerIds: [CONFIDENTIAL_REVIEWER],
  },
  ...overrides,
});

const enableHelpdesk = async (world, companyId = COMPANY_A, overrides = {}) =>
  world.configService.updateConfig({
    companyId,
    actorId: QUEUE_MANAGER,
    input: { enabled: true, ...overrides },
  });

const createTicketInput = (queueId, categoryId, overrides = {}) => ({
  queueId,
  categoryId,
  subject: 'Laptop access',
  description: 'Please provision a company laptop account.',
  ...overrides,
});

const sourceWithoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');

const expectStatus = async (promise, statusCode) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode);
    return true;
  });
};

// ── Atomic tenant numbering ────────────────────────────────────────────────
test('ticket numbers allocate atomically per tenant and recover an upsert race', async () => {
  const sequenceModel = makeSequenceModel({ duplicateFirstUpsert: true });
  const numbers = await Promise.all(
    Array.from({ length: 120 }, () => nextHelpdeskTicketNumber(COMPANY_A, { SequenceModel: sequenceModel })),
  );
  assert.equal(new Set(numbers).size, 120);
  assert.deepEqual(
    numbers.map((number) => Number(number.slice(3))).sort((a, b) => a - b),
    Array.from({ length: 120 }, (_, index) => index + 1),
  );
  assert.equal(sequenceModel.rows.get(`${COMPANY_A}:${HELPDESK_TICKET_SEQUENCE_KEY}`).value, 120);
  assert.equal(sequenceModel.calls[0].filter.companyId, COMPANY_A);
  assert.equal(sequenceModel.calls[0].filter.key, HELPDESK_TICKET_SEQUENCE_KEY);
  assert.ok(sequenceModel.calls.some((call) => call.options.upsert !== true && call.update.$inc?.value === 1));

  assert.equal(await nextHelpdeskTicketNumber(COMPANY_B, { SequenceModel: sequenceModel }), 'HD-000001');
  assert.equal(await nextHelpdeskTicketNumber(COMPANY_A, { SequenceModel: sequenceModel }), 'HD-000121');
});

// ── Tenant queues, categories, defaults, and fail-closed configuration ─────
test('Mongo schemas carry explicit fail-closed defaults and tenant/category uniqueness indexes', async () => {
  const companyObjectId = new mongoose.Types.ObjectId(COMPANY_A);
  const config = new HelpdeskTenantConfig({ companyId: companyObjectId });
  assert.equal(config.enabled, false);
  assert.equal(config.allowEmployeeTickets, true);
  assert.equal(config.attachmentsEnabled, false);
  assert.equal(config.confidentialTicketsEnabled, false);
  assert.equal(config.defaultPriority, 'normal');

  const duplicateCategoryQueue = new HelpdeskQueue({
    companyId: companyObjectId,
    name: 'People Operations',
    nameKey: 'people operations',
    categories: [
      { name: 'Access', nameKey: 'access' },
      { name: ' access ', nameKey: 'access' },
    ],
  });
  await assert.rejects(duplicateCategoryQueue.validate(), (error) => Boolean(error.errors['categories.1.nameKey']));

  const queueIndexes = HelpdeskQueue.schema.indexes();
  assert.ok(queueIndexes.some(([keys, options]) =>
    keys.companyId === 1 && keys.nameKey === 1 && options.unique === true,
  ));
  const configIndexes = HelpdeskTenantConfig.schema.indexes();
  assert.ok(configIndexes.some(([keys, options]) => keys.companyId === 1 && options.unique === true));
  const ticketIndexes = HelpdeskTicket.schema.indexes();
  assert.ok(ticketIndexes.some(([keys, options]) =>
    keys.companyId === 1 && keys.ticketNumber === 1 && options.unique === true
      && options.partialFilterExpression?.ticketKind === 'HELPDESK',
  ));
});

test('queue creation is tenant-scoped, normalized, duplicate-safe, and category-local', async () => {
  const world = makeWorld();
  const queueA = await world.queueService.createQueue({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    input: makeQueueInput(),
  });
  assert.equal(queueA.name, 'People Operations');
  assert.equal(queueA.categories.length, 1);
  assert.equal(queueA.categories[0].name, 'Access request');
  assert.equal('companyId' in queueA, false);

  await expectStatus(
    world.queueService.createQueue({
      companyId: COMPANY_A,
      actorId: QUEUE_MANAGER,
      input: makeQueueInput({ name: '  PEOPLE   OPERATIONS ' }),
    }),
    409,
  );

  const queueB = await world.queueService.createQueue({
    companyId: COMPANY_B,
    actorId: OTHER_TENANT_USER,
    input: makeQueueInput({ name: 'People Operations', agents: [], managers: [], confidentiality: { enabled: false } }),
  });
  assert.notEqual(queueA.id, queueB.id);
  assert.equal((await world.queueService.listAvailableQueues({ companyId: COMPANY_A })).length, 1);
  assert.equal((await world.queueService.listAvailableQueues({ companyId: COMPANY_B })).length, 1);
  assert.equal(world.QueueModel.calls.find.at(-1).companyId, COMPANY_B);

  await assert.rejects(
    world.queueService.createQueue({
      companyId: COMPANY_A,
      actorId: QUEUE_MANAGER,
      input: makeQueueInput({ categories: [{ name: 'Payroll' }, { name: ' payroll ' }] }),
    }),
    (error) => error.statusCode === 409,
  );

  await assert.rejects(
    world.queueService.createQueue({
      companyId: COMPANY_A,
      actorId: QUEUE_MANAGER,
      input: makeQueueInput({ agents: [OTHER_TENANT_USER] }),
    }),
    (error) => error.statusCode === 400,
  );

  const disabled = await world.queueService.createQueue({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    input: makeQueueInput({ name: 'Disabled queue', enabled: false }),
  });
  assert.equal(disabled.enabled, false);
  assert.equal((await world.queueService.listAvailableQueues({ companyId: COMPANY_A })).length, 1);
  assert.equal((await world.queueService.listQueues({ companyId: COMPANY_A, includeDisabled: true, administrative: true })).length, 2);
});

test('coordination fence is metadata-only and queue membership changes serialize affected principals in-session', async () => {
  const fenceIndex = HelpdeskAuthorizationFence.schema.indexes().find(([keys, options]) =>
    options.name === 'helpdesk_authorization_fence_unique' && options.unique === true,
  );
  assert.ok(fenceIndex);
  assert.deepEqual(fenceIndex[0], { companyId: 1, queueId: 1, userId: 1 });
  assert.equal(HelpdeskAuthorizationFence.schema.path('agents'), undefined);
  assert.equal(HelpdeskAuthorizationFence.schema.path('managers'), undefined);
  assert.equal(HelpdeskAuthorizationFence.schema.path('activeMembership'), undefined);

  const world = makeWorld();
  const queue = await world.queueService.createQueue({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    input: makeQueueInput(),
  });
  assert.equal(world.FenceModel.rows.size, 0);

  await world.queueService.updateQueue({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    queueId: queue.id,
    input: {
      agents: [RESTRICTED_AGENT, EMPLOYEE],
      managers: [QUEUE_MANAGER, REPORTING_MANAGER],
      confidentiality: {
        enabled: true,
        agentIds: [EMPLOYEE],
        reviewerIds: [CONFIDENTIAL_REVIEWER],
      },
    },
  });

  assert.equal(world.FenceModel.calls.length, 1);
  assert.equal(world.FenceModel.calls[0].hasSession, true);
  const changedPrincipals = world.FenceModel.calls[0].operations.map((operation) => operation.filter.userId).sort();
  assert.deepEqual(changedPrincipals, [AGENT, EMPLOYEE, QUEUE_MANAGER, REPORTING_MANAGER, RESTRICTED_AGENT].sort());
  assert.equal(changedPrincipals.includes(CONFIDENTIAL_REVIEWER), false);
  for (const row of world.FenceModel.rows.values()) {
    assert.deepEqual(Object.keys(row).sort(), ['companyId', 'queueId', 'userId', 'writeVersion']);
    assert.equal(row.writeVersion, 1);
  }
});

test('tenant config persists explicit fail-closed defaults and never crosses tenants', async () => {
  const ConfigModel = makeConfigModel();
  const service = helpdeskTenantConfigService({ ConfigModel });
  const configA = await service.getConfig({ companyId: COMPANY_A });
  const configB = await service.getConfig({ companyId: COMPANY_B });
  assert.equal(configA.enabled, false);
  assert.equal(configA.defaultPriority, 'normal');
  assert.equal(configA.attachmentsEnabled, false);
  assert.equal(configA.confidentialTicketsEnabled, false);
  assert.equal(configB.enabled, false);
  assert.equal(ConfigModel.rows.size, 2);
  assert.deepEqual(ConfigModel.calls.map((call) => call.filter.companyId), [COMPANY_A, COMPANY_B]);

  const updated = await service.updateConfig({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    input: { enabled: true, confidentialTicketsEnabled: true, defaultPriority: 'HIGH' },
  });
  assert.equal(updated.enabled, true);
  assert.equal(updated.defaultPriority, 'high');
  assert.equal((await service.getConfig({ companyId: COMPANY_B })).enabled, false);
  await assert.rejects(
    service.updateConfig({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, input: { companyId: COMPANY_B, enabled: true } }),
    (error) => error.statusCode === 400,
  );

  const racedConfigModel = makeConfigModel({ duplicateFirstUpsert: true });
  const racedConfig = await helpdeskTenantConfigService({ ConfigModel: racedConfigModel }).getConfig({ companyId: COMPANY_A });
  assert.equal(racedConfig.enabled, false);
  assert.equal(racedConfigModel.rows.size, 1);
  assert.equal(racedConfigModel.calls[1].options.upsert, false);

  const failedRead = helpdeskTenantConfigService({ ConfigModel: makeConfigModel({ fail: true }) });
  await expectStatus(failedRead.getConfig({ companyId: COMPANY_A }), 503);
});

test('queue/category disabling and cross-queue category ids reject new tickets; disabled history stays readable', async () => {
  const world = makeWorld();
  await enableHelpdesk(world);
  const queueA = await world.queueService.createQueue({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, input: makeQueueInput({ name: 'Queue A' }) });
  const queueB = await world.queueService.createQueue({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, input: makeQueueInput({ name: 'Queue B', categories: [{ name: 'Different category' }] }) });
  const categoryA = queueA.categories[0].id;
  const categoryB = queueB.categories[0].id;

  await assert.rejects(
    world.ticketService.createTicket({
      companyId: COMPANY_A,
      requesterId: REQUESTER,
      input: createTicketInput(queueA.id, categoryB),
    }),
    (error) => error.statusCode === 400,
  );

  await world.queueService.updateQueue({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    queueId: queueA.id,
    input: { categories: [{ id: categoryA, name: 'Access request', enabled: false }] },
  });
  await assert.rejects(
    world.ticketService.createTicket({
      companyId: COMPANY_A,
      requesterId: REQUESTER,
      input: createTicketInput(queueA.id, categoryA),
    }),
    (error) => error.statusCode === 400,
  );

  const renamedDisabledCategory = await world.queueService.updateQueue({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    queueId: queueA.id,
    input: { categories: [{ id: categoryA, name: 'Access review' }] },
  });
  assert.equal(renamedDisabledCategory.categories[0].enabled, false);
  assert.equal(renamedDisabledCategory.categories[0].description, 'Account access');
  await assert.rejects(
    world.ticketService.createTicket({
      companyId: COMPANY_A,
      requesterId: REQUESTER,
      input: createTicketInput(queueA.id, categoryA),
    }),
    (error) => error.statusCode === 400,
  );

  await world.queueService.updateQueue({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, queueId: queueA.id, input: { enabled: false } });
  await assert.rejects(
    world.ticketService.createTicket({
      companyId: COMPANY_A,
      requesterId: REQUESTER,
      input: createTicketInput(queueA.id, categoryA),
    }),
    (error) => error.statusCode === 400,
  );

  const historical = await world.TicketModel.create({
    companyId: COMPANY_A,
    user: REQUESTER,
    ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
    ticketNumber: 'HD-000099',
    queueId: queueA.id,
    categoryId: categoryA,
    categoryName: 'Access request',
    subject: 'Historical request',
    message: 'Stored before the queue was disabled',
    status: 'open',
    priority: 'normal',
  });
  const returned = await world.ticketService.getTicket({
    companyId: COMPANY_A,
    viewerId: REQUESTER,
    ticketNumber: historical.ticketNumber,
    canReadOwn: true,
  });
  assert.equal(returned.ticketNumber, 'HD-000099');
});

// ── Ticket identity, priority, access policy, and assignment ───────────────
test('ticket create ignores requested urgency for effective priority and rejects all client identity overrides', async () => {
  const world = makeWorld();
  await enableHelpdesk(world, COMPANY_A, { defaultPriority: 'normal' });
  const queue = await world.queueService.createQueue({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, input: makeQueueInput() });
  const categoryId = queue.categories[0].id;
  const created = await world.ticketService.createTicket({
    companyId: COMPANY_A,
    requesterId: REQUESTER,
    input: createTicketInput(queue.id, categoryId, { requestedPriority: 'urgent' }),
  });
  assert.match(created.ticketNumber, /^HD-\d{6,}$/);
  assert.equal(created.requesterId, REQUESTER);
  assert.equal(created.priority, 'normal');
  assert.equal(created.requestedPriority, 'urgent');
  assert.equal(created.status, 'open');
  assert.equal(world.TicketModel.calls.create[0].user, REQUESTER);
  assert.equal(world.TicketModel.calls.create[0].companyId, COMPANY_A);
  assert.equal(world.TicketModel.calls.create[0].ticketKind, 'HELPDESK');

  for (const field of ['companyId', 'company', 'userId', 'user', 'employeeId', 'employee', 'requesterId', 'requester']) {
    assert.throws(
      () => validateHelpdeskTicketCreateInput({ ...createTicketInput(queue.id, categoryId), [field]: REQUESTER }),
      (error) => error.statusCode === 400,
      `${field} must be rejected`,
    );
  }
  assert.throws(
    () => validateHelpdeskTicketCreateInput({ ...createTicketInput(queue.id, categoryId), priority: 'urgent' }),
    (error) => error.statusCode === 400,
  );
});

test('staging service suppression omits deliverable ticket notifications without bypassing transactions or assignment authorization', async () => {
  const world = makeWorld({ notificationIntentsEnabled: false });
  await enableHelpdesk(world);
  const queue = await world.queueService.createQueue({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    input: makeQueueInput(),
  });
  const ticket = await world.ticketService.createTicket({
    companyId: COMPANY_A,
    requesterId: REQUESTER,
    input: createTicketInput(queue.id, queue.categories[0].id),
  });
  const storedTicket = world.TicketModel.rows.find((row) => row.ticketNumber === ticket.ticketNumber);
  assert.equal(storedTicket.notificationSequence, undefined);
  assert.equal(storedTicket.notificationEvents, undefined);

  const assigned = await world.ticketService.assignTicket({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    ticketNumber: ticket.ticketNumber,
    assigneeId: AGENT,
  });
  assert.equal(assigned.assignedTo, AGENT);
  assert.equal(storedTicket.status, 'assigned');
  assert.equal(storedTicket.notificationSequence, undefined);
  assert.equal(storedTicket.notificationEvents, undefined);
});

test('queue requester, agent, manager, reviewer, and confidentiality boundaries are distinct', async () => {
  const world = makeWorld();
  await enableHelpdesk(world, COMPANY_A, { confidentialTicketsEnabled: true });
  const queue = await world.queueService.createQueue({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, input: makeQueueInput() });
  const categoryId = queue.categories[0].id;
  const normal = await world.ticketService.createTicket({
    companyId: COMPANY_A,
    requesterId: REQUESTER,
    input: createTicketInput(queue.id, categoryId, { subject: 'Normal request' }),
  });
  const secret = await world.ticketService.createTicket({
    companyId: COMPANY_A,
    requesterId: REQUESTER,
    input: createTicketInput(queue.id, categoryId, { subject: 'Confidential request', confidential: true }),
  });

  assert.equal((await world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: REQUESTER, ticketNumber: secret.ticketNumber, canReadOwn: true })).confidential, true);
  assert.equal((await world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: AGENT, ticketNumber: normal.ticketNumber, canReadQueue: true })).subject, 'Normal request');
  assert.equal((await world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: QUEUE_MANAGER, ticketNumber: normal.ticketNumber, canReadQueue: true })).subject, 'Normal request');
  assert.equal((await world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: RESTRICTED_AGENT, ticketNumber: secret.ticketNumber, canReadQueue: true })).subject, 'Confidential request');
  assert.equal((await world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: CONFIDENTIAL_REVIEWER, ticketNumber: secret.ticketNumber, canReadQueue: true })).subject, 'Confidential request');

  await expectStatus(
    world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: AGENT, ticketNumber: secret.ticketNumber, canReadQueue: true }),
    404,
  );
  await expectStatus(
    world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: QUEUE_MANAGER, ticketNumber: secret.ticketNumber, canReadQueue: true }),
    404,
  );
  await expectStatus(
    world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: REPORTING_MANAGER, ticketNumber: normal.ticketNumber, canReadQueue: true }),
    404,
  );
  await expectStatus(
    world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: REPORTING_MANAGER, ticketNumber: secret.ticketNumber, canReadQueue: true }),
    404,
  );
  await expectStatus(
    world.ticketService.getTicket({ companyId: COMPANY_B, viewerId: REQUESTER, ticketNumber: secret.ticketNumber, canReadOwn: true }),
    404,
  );

  const managerList = await world.ticketService.listQueueTickets({ companyId: COMPANY_A, viewerId: QUEUE_MANAGER, queueId: queue.id, canReadQueue: true });
  assert.deepEqual(managerList.tickets.map((ticket) => ticket.ticketNumber), [normal.ticketNumber]);
  assert.equal(Object.hasOwn(managerList.meta, 'total'), false);
  const reviewerList = await world.ticketService.listQueueTickets({ companyId: COMPANY_A, viewerId: CONFIDENTIAL_REVIEWER, queueId: queue.id, canReadQueue: true });
  assert.deepEqual(reviewerList.tickets.map((ticket) => ticket.ticketNumber), [secret.ticketNumber]);
  const restrictedAgentList = await world.ticketService.listQueueTickets({ companyId: COMPANY_A, viewerId: RESTRICTED_AGENT, queueId: queue.id, canReadQueue: true });
  assert.equal(restrictedAgentList.tickets.length, 2);
  await expectStatus(
    world.ticketService.listQueueTickets({ companyId: COMPANY_A, viewerId: EMPLOYEE, queueId: queue.id, canReadQueue: true }),
    404,
  );
});

test('employees cannot self-assign; managers may assign only active explicit queue agents', async () => {
  const world = makeWorld();
  await enableHelpdesk(world);
  const queue = await world.queueService.createQueue({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, input: makeQueueInput() });
  const ticket = await world.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: createTicketInput(queue.id, queue.categories[0].id) });

  await expectStatus(
    world.ticketService.assignTicket({ companyId: COMPANY_A, actorId: AGENT, ticketNumber: ticket.ticketNumber, assigneeId: AGENT }),
    404,
  );
  await assert.rejects(
    world.ticketService.assignTicket({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, ticketNumber: ticket.ticketNumber, assigneeId: EMPLOYEE }),
    (error) => error.statusCode === 400,
  );
  const assigned = await world.ticketService.assignTicket({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, ticketNumber: ticket.ticketNumber, assigneeId: AGENT });
  assert.equal(assigned.assignedTo, AGENT);
  assert.equal(assigned.status, 'assigned');
  assert.ok(world.UserModel.calls.selects.includes('_id'));
  assert.equal(world.UserModel.calls.populates.length, 0);
});

test('status and priority enums/defaults and transition graph are centralized in the discriminator', async () => {
  assert.deepEqual(HELPDESK_TICKET_STATUSES, [
    'open', 'assigned', 'in_progress', 'waiting_for_employee', 'waiting_for_department', 'resolved', 'closed', 'cancelled',
  ]);
  assert.deepEqual(HELPDESK_PRIORITIES, ['low', 'normal', 'high', 'urgent']);
  assert.equal(HelpdeskTicket.schema.path('status').defaultValue, 'open');
  assert.equal(HelpdeskTicket.schema.path('priority').defaultValue, 'normal');
  assert.deepEqual(HelpdeskTicket.schema.path('status').enumValues, [...HELPDESK_TICKET_STATUSES]);
  assert.deepEqual(HelpdeskTicket.schema.path('priority').enumValues, [...HELPDESK_PRIORITIES]);
  assert.equal(HelpdeskTicket.schema.path('status').enumValues.includes('WAITING_FOR_CUSTOMER'), false);
  assert.equal(SupportTicket.schema.path('status').enumValues.includes('WAITING_FOR_CUSTOMER'), true);

  for (const status of HELPDESK_TICKET_STATUSES) {
    assert.equal(typeof HELPDESK_TICKET_TRANSITIONS[status], 'object');
    for (const target of HELPDESK_TICKET_TRANSITIONS[status]) {
      assert.equal(canTransitionHelpdeskTicket(status, target), true);
    }
  }
  assert.equal(validateHelpdeskPriority('HIGH'), 'high');
  assert.throws(() => validateHelpdeskPriority('critical'), (error) => error.statusCode === 400);
  assert.equal(validateHelpdeskStatusTransition({ currentStatus: 'open', nextStatus: 'IN_PROGRESS' }), 'in_progress');
  assert.throws(
    () => validateHelpdeskStatusTransition({ currentStatus: 'closed', nextStatus: 'open' }),
    (error) => error.statusCode === 409,
  );
  assert.throws(
    () => validateHelpdeskStatusTransition({ currentStatus: 'open', nextStatus: 'WAITING_FOR_CUSTOMER' }),
    (error) => error.statusCode === 400,
  );
});

// ── Confidentiality, safe DTOs, RBAC and regression boundaries ──────────────
test('confidential access also gates mutations and closed ticket state transitions', async () => {
  const world = makeWorld();
  await enableHelpdesk(world, COMPANY_A, { confidentialTicketsEnabled: true });
  const queue = await world.queueService.createQueue({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, input: makeQueueInput() });
  const ticket = await world.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: createTicketInput(queue.id, queue.categories[0].id, { confidential: true }) });
  await expectStatus(
    world.ticketService.updateStatus({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, ticketNumber: ticket.ticketNumber, status: 'in_progress' }),
    404,
  );
  const updated = await world.ticketService.updateStatus({ companyId: COMPANY_A, actorId: RESTRICTED_AGENT, ticketNumber: ticket.ticketNumber, status: 'in_progress' });
  assert.equal(updated.status, 'in_progress');
  const resolved = await world.ticketService.updateStatus({ companyId: COMPANY_A, actorId: RESTRICTED_AGENT, ticketNumber: ticket.ticketNumber, status: 'resolved' });
  const closed = await world.ticketService.updateStatus({ companyId: COMPANY_A, actorId: RESTRICTED_AGENT, ticketNumber: ticket.ticketNumber, status: 'closed' });
  assert.equal(closed.status, 'closed');
  await expectStatus(
    world.ticketService.updateStatus({ companyId: COMPANY_A, actorId: RESTRICTED_AGENT, ticketNumber: resolved.ticketNumber, status: 'open' }),
    409,
  );
});

test('ticket DTOs expose no populated User/PII fields and ticket numbers are the public identifier', async () => {
  const world = makeWorld();
  await enableHelpdesk(world);
  const queue = await world.queueService.createQueue({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, input: makeQueueInput() });
  const ticket = await world.ticketService.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: createTicketInput(queue.id, queue.categories[0].id) });
  const dto = await world.ticketService.getTicket({ companyId: COMPANY_A, viewerId: REQUESTER, ticketNumber: ticket.ticketNumber, canReadOwn: true });
  assert.equal(dto.ticketNumber, ticket.ticketNumber);
  assert.equal(Object.hasOwn(dto, 'id'), false);
  for (const field of ['name', 'email', 'salary', 'bankAccount', 'aadhaar', 'pan', 'uan', 'address', 'attendancePunches', 'payroll', 'companyId', 'employee']) {
    assert.equal(Object.hasOwn(dto, field), false, `${field} must not be serialized`);
  }
  assert.equal(typeof dto.requesterId, 'string');
  assert.equal(world.UserModel.calls.populates.length, 0);
  assert.ok(world.UserModel.calls.selects.every((select) => select === '_id'));
});

test('config RBAC refuses an unauthorized actor without role-name shortcuts', async () => {
  let permissionChecks = 0;
  await expectStatus(
    assertHelpdeskPermission(
      { _id: EMPLOYEE, role: 'EMPLOYEE', companyId: COMPANY_A },
      'HELPDESK_QUEUE_MANAGE',
      async (user, permission) => {
        permissionChecks += 1;
        assert.equal(user._id, EMPLOYEE);
        assert.equal(permission, 'HELPDESK_QUEUE_MANAGE');
        return false;
      },
    ),
    403,
  );
  assert.equal(permissionChecks, 1);
  await assertHelpdeskPermission(
    { _id: QUEUE_MANAGER, companyId: COMPANY_A },
    'HELPDESK_QUEUE_MANAGE',
    async () => true,
  );

  const employeePermissions = DEFAULT_ROLE_MATRIX.EMPLOYEE;
  const hrPermissions = DEFAULT_ROLE_MATRIX.HR_MANAGER;
  const companyAdminPermissions = DEFAULT_ROLE_MATRIX.COMPANY_ADMIN;
  assert.equal(employeePermissions.includes('HELPDESK_QUEUE_MANAGE'), false);
  assert.equal(employeePermissions.includes('HELPDESK_TICKET_MANAGE'), false);
  assert.equal(employeePermissions.includes('HELPDESK_TICKET_READ'), false);
  assert.equal(employeePermissions.includes('HELPDESK_TICKET_CREATE_SELF'), true);
  assert.equal(employeePermissions.includes('HELPDESK_TICKET_READ_SELF'), true);
  assert.equal(hrPermissions.includes('HELPDESK_QUEUE_MANAGE'), true);
  assert.equal(hrPermissions.includes('HELPDESK_TICKET_READ'), true);
  assert.equal(hrPermissions.includes('HELPDESK_TICKET_MANAGE'), true);
  assert.equal(companyAdminPermissions.includes('HELPDESK_TICKET_MANAGE'), true);
  assert.equal(DEFAULT_PERMISSIONS.some((permission) => permission.name === 'HELPDESK_TICKET_READ'), true);
  assert.equal(getSystemPermissionVersion(), 39);
});

test('legacy/platform ticket readers classify historical rows as legacy and exclude Helpdesk discriminators', () => {
  const filter = legacySupportTicketFilter({ companyId: COMPANY_A });
  const isMatched = (row) => matches(row, filter);
  assert.equal(isLegacySupportTicket({}), true);
  assert.equal(isLegacySupportTicket({ ticketKind: 'LEGACY_SUPPORT' }), true);
  assert.equal(isLegacySupportTicket({ ticketKind: 'HELPDESK' }), false);
  assert.equal(isMatched({ companyId: COMPANY_A }), true);
  assert.equal(isMatched({ companyId: COMPANY_A, ticketKind: 'LEGACY_SUPPORT' }), true);
  assert.equal(isMatched({ companyId: COMPANY_A, ticketKind: 'HELPDESK' }), false);
  assert.equal(isMatched({ companyId: COMPANY_B }), false);

  const legacyConsumers = [
    'src/controllers/platform/supportController.js',
    'src/controllers/platform/superAdminCompanyController.js',
    'src/controllers/platform/superAdminDashboardController.js',
    'src/controllers/platform/superAdminOperationsController.js',
  ];
  for (const file of legacyConsumers) {
    assert.match(sourceWithoutComments(read(file)), /legacySupportTicketFilter/);
  }
});

test('Phase 38.4 conversations and private attachments do not add later-phase integrations', async () => {
  const sourceFiles = [
    'src/models/HelpdeskTicket.js',
    'src/models/HelpdeskQueue.js',
    'src/models/HelpdeskTenantConfig.js',
    'src/models/HelpdeskMessage.js',
    'src/models/HelpdeskAttachment.js',
    'src/services/helpdesk/helpdeskRules.js',
    'src/services/helpdesk/helpdeskQueueService.js',
    'src/services/helpdesk/helpdeskTicketService.js',
    'src/services/helpdesk/helpdeskConversationService.js',
    'src/services/helpdesk/helpdeskAttachmentStorage.js',
    'src/services/helpdesk/helpdeskTenantConfigService.js',
    'src/services/helpdesk/helpdeskTicketNumbers.js',
    'src/controllers/helpdeskController.js',
    'src/routes/helpdeskRoutes.js',
    'src/validators/helpdeskValidator.js',
    'src/middlewares/helpdeskAttachmentUpload.js',
  ];
  const clean = sourceFiles.map((file) => sourceWithoutComments(read(file))).join('\n');
  assert.doesNotMatch(clean, /from\s+['"][^'"]*(?:attendance|leave|payroll|ai|nats|socket|realtime|(?<!helpdesk)notification)[^'"]*['"]/i);
  assert.doesNotMatch(clean, /\b(?:Attendance|Leave|Payroll|AI|NATS|Socket|Realtime|Notification)(?:Model|Service|Gateway)?\.(?:create|updateOne|findOneAndUpdate|emit|publish)\s*\(/i);
  assert.doesNotMatch(clean, /\bconsole\s*\.\s*(?:log|info|warn|error|debug)\s*\(/i);
  assert.doesNotMatch(clean, /\.populate\s*\(/);
  assert.match(clean, /\/tickets\/:ticketNumber\/messages/);
  assert.match(clean, /\/tickets\/:ticketNumber\/attachments\/:attachmentId\/download/);

  const forbiddenWrites = { attendance: 0, leave: 0, payroll: 0 };
  const sentinel = (key) => ({
    async create() { forbiddenWrites[key] += 1; throw new Error(`${key} must not be written`); },
    async updateOne() { forbiddenWrites[key] += 1; throw new Error(`${key} must not be written`); },
    async findOneAndUpdate() { forbiddenWrites[key] += 1; throw new Error(`${key} must not be written`); },
  });
  const world = makeWorld();
  await enableHelpdesk(world);
  const queue = await world.queueService.createQueue({ companyId: COMPANY_A, actorId: QUEUE_MANAGER, input: makeQueueInput() });
  const service = helpdeskTicketService({
    TicketModel: world.TicketModel,
    QueueModel: world.QueueModel,
    UserModel: world.UserModel,
    FenceModel: world.FenceModel,
    transactionRunner: world.transactionRunner,
    ConfigModel: world.ConfigModel,
    SequenceModel: world.SequenceModel,
    configService: world.configService,
    slaService: NOOP_SLA_SERVICE,
    AttendanceModel: sentinel('attendance'),
    LeaveModel: sentinel('leave'),
    PayrollModel: sentinel('payroll'),
  });
  const ticket = await service.createTicket({ companyId: COMPANY_A, requesterId: REQUESTER, input: createTicketInput(queue.id, queue.categories[0].id) });
  await service.updateStatus({ companyId: COMPANY_A, actorId: AGENT, ticketNumber: ticket.ticketNumber, status: 'in_progress' });
  assert.deepEqual(forbiddenWrites, { attendance: 0, leave: 0, payroll: 0 });
});

test('source uses the approved shared store, atomic numbering, tenant filters, and RBAC route gates', () => {
  const source = sourceFilesForBoundary();
  assert.match(sourceWithoutComments(source.model), /discriminator\s*\(/);
  assert.match(sourceWithoutComments(source.ticketService), /ticketKind:\s*SUPPORT_TICKET_KIND\.HELPDESK/);
  assert.match(sourceWithoutComments(source.ticketService), /companyId/);
  assert.match(sourceWithoutComments(source.numbers), /findOneAndUpdate/);
  assert.doesNotMatch(sourceWithoutComments(source.numbers), /countDocuments\s*\(/);
  assert.match(sourceWithoutComments(source.routes), /requirePermission\(['"]HELPDESK_QUEUE_MANAGE['"]\)/);
  assert.match(sourceWithoutComments(source.routes), /requirePermission\(['"]HELPDESK_TICKET_MANAGE['"]\)/);
  assert.match(sourceWithoutComments(source.routes), /HELPDESK_TICKET_CREATE_SELF/);
  assert.match(sourceWithoutComments(source.controller), /assertHelpdeskPermission\(req\.user,\s*'HELPDESK_QUEUE_MANAGE'/);
  assert.match(sourceWithoutComments(source.validator), /FORBIDDEN_IDENTITY_FIELDS/);
  assert.match(sourceWithoutComments(read('src/models/HelpdeskQueue.js')), /helpdesk_queue_name_unique_by_tenant/);
  assert.match(sourceWithoutComments(read('src/models/HelpdeskTicket.js')), /helpdesk_ticket_number_unique_by_tenant/);
  assert.match(readRoot('docs/PHASE_38_PROFILE_CHANGE_REQUESTS.md'), /PROFILE CHANGE/i);
});

function sourceFilesForBoundary() {
  return {
    model: read('src/models/HelpdeskTicket.js'),
    ticketService: read('src/services/helpdesk/helpdeskTicketService.js'),
    numbers: read('src/services/helpdesk/helpdeskTicketNumbers.js'),
    routes: read('src/routes/helpdeskRoutes.js'),
    controller: read('src/controllers/helpdeskController.js'),
    validator: read('src/validators/helpdeskValidator.js'),
  };
}
