import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  makeFakeHelpdeskFenceModel,
  makeHelpdeskFenceRaceHarness,
} from './helpers/helpdeskTransactions.js';

process.env.NODE_ENV ||= 'test';
process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_helpdesk_conversations_test';

const [
  conversationModule,
  queueServiceModule,
  rulesModule,
  fileRulesModule,
  storageModule,
  messageModelModule,
  attachmentModelModule,
  ticketModelModule,
  validatorModule,
  routeModule,
  controllerModule,
  uploadMiddlewareModule,
  auditModule,
  auditServiceModule,
  auditLogModule,
  supportKindsModule,
] = await Promise.all([
  import('../src/services/helpdesk/helpdeskConversationService.js'),
  import('../src/services/helpdesk/helpdeskQueueService.js'),
  import('../src/services/helpdesk/helpdeskRules.js'),
  import('../src/services/helpdesk/helpdeskFileRules.js'),
  import('../src/services/helpdesk/helpdeskAttachmentStorage.js'),
  import('../src/models/HelpdeskMessage.js'),
  import('../src/models/HelpdeskAttachment.js'),
  import('../src/models/HelpdeskTicket.js'),
  import('../src/validators/helpdeskValidator.js'),
  import('../src/routes/helpdeskRoutes.js'),
  import('../src/controllers/helpdeskController.js'),
  import('../src/middlewares/helpdeskAttachmentUpload.js'),
  import('../src/middlewares/auditTrail.js'),
  import('../src/utils/securityauditService.js'),
  import('../src/models/AuditLog.js'),
  import('../src/utils/supportTicketKinds.js'),
]);

const { helpdeskConversationService } = conversationModule;
const { helpdeskQueueService } = queueServiceModule;
const {
  decodeHelpdeskMessageCursor,
  HELPDESK_MESSAGE_BODY_MAX,
} = rulesModule;
const {
  assertAllowedHelpdeskAttachment,
  buildHelpdeskAttachmentStorageKey,
  HELPDESK_ATTACHMENT_MAX_BYTES,
} = fileRulesModule;
const {
  destroyHelpdeskAttachment,
  planHelpdeskAttachmentStorage,
  resolveHelpdeskAttachmentDelivery,
  storeHelpdeskAttachment,
} = storageModule;
const HelpdeskMessage = messageModelModule.default;
const HelpdeskAttachment = attachmentModelModule.default;
const HelpdeskTicket = ticketModelModule.default;
const {
  helpdeskAttachmentIdParamValidator,
  helpdeskAttachmentMessageValidator,
  helpdeskMessageCreateValidator,
  helpdeskMessageHistoryQueryValidator,
} = validatorModule;
const helpdeskRouter = routeModule.default;
const helpdeskController = controllerModule.default;
const { helpdeskAttachmentUpload } = uploadMiddlewareModule;
const { auditTrail } = auditModule;
const { recordAudit } = auditServiceModule;
const AuditLog = auditLogModule.default;
const { SUPPORT_TICKET_KIND } = supportKindsModule;

const oid = (number) => Number(number).toString(16).padStart(24, '0');
const COMPANY_A = oid(100);
const COMPANY_B = oid(200);
const REQUESTER = oid(1);
const AGENT = oid(2);
const CONFIDENTIAL_AGENT = oid(3);
const REVIEWER = oid(4);
const QUEUE_MANAGER = oid(5);
const OUTSIDER = oid(6);
const TICKET_ID = oid(300);
const OTHER_TICKET_ID = oid(301);
const QUEUE_ID = oid(400);
const FOREIGN_QUEUE_ID = oid(401);
const TICKET_NUMBER = 'HD-000042';
const OTHER_TICKET_NUMBER = 'HD-000043';
const PDF_BYTES = Buffer.from('%PDF-1.7\nCrewly Helpdesk test document\n%%EOF\n');
const NOOP_SLA_SERVICE = {
  async persistFirstResponse() { return { updated: false }; },
};

const clone = (value) => {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value instanceof mongoose.Types.ObjectId) return new mongoose.Types.ObjectId(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(clone);
  const result = {};
  for (const [key, entry] of Object.entries(value)) result[key] = clone(entry);
  return result;
};

const idOf = (value) => {
  if (value && typeof value === 'object' && typeof value.toHexString === 'function') return value.toHexString();
  if (value && typeof value === 'object' && value._id !== undefined) return idOf(value._id);
  return String(value ?? '');
};

const getPath = (value, dottedPath) => String(dottedPath).split('.').reduce(
  (current, part) => current == null ? undefined : current[part],
  value,
);

const compare = (left, right) => {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : 1;
};

const matchesValue = (actual, expected) => {
  if (expected instanceof RegExp) return expected.test(String(actual ?? ''));
  const isExpression = expected
    && typeof expected === 'object'
    && !(expected instanceof Date)
    && !Buffer.isBuffer(expected)
    && Object.getPrototypeOf(expected) === Object.prototype
    && Object.keys(expected).some((key) => key.startsWith('$'));
  if (isExpression) {
    return Object.entries(expected).every(([operator, operand]) => {
      if (operator === '$in') {
        const values = Array.isArray(actual) ? actual : [actual];
        return values.some((value) => operand.some((candidate) => matchesValue(value, candidate)));
      }
      if (operator === '$ne') return !matchesValue(actual, operand);
      if (operator === '$exists') return operand ? actual !== undefined : actual === undefined;
      if (operator === '$lt') return compare(actual, operand) < 0;
      if (operator === '$lte') return compare(actual, operand) <= 0;
      if (operator === '$gt') return compare(actual, operand) > 0;
      if (operator === '$gte') return compare(actual, operand) >= 0;
      if (operator === '$type') return operand === 'string' ? typeof actual === 'string' : true;
      return false;
    });
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
  const selected = typeof fields === 'string'
    ? fields.split(/\s+/).filter((field) => field && !field.startsWith('-')).map((field) => field.replace(/^\+/, ''))
    : Object.entries(fields).filter(([, included]) => included === 1).map(([field]) => field);
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

const makeQuery = (resolver, initialProjection = null) => {
  let projection = initialProjection;
  let sortSpec = null;
  let limitCount = null;
  const chain = {
    select(fields) { projection = fields; return chain; },
    sort(spec) { sortSpec = spec; return chain; },
    limit(amount) { limitCount = amount; return chain; },
    lean() { return chain; },
    then(onFulfilled, onRejected) {
      return Promise.resolve()
        .then(() => resolver({ projection, sortSpec, limitCount }))
        .then((value) => {
          let result = value;
          if (Array.isArray(result)) {
            result = [...result];
            if (sortSpec) {
              result.sort((left, right) => {
                for (const [field, direction] of Object.entries(sortSpec)) {
                  const compared = compare(getPath(left, field), getPath(right, field));
                  if (compared) return compared * direction;
                }
                return 0;
              });
            }
            if (Number.isInteger(limitCount)) result = result.slice(0, limitCount);
          }
          return clone(project(result, projection));
        })
        .then(onFulfilled, onRejected);
    },
  };
  return chain;
};

const makeTicket = (overrides = {}) => ({
  _id: TICKET_ID,
  companyId: COMPANY_A,
  ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
  user: REQUESTER,
  ticketNumber: TICKET_NUMBER,
  queueId: QUEUE_ID,
  status: 'open',
  isConfidential: false,
  lastMessageSequence: 0,
  lastPublicMessageSequence: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...clone(overrides),
});

const makeQueue = (overrides = {}) => ({
  _id: QUEUE_ID,
  companyId: COMPANY_A,
  agents: [AGENT, CONFIDENTIAL_AGENT],
  managers: [QUEUE_MANAGER],
  confidentiality: {
    enabled: true,
    agentIds: [CONFIDENTIAL_AGENT],
    reviewerIds: [REVIEWER],
  },
  ...clone(overrides),
});

const restoreRows = (target, snapshot) => {
  while (target.length > snapshot.length) target.pop();
  snapshot.forEach((value, index) => {
    if (target[index] && typeof target[index] === 'object' && !Array.isArray(target[index])) {
      for (const key of Object.keys(target[index])) delete target[index][key];
      Object.assign(target[index], clone(value));
    } else {
      target[index] = clone(value);
    }
  });
};

const makeWorld = (options = {}) => {
  const state = {
    ticket: makeTicket(options.ticket),
    tickets: options.tickets ? options.tickets.map(clone) : null,
    queue: makeQueue(options.queue),
    queues: options.queues ? options.queues.map(clone) : null,
    messages: [],
    attachments: [],
    users: [
      { _id: REQUESTER, companyId: COMPANY_A, name: 'Riya Requester', email: 'requester@example.invalid', phone: '111111' },
      { _id: AGENT, companyId: COMPANY_A, name: 'Arun Support', email: 'agent@example.invalid', phone: '222222' },
      { _id: CONFIDENTIAL_AGENT, companyId: COMPANY_A, name: 'Maya Restricted', email: 'restricted@example.invalid' },
      { _id: REVIEWER, companyId: COMPANY_A, name: 'Lee Reviewer', email: 'reviewer@example.invalid' },
    ],
    attachmentsEnabled: options.attachmentsEnabled !== false,
    stored: new Map(),
    storeCalls: [],
    destroyCalls: [],
    ticketFindOneCalls: [],
    ticketUpdateCalls: [],
    messageFindCalls: [],
    messageFindOneCalls: [],
    attachmentFindCalls: [],
    attachmentFindOneCalls: [],
    userFindCalls: [],
    messageCreateMode: null,
    transactionUnknownMode: null,
    failNextMessageLookup: false,
    attachmentCreateMode: null,
    failActivation: false,
    failAttachmentDelete: false,
    destroyFails: false,
    storeFails: false,
    afterStore: null,
    nowMs: Date.now(),
  };
  const ticketRows = state.tickets || [state.ticket];
  const queueRows = state.queues || [state.queue];
  const FenceModel = options.FenceModel || makeFakeHelpdeskFenceModel();
  const defaultTransactionRunner = async (work) => {
    const snapshots = {
      tickets: ticketRows.map(clone),
      messages: state.messages.map(clone),
      attachments: state.attachments.map(clone),
      fences: new Map([...FenceModel.rows].map(([key, row]) => [key, clone(row)])),
    };
    try {
      const result = await work({ id: 'fake-helpdesk-session' });
      const unknownMode = state.transactionUnknownMode;
      if (unknownMode) {
        state.transactionUnknownMode = null;
        if (unknownMode === 'aborted') {
          restoreRows(ticketRows, snapshots.tickets);
          restoreRows(state.messages, snapshots.messages);
          restoreRows(state.attachments, snapshots.attachments);
          FenceModel.rows.clear();
          for (const [key, row] of snapshots.fences) FenceModel.rows.set(key, clone(row));
          state.failNextMessageLookup = true;
        }
        const error = new Error('simulated unknown transaction commit result');
        error.statusCode = 503;
        error.commitOutcomeUnknown = true;
        throw error;
      }
      return result;
    } catch (error) {
      if (error?.commitOutcomeUnknown === true) throw error;
      restoreRows(ticketRows, snapshots.tickets);
      restoreRows(state.messages, snapshots.messages);
      restoreRows(state.attachments, snapshots.attachments);
      FenceModel.rows.clear();
      for (const [key, row] of snapshots.fences) FenceModel.rows.set(key, clone(row));
      throw error;
    }
  };
  const transactionRunner = options.transactionRunner || defaultTransactionRunner;

  const TicketModel = {
    rows: ticketRows,
    findOne(filter) {
      state.ticketFindOneCalls.push(clone(filter));
      return makeQuery(() => ticketRows.find((row) => matches(row, filter)) || null);
    },
    findOneAndUpdate(filter, update, queryOptions = {}) {
      const { session, ...recordedOptions } = queryOptions;
      state.ticketUpdateCalls.push({
        filter: clone(filter),
        update: clone(update),
        options: clone(recordedOptions),
        hasSession: Boolean(session),
      });
      return makeQuery(() => {
        const row = ticketRows.find((candidate) => matches(candidate, filter));
        if (!row) return null;
        for (const [field, amount] of Object.entries(update.$inc || {})) {
          row[field] = Number(row[field] || 0) + amount;
        }
        for (const [field, value] of Object.entries(update.$set || {})) row[field] = clone(value);
        row.updatedAt = new Date(row.updatedAt.getTime() + 1);
        return clone(row);
      }, queryOptions.projection || null);
    },
  };

  const QueueModel = {
    rows: queueRows,
    findOne(filter) {
      return makeQuery(() => queueRows.find((row) => matches(row, filter)) || null);
    },
  };

  const MessageModel = {
    rows: state.messages,
    find(filter) {
      const call = { filter: clone(filter), projection: null, sort: null, limit: null };
      state.messageFindCalls.push(call);
      return makeQuery(({ projection, sortSpec, limitCount }) => {
        Object.assign(call, { projection, sort: sortSpec, limit: limitCount });
        return state.messages.filter((row) => matches(row, filter));
      });
    },
    findOne(filter) {
      const call = { filter: clone(filter), projection: null };
      state.messageFindOneCalls.push(call);
      return makeQuery(() => {
        call.projection = true;
        if (state.failNextMessageLookup) {
          state.failNextMessageLookup = false;
          throw new Error('temporary database verification error');
        }
        return state.messages.find((row) => matches(row, filter)) || null;
      });
    },
    async create(input) {
      if (state.messageCreateMode === 'fail_before') throw new Error('simulated Mongo create failure');
      const docs = Array.isArray(input) ? input : [input];
      const createdRows = docs.map((payload) => ({
        ...clone(payload),
        createdAt: new Date(Date.now() + state.messages.length),
        updatedAt: new Date(Date.now() + state.messages.length),
      }));
      state.messages.push(...createdRows);
      if (state.messageCreateMode === 'commit_then_throw') {
        state.messageCreateMode = null;
        throw new Error('simulated ambiguous Mongo acknowledgement');
      }
      return Array.isArray(input) ? createdRows.map(clone) : clone(createdRows[0]);
    },
  };

  const AttachmentModel = {
    rows: state.attachments,
    find(filter) {
      const call = { filter: clone(filter), projection: null, sort: null, limit: null };
      state.attachmentFindCalls.push(call);
      return makeQuery(({ projection, sortSpec, limitCount }) => {
        Object.assign(call, { projection, sort: sortSpec, limit: limitCount });
        return state.attachments.filter((row) => matches(row, filter));
      });
    },
    findOne(filter) {
      const call = { filter: clone(filter), projection: null };
      state.attachmentFindOneCalls.push(call);
      return makeQuery(({ projection }) => {
        call.projection = projection;
        return state.attachments.find((row) => matches(row, filter)) || null;
      });
    },
    async create(payload) {
      if (state.attachmentCreateMode === 'fail_before') throw new Error('simulated attachment Mongo failure');
      const row = {
        ...clone(payload),
        createdAt: new Date(Date.now() + state.attachments.length),
        updatedAt: new Date(Date.now() + state.attachments.length),
      };
      state.attachments.push(row);
      return clone(row);
    },
    async updateOne(filter, update) {
      if (state.failActivation && update.$set?.persistenceStatus === 'ACTIVE') {
        throw new Error('simulated activation write failure');
      }
      const row = state.attachments.find((candidate) => matches(candidate, filter));
      if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, n: 0 };
      Object.assign(row, clone(update.$set || {}));
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, n: 1 };
    },
    async deleteOne(filter) {
      if (state.failAttachmentDelete) throw new Error('simulated attachment delete failure');
      const index = state.attachments.findIndex((row) => matches(row, filter));
      if (index < 0) return { acknowledged: true, deletedCount: 0 };
      state.attachments.splice(index, 1);
      return { acknowledged: true, deletedCount: 1 };
    },
  };

  const UserModel = {
    find(filter) {
      const call = { filter: clone(filter), projection: null };
      state.userFindCalls.push(call);
      return makeQuery(({ projection }) => {
        call.projection = projection;
        return state.users.filter((row) => matches(row, filter));
      });
    },
  };

  const configService = {
    async getConfig({ companyId }) {
      assert.equal(idOf(companyId), COMPANY_A);
      return { attachmentsEnabled: state.attachmentsEnabled };
    },
  };

  const service = helpdeskConversationService({
    TicketModel,
    QueueModel,
    FenceModel,
    transactionRunner,
    MessageModel,
    AttachmentModel,
    UserModel,
    configService,
    slaService: NOOP_SLA_SERVICE,
    notificationIntentsEnabled: options.notificationIntentsEnabled,
    planAttachmentStorage: ({ companyId, ticketId, attachmentId }) => ({
      storageProvider: 'CLOUDINARY_AUTHENTICATED',
      storageKey: buildHelpdeskAttachmentStorageKey({ companyId, ticketId, attachmentId }),
    }),
    storeAttachment: async (input) => {
      const { buffer, storageProvider, storageKey } = input;
      state.storeCalls.push({ ...input, buffer: Buffer.from(buffer) });
      if (state.storeFails) throw new Error('simulated provider credential or host failure');
      state.stored.set(storageKey, Buffer.from(buffer));
      if (state.afterStore) {
        const callback = state.afterStore;
        state.afterStore = null;
        await callback(state);
      }
      return { storageProvider, storageKey };
    },
    destroyAttachment: async (input) => {
      state.destroyCalls.push(clone(input));
      if (state.destroyFails) return false;
      state.stored.delete(input.storageKey);
      return true;
    },
    deliverAttachment: async ({ attachment }) => ({
      bytes: Buffer.from(state.stored.get(attachment.storageKey) || Buffer.alloc(0)),
      contentType: attachment.mimeType,
      fileName: attachment.originalFileName,
    }),
    now: () => state.nowMs,
  });

  return { state, TicketModel, QueueModel, FenceModel, transactionRunner, MessageModel, AttachmentModel, UserModel, service };
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

const requester = (world, extra = {}) => ({
  companyId: COMPANY_A,
  actorId: REQUESTER,
  actorDisplayName: 'Riya Requester',
  ticketNumber: TICKET_NUMBER,
  canReadOwn: true,
  canReadQueue: false,
  canManage: false,
  ...extra,
});

const agent = (world, extra = {}) => ({
  companyId: COMPANY_A,
  actorId: AGENT,
  actorDisplayName: 'Arun Support',
  ticketNumber: TICKET_NUMBER,
  canReadOwn: false,
  canReadQueue: true,
  canManage: true,
  ...extra,
});

const attachFile = (overrides = {}) => ({
  originalname: '../payroll/private-record.pdf',
  mimetype: 'application/pdf',
  buffer: Buffer.from(PDF_BYTES),
  ...overrides,
});

const runAgentConversationRevocationRace = async ({ messageType = 'public', attachment = false } = {}) => {
  const FenceModel = makeFakeHelpdeskFenceModel();
  const fenceRace = makeHelpdeskFenceRaceHarness({
    FenceModel,
    pauseWhen: ({ operations, session }) => session.id.endsWith('-1')
      && operations.some((operation) => operation.updateOne.filter.userId === AGENT),
  });
  const world = makeWorld({ FenceModel, transactionRunner: fenceRace.transactionRunner });
  for (const user of world.state.users) user.status = 'ACTIVE';
  world.state.users.push({ _id: QUEUE_MANAGER, companyId: COMPANY_A, name: 'Queue Manager', status: 'ACTIVE' });
  attachQueueSaveSupport(world.QueueModel);
  const queueService = helpdeskQueueService({
    QueueModel: world.QueueModel,
    UserModel: world.UserModel,
    FenceModel,
    transactionRunner: fenceRace.transactionRunner,
  });
  const input = agent(world, {
    messageType,
    body: attachment ? 'A restricted file' : 'Agent response',
    ...(attachment ? { file: attachFile() } : {}),
  });
  const protectedWrite = attachment
    ? world.service.createMessageWithAttachment(input)
    : world.service.createMessage(input);
  await fenceRace.waitForPausedWrite();

  await queueService.updateQueue({
    companyId: COMPANY_A,
    actorId: QUEUE_MANAGER,
    queueId: QUEUE_ID,
    input: { agents: [CONFIDENTIAL_AGENT] },
  });
  fenceRace.releasePausedWrite();
  await assert.rejects(protectedWrite, (error) => error.statusCode === 404);

  assert.equal(world.state.messages.length, 0);
  assert.equal(world.state.ticket.lastMessageSequence, 0);
  assert.equal(world.state.ticket.lastPublicMessageSequence, 0);
  assert.deepEqual(world.QueueModel.rows[0].agents, [CONFIDENTIAL_AGENT]);
  const sharedPrincipalAttempts = fenceRace.raceAttempts.filter((attempt) =>
    attempt.operations.some((operation) => operation.filter.userId === AGENT),
  );
  assert.equal(sharedPrincipalAttempts.length, 2);
  assert.equal(FenceModel.rows.get(`${COMPANY_A}:${QUEUE_ID}:${AGENT}`).writeVersion, 1);
  assert.equal(fenceRace.transactionCount, 3);
  if (attachment) {
    assert.equal(world.state.attachments.length, 0);
    assert.equal(world.state.stored.size, 0);
    assert.equal(world.state.destroyCalls.length, 1);
  }
  return { world, fenceRace, FenceModel };
};

const runValidatorStack = async (stack, req) => {
  for (const middleware of stack) {
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

test('Helpdesk message and attachment schemas enforce immutable metadata, private keys, bounded indexes, and no Mongo file bytes', () => {
  assert.equal(HelpdeskMessage.schema.path('body').options.immutable, true);
  assert.equal(HelpdeskMessage.schema.path('authorUserId').options.immutable, true);
  assert.equal(HelpdeskMessage.schema.path('sequence').options.immutable, true);
  assert.equal(HelpdeskMessage.schema.path('messageType').options.immutable, true);
  assert.equal(HelpdeskMessage.schema.path('publicSequence').options.immutable, true);
  assert.equal(HelpdeskMessage.schema.path('buffer'), undefined);
  assert.ok(HelpdeskMessage.schema.indexes().some(([index, options]) =>
    index.companyId === 1 && index.ticketId === 1 && index.sequence === 1 && options.unique === true));
  assert.ok(HelpdeskMessage.schema.indexes().some(([index, options]) =>
    index.companyId === 1 && index.ticketId === 1 && index.publicSequence === 1 && options.unique === true));

  assert.equal(HelpdeskAttachment.schema.path('storageKey').options.select, false);
  assert.equal(HelpdeskAttachment.schema.path('checksumSha256').options.select, false);
  assert.equal(HelpdeskAttachment.schema.path('storageKey').options.immutable, true);
  assert.equal(HelpdeskAttachment.schema.path('persistenceStatus').options.default, 'UPLOADING');
  assert.equal(HelpdeskAttachment.schema.path('buffer'), undefined);
  assert.ok(HelpdeskAttachment.schema.indexes().some(([index, options]) =>
    options.name === 'helpdesk_attachment_message_unique' && options.unique === true));
  assert.ok(HelpdeskAttachment.schema.indexes().some(([index, options]) =>
    options.name === 'helpdesk_attachment_commit_recovery'));

  assert.equal(HelpdeskTicket.schema.path('lastMessageSequence').options.default, 0);
  assert.equal(HelpdeskTicket.schema.path('lastPublicMessageSequence').options.default, 0);
});

test('staging conversation suppression persists authorized public messages without a deliverable notification entry', async () => {
  const world = makeWorld({ notificationIntentsEnabled: false });
  const saved = await world.service.createMessage(requester(world, { body: 'Disposable harness reply.' }));

  assert.equal(saved.body, 'Disposable harness reply.');
  assert.equal(world.state.messages.length, 1);
  assert.equal(world.state.messages[0].sequence, 1);
  assert.equal(world.state.messages[0].publicSequence, 1);
  assert.equal(world.state.messages[0].notificationState, 'NOT_REQUIRED');
  assert.equal(world.state.ticket.lastMessageSequence, 1);
  assert.equal(world.state.ticket.lastPublicMessageSequence, 1);
});

test('message bodies are plain text, bounded, and server-authored; employee and reviewer history never includes internal notes', async () => {
  const world = makeWorld();
  const publicOne = await world.service.createMessage(requester(world, { body: '  Reset\r\nmy access  ' }));
  const internal = await world.service.createMessage(agent(world, { body: 'Check the identity file.', messageType: 'internal' }));
  const publicTwo = await world.service.createMessage(requester(world, { body: 'Thanks, it works.' }));

  assert.equal(publicOne.body, 'Reset\nmy access');
  assert.equal(publicOne.messageType, 'public');
  assert.equal(publicOne.author.type, 'requester');
  assert.equal(publicOne.author.displayName, 'Riya Requester');
  assert.equal(internal.messageType, 'internal');
  assert.equal(internal.author.type, 'support');
  assert.equal(publicTwo.body, 'Thanks, it works.');
  assert.equal(world.state.ticket.lastMessageSequence, 3);
  assert.equal(world.state.ticket.lastPublicMessageSequence, 2);

  const requesterPage = await world.service.listMessages({
    companyId: COMPANY_A,
    actorId: REQUESTER,
    ticketNumber: TICKET_NUMBER,
    canReadOwn: true,
    query: { limit: 1 },
  });
  assert.equal(requesterPage.messages.length, 1);
  assert.equal(requesterPage.messages[0].body, 'Thanks, it works.');
  assert.equal(requesterPage.messages[0].messageType, 'public');
  assert.equal(requesterPage.meta.hasMore, true);
  assert.equal(decodeHelpdeskMessageCursor(requesterPage.meta.nextCursor), 2);
  assert.doesNotMatch(JSON.stringify(requesterPage), /Check the identity file/);
  assert.doesNotMatch(JSON.stringify(requesterPage), /companyId|authorUserId|storageKey|checksumSha256|email|phone/);

  const requesterNext = await world.service.listMessages({
    companyId: COMPANY_A,
    actorId: REQUESTER,
    ticketNumber: TICKET_NUMBER,
    canReadOwn: true,
    query: { limit: 1, cursor: requesterPage.meta.nextCursor },
  });
  assert.deepEqual(requesterNext.messages.map((message) => message.body), ['Reset\nmy access']);
  assert.equal(requesterNext.meta.nextCursor, null);

  const staffPage = await world.service.listMessages({
    companyId: COMPANY_A,
    actorId: AGENT,
    ticketNumber: TICKET_NUMBER,
    canReadQueue: true,
    query: { limit: 2 },
  });
  assert.deepEqual(staffPage.messages.map((message) => message.messageType), ['public', 'internal']);
  assert.equal(staffPage.messages[1].body, 'Check the identity file.');
  assert.ok(world.state.messageFindCalls.every((call) => call.limit <= 101));
  const employeeQuery = world.state.messageFindCalls.find((call) => call.filter.messageType === 'PUBLIC');
  assert.equal(employeeQuery.filter.companyId, COMPANY_A);
  assert.equal(idOf(employeeQuery.filter.ticketId), TICKET_ID);
  assert.equal(employeeQuery.sort.publicSequence, -1);
  assert.ok(world.state.userFindCalls.every((call) => call.projection === '_id name'));
});

test('invalid bodies, client identity fields, unsupported history filters, and terminal ticket comments fail closed', async () => {
  const world = makeWorld();
  await assert.rejects(
    () => world.service.createMessage(requester(world, { body: '  \n\t  ' })),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    () => world.service.createMessage(requester(world, { body: 'x'.repeat(HELPDESK_MESSAGE_BODY_MAX + 1) })),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    () => world.service.createMessage(requester(world, { body: 'spoof', actorId: OUTSIDER, companyId: COMPANY_B })),
    (error) => error.statusCode === 404,
  );

  for (const status of ['resolved', 'closed', 'cancelled']) {
    world.state.ticket.status = status;
    const before = world.state.ticket.lastMessageSequence;
    await assert.rejects(
      () => world.service.createMessage(requester(world, { body: `no reply in ${status}` })),
      (error) => error.statusCode === 409,
    );
    assert.equal(world.state.ticket.status, status);
    assert.equal(world.state.ticket.lastMessageSequence, before);
  }

  await assert.rejects(
    () => world.service.listMessages({
      companyId: COMPANY_A,
      actorId: REQUESTER,
      ticketNumber: TICKET_NUMBER,
      canReadOwn: true,
      query: { limit: 10, includeInternal: 'true' },
    }),
    (error) => error.statusCode === 400,
  );

  const bodyRequest = { body: { body: 'hello', companyId: COMPANY_B }, params: { ticketNumber: TICKET_NUMBER }, query: {} };
  await assert.rejects(
    () => runValidatorStack(helpdeskMessageCreateValidator, bodyRequest),
    (error) => error.statusCode === 400,
  );
  const badQuery = { body: {}, params: { ticketNumber: TICKET_NUMBER }, query: { limit: '101' } };
  await assert.rejects(
    () => runValidatorStack(helpdeskMessageHistoryQueryValidator, badQuery),
    (error) => error.statusCode === 400,
  );
  const badAttachmentIdentity = {
    body: { messageType: 'public', userId: REQUESTER },
    params: { ticketNumber: TICKET_NUMBER },
    query: {},
  };
  await assert.rejects(
    () => runValidatorStack(helpdeskAttachmentMessageValidator, badAttachmentIdentity),
    (error) => error.statusCode === 400,
  );
});

test('queue membership, confidential reviewers, requester scope, and internal-note boundaries are distinct', async () => {
  const world = makeWorld({ ticket: { isConfidential: true } });
  const internal = await world.service.createMessage({
    ...agent(world),
    actorId: CONFIDENTIAL_AGENT,
    actorDisplayName: 'Maya Restricted',
    body: 'Restricted staff note.',
    messageType: 'internal',
  });
  assert.equal(internal.messageType, 'internal');

  await assert.rejects(
    () => world.service.listMessages({
      companyId: COMPANY_A,
      actorId: AGENT,
      ticketNumber: TICKET_NUMBER,
      canReadQueue: true,
    }),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    () => world.service.createMessage({
      ...agent(world),
      body: 'not authorized for confidential ticket',
      messageType: 'public',
    }),
    (error) => error.statusCode === 404,
  );

  const reviewerHistory = await world.service.listMessages({
    companyId: COMPANY_A,
    actorId: REVIEWER,
    ticketNumber: TICKET_NUMBER,
    canReadQueue: true,
  });
  assert.equal(reviewerHistory.messages.length, 0);
  await assert.rejects(
    () => world.service.createMessage({
      companyId: COMPANY_A,
      actorId: REVIEWER,
      ticketNumber: TICKET_NUMBER,
      canReadQueue: true,
      canManage: true,
      messageType: 'public',
      body: 'Reviewer cannot reply as an agent.',
    }),
    (error) => error.statusCode === 404,
  );

  const employeeHistory = await world.service.listMessages({
    companyId: COMPANY_A,
    actorId: REQUESTER,
    ticketNumber: TICKET_NUMBER,
    canReadOwn: true,
  });
  assert.doesNotMatch(JSON.stringify(employeeHistory), /Restricted staff note/);
  await assert.rejects(
    () => world.service.createMessage(requester(world, { messageType: 'internal', body: 'employee note' })),
    (error) => error.statusCode === 403,
  );

  const confidentialAgentHistory = await world.service.listMessages({
    companyId: COMPANY_A,
    actorId: CONFIDENTIAL_AGENT,
    ticketNumber: TICKET_NUMBER,
    canReadQueue: true,
  });
  assert.equal(confidentialAgentHistory.messages[0].messageType, 'internal');
});

test('queue membership revocation fences public replies, internal notes, and post-upload attachment activation', async (t) => {
  await t.test('public reply re-reads membership after a revocation conflict', async () => {
    await runAgentConversationRevocationRace({ messageType: 'public' });
  });
  await t.test('internal note re-reads membership after a revocation conflict', async () => {
    await runAgentConversationRevocationRace({ messageType: 'internal' });
  });
  await t.test('attachment bytes and metadata are cleaned after a definite post-upload authorization denial', async () => {
    await runAgentConversationRevocationRace({ messageType: 'public', attachment: true });
  });
});

test('atomic ticket counters assign stable unique total/public sequences under concurrent public replies and notes', async () => {
  const world = makeWorld();
  const total = 80;
  const replies = await Promise.all(Array.from({ length: total }, (_, index) =>
    world.service.createMessage(agent(world, {
      body: `parallel message ${index}`,
      messageType: index % 4 === 0 ? 'internal' : 'public',
    }))));

  assert.equal(replies.length, total);
  assert.equal(world.state.messages.length, total);
  const totalSequences = world.state.messages.map((message) => message.sequence).sort((a, b) => a - b);
  assert.deepEqual(totalSequences, Array.from({ length: total }, (_, index) => index + 1));
  const publicMessages = world.state.messages.filter((message) => message.messageType === 'PUBLIC');
  const publicSequences = publicMessages.map((message) => message.publicSequence).sort((a, b) => a - b);
  assert.deepEqual(publicSequences, Array.from({ length: publicMessages.length }, (_, index) => index + 1));
  assert.equal(world.state.ticket.lastMessageSequence, total);
  assert.equal(world.state.ticket.lastPublicMessageSequence, publicMessages.length);
  assert.ok(world.state.ticketUpdateCalls.every((call) => call.filter.companyId === COMPANY_A));
  assert.ok(world.state.ticketUpdateCalls.every((call) => call.filter.ticketKind === SUPPORT_TICKET_KIND.HELPDESK));
});

test('attachment authorization and feature availability are checked before any file storage operation', async () => {
  const disabled = makeWorld({ attachmentsEnabled: false });
  await assert.rejects(
    () => disabled.service.assertAttachmentWriteAllowed(requester(disabled)),
    (error) => error.statusCode === 403,
  );
  assert.equal(disabled.state.storeCalls.length, 0);
  assert.equal(disabled.state.attachments.length, 0);

  const unauthorized = makeWorld();
  await assert.rejects(
    () => unauthorized.service.assertAttachmentWriteAllowed({
      companyId: COMPANY_A,
      actorId: OUTSIDER,
      ticketNumber: TICKET_NUMBER,
      canReadOwn: false,
      canReadQueue: true,
      canManage: true,
    }),
    (error) => error.statusCode === 404,
  );
  assert.equal(unauthorized.state.storeCalls.length, 0);
});

test('attachment rules check extension, MIME, signature, size, and path-safe display names', () => {
  const accepted = assertAllowedHelpdeskAttachment({
    originalName: '../../credentials<private>.pdf',
    mimeType: 'application/pdf',
    buffer: PDF_BYTES,
  });
  assert.equal(accepted.mimeType, 'application/pdf');
  assert.equal(accepted.sizeBytes, PDF_BYTES.length);
  assert.equal(accepted.originalFileName, 'credentials_private_.pdf');
  assert.doesNotMatch(accepted.originalFileName, /[/\\]/);

  for (const attack of [
    { originalName: 'payload.exe', mimeType: 'application/pdf', buffer: PDF_BYTES },
    { originalName: 'payload.pdf', mimeType: 'image/png', buffer: PDF_BYTES },
    { originalName: 'payload.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<script>bad</script>') },
    { originalName: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) },
  ]) {
    assert.throws(() => assertAllowedHelpdeskAttachment(attack), (error) => error.statusCode === 400);
  }
  assert.throws(() => assertAllowedHelpdeskAttachment({
    originalName: 'large.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(HELPDESK_ATTACHMENT_MAX_BYTES + 1),
  }), (error) => error.statusCode === 400);
});

test('attachment-only public messages persist private metadata and are delivered only through the authorized ticket proxy', async () => {
  const world = makeWorld();
  const message = await world.service.createMessageWithAttachment(requester(world, {
    file: attachFile(),
  }));
  assert.equal(message.body, null);
  assert.equal(message.messageType, 'public');
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].fileName, 'private-record.pdf');
  assert.equal(world.state.storeCalls.length, 1);
  assert.equal(world.state.attachments.length, 1);
  const secondMessage = await world.service.createMessageWithAttachment(requester(world, {
    body: 'Second file, same paginated history.',
    file: attachFile({ originalname: 'second.pdf' }),
  }));
  assert.equal(secondMessage.attachments.length, 1);
  const historyWithTwoFiles = await world.service.listMessages({
    companyId: COMPANY_A,
    actorId: REQUESTER,
    ticketNumber: TICKET_NUMBER,
    canReadOwn: true,
    query: { limit: 20 },
  });
  assert.equal(historyWithTwoFiles.messages.length, 2);
  assert.equal(world.state.attachmentFindCalls.length, 1, 'attachment metadata is fetched once per page');
  assert.equal(world.state.attachmentFindCalls[0].limit, null);
  assert.equal(world.state.attachmentFindCalls[0].projection, '_id messageId originalFileName mimeType sizeBytes scanStatus createdAt');
  assert.equal(world.state.attachments[0].persistenceStatus, 'ACTIVE');
  assert.equal('buffer' in world.state.attachments[0], false);
  assert.equal('storageKey' in message.attachments[0], false);
  assert.doesNotMatch(JSON.stringify(message), /companyId|checksumSha256|CLOUDINARY|storageKey/);

  const attachmentId = idOf(message.attachments[0].attachmentId);
  const authorized = await world.service.authorizeAttachmentDownload({
    companyId: COMPANY_A,
    actorId: REQUESTER,
    ticketNumber: TICKET_NUMBER,
    attachmentId,
    canReadOwn: true,
  });
  assert.equal(idOf(authorized.ticketId), TICKET_ID);
  assert.equal(authorized.audience, 'requester');
  const delivered = await world.service.resolveAttachmentDelivery(authorized);
  assert.deepEqual(delivered.bytes, PDF_BYTES);
  assert.equal(delivered.contentType, 'application/pdf');
  assert.equal(world.state.messageFindOneCalls.at(-1).filter.companyId, COMPANY_A);
  assert.equal(idOf(world.state.messageFindOneCalls.at(-1).filter.ticketId), TICKET_ID);
  assert.equal(idOf(world.state.messageFindOneCalls.at(-1).filter.authorUserId), REQUESTER);
  assert.equal(world.state.attachmentFindOneCalls.at(-1).filter.companyId, COMPANY_A);
  assert.equal(idOf(world.state.attachmentFindOneCalls.at(-1).filter.ticketId), TICKET_ID);

  await assert.rejects(
    () => world.service.authorizeAttachmentDownload({
      companyId: COMPANY_B,
      actorId: REQUESTER,
      ticketNumber: TICKET_NUMBER,
      attachmentId,
      canReadOwn: true,
    }),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    () => world.service.authorizeAttachmentDownload({
      companyId: COMPANY_A,
      actorId: REQUESTER,
      ticketNumber: OTHER_TICKET_NUMBER,
      attachmentId,
      canReadOwn: true,
    }),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    () => world.service.authorizeAttachmentDownload({
      companyId: COMPANY_A,
      actorId: OUTSIDER,
      ticketNumber: TICKET_NUMBER,
      attachmentId,
      canReadOwn: false,
      canReadQueue: true,
    }),
    (error) => error.statusCode === 404,
  );
});

test('internal attachments are not visible or downloadable to requesters or confidentiality reviewers', async () => {
  const world = makeWorld({ ticket: { isConfidential: true } });
  const message = await world.service.createMessageWithAttachment({
    ...agent(world),
    actorId: CONFIDENTIAL_AGENT,
    actorDisplayName: 'Maya Restricted',
    messageType: 'internal',
    body: 'Internal working note.',
    file: attachFile({ originalname: 'support-evidence.pdf' }),
  });
  const attachmentId = idOf(message.attachments[0].attachmentId);

  for (const viewerId of [REQUESTER, REVIEWER]) {
    const args = viewerId === REQUESTER
      ? { canReadOwn: true }
      : { canReadQueue: true };
    const history = await world.service.listMessages({
      companyId: COMPANY_A,
      actorId: viewerId,
      ticketNumber: TICKET_NUMBER,
      ...args,
    });
    assert.equal(history.messages.length, 0);
    await assert.rejects(
      () => world.service.authorizeAttachmentDownload({
        companyId: COMPANY_A,
        actorId: viewerId,
        ticketNumber: TICKET_NUMBER,
        attachmentId,
        ...args,
      }),
      (error) => error.statusCode === 404,
    );
  }

  const staff = await world.service.authorizeAttachmentDownload({
    companyId: COMPANY_A,
    actorId: CONFIDENTIAL_AGENT,
    ticketNumber: TICKET_NUMBER,
    attachmentId,
    canReadQueue: true,
  });
  assert.equal(staff.audience, 'staff');
});

test('ticket authorization and eligible state are revalidated after upload; failed compensation is durable and recoverable', async () => {
  const world = makeWorld();
  world.state.afterStore = async (state) => { state.ticket.status = 'resolved'; };
  await assert.rejects(
    () => world.service.createMessageWithAttachment(requester(world, { file: attachFile() })),
    (error) => error.statusCode === 409,
  );
  assert.equal(world.state.messages.length, 0);
  assert.equal(world.state.ticket.lastMessageSequence, 0);
  assert.equal(world.state.stored.size, 0);
  assert.equal(world.state.attachments.length, 0);
  assert.equal(world.state.destroyCalls.length, 1);

  const failedCleanup = makeWorld();
  failedCleanup.state.destroyFails = true;
  failedCleanup.state.afterStore = async (state) => { state.ticket.status = 'closed'; };
  await assert.rejects(
    () => failedCleanup.service.createMessageWithAttachment(requester(failedCleanup, { file: attachFile() })),
    (error) => error.statusCode === 409,
  );
  assert.equal(failedCleanup.state.attachments.length, 1);
  assert.equal(failedCleanup.state.attachments[0].persistenceStatus, 'CLEANUP_REQUIRED');
  assert.equal(failedCleanup.state.attachments[0].cleanupRequired, true);
  assert.equal(failedCleanup.state.stored.size, 1);

  failedCleanup.state.nowMs += 60 * 60 * 1000;
  const pending = await failedCleanup.service.reconcilePendingAttachments({ companyId: COMPANY_A, limit: 5 });
  assert.equal(pending.inspected, 1);
  assert.equal(pending.cleanupPending, 1);
  failedCleanup.state.destroyFails = false;
  const recovered = await failedCleanup.service.reconcilePendingAttachments({ companyId: COMPANY_A, limit: 5 });
  assert.equal(recovered.removed, 1);
  assert.equal(failedCleanup.state.attachments.length, 0);
  assert.equal(failedCleanup.state.stored.size, 0);
});

test('unknown attachment-message commit retains private bytes until reconciliation can prove the message is absent', async () => {
  const world = makeWorld();
  world.state.transactionUnknownMode = 'aborted';
  await assert.rejects(
    () => world.service.createMessageWithAttachment(requester(world, { file: attachFile() })),
    (error) => error.statusCode === 503,
  );
  assert.equal(world.state.messages.length, 0);
  assert.equal(world.state.ticket.lastMessageSequence, 0);
  assert.equal(world.state.attachments.length, 1);
  assert.equal(world.state.attachments[0].persistenceStatus, 'PENDING');
  assert.equal(world.state.stored.size, 1);
  assert.equal(world.state.destroyCalls.length, 0);

  world.state.nowMs += 60 * 60 * 1000;
  const recovery = await world.service.reconcilePendingAttachments({ companyId: COMPANY_A, limit: 5 });
  assert.equal(recovery.removed, 1);
  assert.equal(world.state.attachments.length, 0);
  assert.equal(world.state.stored.size, 0);
});

test('unknown commit with a visible message resolves without replay and keeps the atomically active private attachment', async () => {
  const world = makeWorld();
  world.state.transactionUnknownMode = 'committed';
  const message = await world.service.createMessageWithAttachment(requester(world, { file: attachFile() }));
  assert.equal(world.state.messages.length, 1);
  assert.equal(world.state.ticket.lastMessageSequence, 1);
  assert.equal(world.state.attachments.length, 1);
  assert.equal(world.state.attachments[0].persistenceStatus, 'ACTIVE');
  assert.equal(world.state.stored.size, 1);
  assert.equal(world.state.destroyCalls.length, 0);
  assert.equal(message.attachments.length, 1);
});

test('definite Mongo message failure compensates; when provider deletion fails it records cleanup without exposing the file', async () => {
  const world = makeWorld();
  world.state.messageCreateMode = 'fail_before';
  world.state.destroyFails = true;
  await assert.rejects(
    () => world.service.createMessageWithAttachment(requester(world, { file: attachFile() })),
    (error) => error.statusCode === 503,
  );
  assert.equal(world.state.messages.length, 0);
  assert.equal(world.state.attachments.length, 1);
  assert.equal(world.state.attachments[0].persistenceStatus, 'CLEANUP_REQUIRED');
  assert.equal(world.state.stored.size, 1);
  await assert.rejects(
    () => world.service.authorizeAttachmentDownload({
      companyId: COMPANY_A,
      actorId: REQUESTER,
      ticketNumber: TICKET_NUMBER,
      attachmentId: world.state.attachments[0]._id,
      canReadOwn: true,
    }),
    (error) => error.statusCode === 404,
  );
});

test('upload and metadata failures normalize provider details; attachment activation aborts the message transaction safely', async () => {
  const storageFailure = makeWorld();
  storageFailure.state.storeFails = true;
  await assert.rejects(
    () => storageFailure.service.createMessageWithAttachment(requester(storageFailure, { file: attachFile() })),
    (error) => error.statusCode === 503 && !/credential|host failure|provider/i.test(error.message),
  );
  assert.equal(storageFailure.state.messages.length, 0);
  assert.equal(storageFailure.state.attachments[0].persistenceStatus, 'UPLOADING');

  const metadataFailure = makeWorld();
  metadataFailure.state.attachmentCreateMode = 'fail_before';
  await assert.rejects(
    () => metadataFailure.service.createMessageWithAttachment(requester(metadataFailure, { file: attachFile() })),
    (error) => error.statusCode === 503,
  );
  assert.equal(metadataFailure.state.storeCalls.length, 0);
  assert.equal(metadataFailure.state.stored.size, 0);

  const activationFailure = makeWorld();
  activationFailure.state.failActivation = true;
  await assert.rejects(
    () => activationFailure.service.createMessageWithAttachment(requester(activationFailure, { file: attachFile() })),
    (error) => error.statusCode === 503,
  );
  assert.equal(activationFailure.state.messages.length, 0);
  assert.equal(activationFailure.state.ticket.lastMessageSequence, 0);
  assert.equal(activationFailure.state.attachments.length, 0);
  assert.equal(activationFailure.state.stored.size, 0);
  assert.equal(activationFailure.state.destroyCalls.length, 1);

  activationFailure.state.failActivation = false;
  activationFailure.state.nowMs += 60 * 60 * 1000;
  const recovered = await activationFailure.service.reconcilePendingAttachments({ companyId: COMPANY_A, limit: 5 });
  assert.equal(recovered.inspected, 0);
});

test('attachment storage adapter keeps local files private in development and proxies bounded authenticated Cloudinary bytes', async () => {
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-helpdesk-attachment-test-'));
  const attachmentId = oid(701);
  const cloudKey = buildHelpdeskAttachmentStorageKey({
    companyId: COMPANY_A,
    ticketId: TICKET_ID,
    attachmentId,
  });
  try {
    const plannedLocal = planHelpdeskAttachmentStorage({
      companyId: COMPANY_A,
      ticketId: TICKET_ID,
      attachmentId,
      _ready: false,
      _nodeEnv: 'test',
    });
    assert.equal(plannedLocal.storageProvider, 'LOCAL_PRIVATE');
    assert.throws(
      () => planHelpdeskAttachmentStorage({ companyId: COMPANY_A, ticketId: TICKET_ID, attachmentId, _ready: false, _nodeEnv: 'production' }),
      (error) => error.statusCode === 503,
    );

    const local = await storeHelpdeskAttachment({
      buffer: PDF_BYTES,
      companyId: COMPANY_A,
      ticketId: TICKET_ID,
      attachmentId,
      storageProvider: plannedLocal.storageProvider,
      storageKey: plannedLocal.storageKey,
      _ready: false,
      _nodeEnv: 'test',
      _localDirectory: localRoot,
    });
    const localPath = path.join(localRoot, local.storageKey);
    assert.equal((await fs.stat(localPath)).mode & 0o777, 0o600);
    const checksumSha256 = (await import('node:crypto')).default.createHash('sha256').update(PDF_BYTES).digest('hex');
    const localDelivery = await resolveHelpdeskAttachmentDelivery({
      attachment: {
        companyId: COMPANY_A,
        ticketId: TICKET_ID,
        storageProvider: local.storageProvider,
        storageKey: local.storageKey,
        checksumSha256,
        sizeBytes: PDF_BYTES.length,
        mimeType: 'application/pdf',
        originalFileName: 'test.pdf',
      },
      _readLocal: (key) => fs.readFile(path.join(localRoot, key)),
    });
    assert.deepEqual(localDelivery.bytes, PDF_BYTES);

    let providerUploadArgs;
    const cloudStored = await storeHelpdeskAttachment({
      buffer: PDF_BYTES,
      companyId: COMPANY_A,
      ticketId: TICKET_ID,
      attachmentId,
      storageProvider: 'CLOUDINARY_AUTHENTICATED',
      storageKey: cloudKey,
      _ready: true,
      _upload: async (args) => {
        providerUploadArgs = args;
        return { storageProvider: 'CLOUDINARY_AUTHENTICATED', storageKey: args.storageKey };
      },
    });
    assert.equal(providerUploadArgs.resourceType, 'raw');
    assert.deepEqual(cloudStored, { storageProvider: 'CLOUDINARY_AUTHENTICATED', storageKey: cloudKey });

    let fetchOptions;
    const cloudDelivery = await resolveHelpdeskAttachmentDelivery({
      attachment: {
        companyId: COMPANY_A,
        ticketId: TICKET_ID,
        storageProvider: cloudStored.storageProvider,
        storageKey: cloudStored.storageKey,
        checksumSha256,
        sizeBytes: PDF_BYTES.length,
        mimeType: 'application/pdf',
        originalFileName: 'test.pdf',
      },
      _signer: () => ({ url: 'https://res.cloudinary.com/crewly/raw/authenticated/test.pdf?signature=fake' }),
      _fetch: async (url, options) => {
        assert.equal(new URL(url).hostname, 'res.cloudinary.com');
        fetchOptions = options;
        return {
          ok: true,
          body: Readable.from([PDF_BYTES]),
          headers: { get: (key) => key === 'content-length' ? String(PDF_BYTES.length) : null },
        };
      },
    });
    assert.equal(fetchOptions.redirect, 'error');
    assert.deepEqual(cloudDelivery.bytes, PDF_BYTES);

    let maliciousFetchCalled = false;
    await assert.rejects(
      () => resolveHelpdeskAttachmentDelivery({
        attachment: {
          companyId: COMPANY_A,
          ticketId: TICKET_ID,
          storageProvider: 'CLOUDINARY_AUTHENTICATED',
          storageKey: cloudKey,
          checksumSha256,
          sizeBytes: PDF_BYTES.length,
          mimeType: 'application/pdf',
          originalFileName: 'test.pdf',
        },
        _signer: () => ({ url: 'https://attacker.example/private-file' }),
        _fetch: async () => { maliciousFetchCalled = true; throw new Error('must not fetch an untrusted host'); },
      }),
      (error) => error.statusCode === 503,
    );
    assert.equal(maliciousFetchCalled, false);

    await assert.rejects(
      () => resolveHelpdeskAttachmentDelivery({
        attachment: {
          companyId: COMPANY_A,
          ticketId: TICKET_ID,
          storageProvider: 'CLOUDINARY_AUTHENTICATED',
          storageKey: cloudKey,
          checksumSha256: '0'.repeat(64),
          sizeBytes: PDF_BYTES.length,
          mimeType: 'application/pdf',
          originalFileName: 'test.pdf',
        },
        _signer: () => ({ url: 'https://res.cloudinary.com/crewly/signed' }),
        _fetch: async () => ({
          ok: true,
          body: Readable.from([PDF_BYTES]),
          headers: { get: () => String(PDF_BYTES.length) },
        }),
      }),
      (error) => error.statusCode === 503,
    );

    let destroyed = false;
    assert.equal(await destroyHelpdeskAttachment({
      storageProvider: 'CLOUDINARY_AUTHENTICATED',
      storageKey: cloudKey,
      companyId: COMPANY_A,
      ticketId: TICKET_ID,
      _destroy: async (args) => {
        assert.equal(args.resourceType, 'raw');
        destroyed = true;
        return true;
      },
    }), true);
    assert.equal(destroyed, true);
    assert.equal(await destroyHelpdeskAttachment({
      storageProvider: 'LOCAL_PRIVATE',
      storageKey: local.storageKey,
      companyId: COMPANY_A,
      ticketId: TICKET_ID,
      _localDirectory: localRoot,
    }), true);
  } finally {
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});

test('routes are protected, history filters are bounded, and download includes the ticket scope', async () => {
  const routes = helpdeskRouter.stack.filter((layer) => layer.route).map((layer) => ({
    path: layer.route.path,
    methods: layer.route.methods,
    handlers: layer.route.stack.map((entry) => entry.handle),
  }));
  assert.ok(routes.some((route) => route.methods.get && route.path === '/tickets/:ticketNumber/messages'));
  assert.ok(routes.some((route) => route.methods.post && route.path === '/tickets/:ticketNumber/messages'));
  assert.ok(routes.some((route) => route.methods.post && route.path === '/tickets/:ticketNumber/attachments'));
  assert.ok(routes.some((route) => route.methods.get && route.path === '/tickets/:ticketNumber/attachments/:attachmentId/download'));
  const uploadRoute = routes.find((route) => route.methods.post && route.path === '/tickets/:ticketNumber/attachments');
  assert.ok(uploadRoute.handlers.indexOf(helpdeskController.authorizeAttachmentUpload)
    < uploadRoute.handlers.indexOf(helpdeskAttachmentUpload));

  const downloadValidator = await runValidatorStack(helpdeskAttachmentIdParamValidator, {
    body: {},
    params: { ticketNumber: TICKET_NUMBER, attachmentId: oid(700) },
    query: {},
  });
  assert.equal(downloadValidator, undefined);
  await assert.rejects(
    () => runValidatorStack(helpdeskAttachmentIdParamValidator, {
      body: {},
      params: { ticketNumber: 'invalid', attachmentId: oid(700) },
      query: {},
    }),
    (error) => error.statusCode === 400,
  );
});

test('audit labels identify public replies, internal notes, uploads, and downloads without bodies or private URLs', async () => {
  const originalCreate = AuditLog.create;
  const records = [];
  AuditLog.create = (payload) => {
    records.push(clone(payload));
    return Promise.resolve(payload);
  };
  try {
    const events = [
      {
        action: 'Posted a Helpdesk public reply',
        path: `/api/helpdesk/tickets/${TICKET_NUMBER}/messages`,
      },
      {
        action: 'Added a Helpdesk internal note',
        path: `/api/helpdesk/tickets/${TICKET_NUMBER}/messages`,
      },
      {
        action: 'Added an attachment to a Helpdesk public reply',
        path: `/api/helpdesk/tickets/${TICKET_NUMBER}/attachments`,
      },
    ];
    for (const event of events) {
      let finish;
      const req = {
        method: 'POST',
        originalUrl: `${event.path}?token=private`,
        companyId: COMPANY_A,
        user: { _id: AGENT, name: 'Arun Support', role: 'support' },
        ip: '127.0.0.1',
        body: { body: 'must not be copied to the audit record', file: 'private-bytes' },
      };
      const res = {
        statusCode: 201,
        on(name, listener) { if (name === 'finish') finish = listener; },
      };
      auditTrail(req, res, () => {});
      req.helpdeskAuditAction = event.action;
      finish();
      await new Promise((resolve) => setImmediate(resolve));
    }

    await recordAudit({
      req: {
        method: 'GET',
        originalUrl: `/api/helpdesk/tickets/${TICKET_NUMBER}/attachments/${oid(702)}/download?signature=private`,
        user: { _id: REQUESTER, name: 'Riya Requester', role: 'employee' },
        headers: {},
      },
      action: 'Downloaded a Helpdesk ticket attachment',
      companyId: COMPANY_A,
      actorId: REQUESTER,
      resource: 'HelpdeskAttachment',
      resourceId: oid(702),
      metadata: { ticketId: TICKET_ID, messageId: oid(703) },
      statusCode: 200,
    });
  } finally {
    AuditLog.create = originalCreate;
  }

  assert.equal(records.length, 4);
  assert.deepEqual(records.slice(0, 3).map((entry) => entry.action), [
    'Posted a Helpdesk public reply',
    'Added a Helpdesk internal note',
    'Added an attachment to a Helpdesk public reply',
  ]);
  assert.equal(records[3].action, 'Downloaded a Helpdesk ticket attachment');
  assert.equal(records[3].path, `/api/helpdesk/tickets/${TICKET_NUMBER}/attachments/${oid(702)}/download`);
  assert.doesNotMatch(JSON.stringify(records), /must not be copied|private-bytes|token=private|signature=private|storageKey|signedUrl|cloudinary/);
});
