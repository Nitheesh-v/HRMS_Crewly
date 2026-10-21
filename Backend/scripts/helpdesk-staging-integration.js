import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import dotenv from 'dotenv';
import mongoose from 'mongoose';

export const REQUIRED_STAGING_DATABASE = 'crewly_staging';
export const REQUIRED_STAGING_ROLE = 'readWrite';
export const REQUIRED_FENCE_INDEX_NAME = 'helpdesk_authorization_fence_unique';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_ENV_PATH = path.join(BACKEND_ROOT, '.env.staging.local');
const REQUIRED_OPT_IN_ARGUMENTS = Object.freeze([
  '--allow-staging-writes',
  `--confirm-database=${REQUIRED_STAGING_DATABASE}`,
]);
const TRANSACTION_MIN_WIRE_VERSION = 7;
const BARRIER_TIMEOUT_MS = 30_000;
const HELPDESK_TICKET_SEQUENCE_KEY = 'HELPDESK_TICKET';

const idString = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const assertion = (condition, label) => {
  if (!condition) {
    const error = new Error(`Harness assertion failed: ${label}`);
    error.name = 'HelpdeskHarnessAssertionError';
    throw error;
  }
};

export const validateOptIn = (argumentsList) => {
  if (
    !Array.isArray(argumentsList)
    || argumentsList.length !== REQUIRED_OPT_IN_ARGUMENTS.length
    || REQUIRED_OPT_IN_ARGUMENTS.some((argument) => !argumentsList.includes(argument))
  ) {
    throw new Error('Explicit staging write and database confirmations are required.');
  }
  return true;
};

export const assertEffectiveDatabase = (databaseName) => {
  if (databaseName !== REQUIRED_STAGING_DATABASE) {
    throw new Error('The effective MongoDB database is not the approved staging database.');
  }
  return true;
};

export const assertStagingOnlyAuthentication = (connectionStatus) => {
  const authInfo = connectionStatus?.authInfo || connectionStatus;
  const users = authInfo?.authenticatedUsers;
  const roles = authInfo?.authenticatedUserRoles;
  const privileges = authInfo?.authenticatedUserPrivileges;
  if (
    !Array.isArray(users)
    || users.length !== 1
    || !Array.isArray(roles)
    || roles.length !== 1
    || roles[0]?.role !== REQUIRED_STAGING_ROLE
    || roles[0]?.db !== REQUIRED_STAGING_DATABASE
    || !Array.isArray(privileges)
    || privileges.length === 0
    || privileges.some((privilege) =>
      privilege?.resource?.db !== REQUIRED_STAGING_DATABASE
      || privilege?.resource?.cluster === true
      || privilege?.resource?.anyResource === true)
  ) {
    throw new Error('The authenticated MongoDB principal is not staging-only.');
  }
  return true;
};

export const assertTransactionTopology = (hello) => {
  const replicaSet = typeof hello?.setName === 'string' && hello.setName.length > 0;
  const shardedCluster = hello?.msg === 'isdbgrid';
  const maxWireVersion = Number(hello?.maxWireVersion);
  if (
    (!replicaSet && !shardedCluster)
    || !Number.isFinite(maxWireVersion)
    || maxWireVersion < TRANSACTION_MIN_WIRE_VERSION
  ) {
    throw new Error('MongoDB transaction support is not available.');
  }
  return true;
};

export const assertRequiredFenceIndex = (indexes) => {
  const expectedKeys = [
    ['companyId', 1],
    ['queueId', 1],
    ['userId', 1],
  ];
  const index = Array.isArray(indexes)
    ? indexes.find((candidate) => candidate?.name === REQUIRED_FENCE_INDEX_NAME)
    : null;
  const actualKeys = index?.key && typeof index.key === 'object'
    ? Object.entries(index.key)
    : [];
  const exactKey = actualKeys.length === expectedKeys.length
    && expectedKeys.every(([key, direction], indexPosition) =>
      actualKeys[indexPosition]?.[0] === key
      && actualKeys[indexPosition]?.[1] === direction);
  if (!index || index.unique !== true || !exactKey) {
    throw new Error('The required unique Helpdesk authorization-fence index is missing.');
  }
  return true;
};

export const makeExactIdFilter = (ids) => {
  if (!Array.isArray(ids)) throw new TypeError('Owned record identifiers must be an array.');
  if (ids.some((id) => id === null || id === undefined || idString(id) === '')) {
    throw new TypeError('Owned record identifiers must be non-empty.');
  }
  const uniqueIds = [...new Map(ids.map((id) => [idString(id), id])).values()];
  return uniqueIds.length ? { _id: { $in: uniqueIds } } : null;
};

const makeDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createArrivalBarrier = (expectedArrivals) => {
  const reached = makeDeferred();
  const released = makeDeferred();
  let arrivalCount = 0;
  let isReleased = false;

  return {
    async arriveAndWait() {
      if (isReleased) return;
      arrivalCount += 1;
      if (arrivalCount >= expectedArrivals) reached.resolve();
      await released.promise;
    },
    async waitForArrivals(timeoutMs = BARRIER_TIMEOUT_MS) {
      let timer;
      try {
        await Promise.race([
          reached.promise,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('A deterministic test barrier was not reached.')), timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    release() {
      if (isReleased) return;
      isReleased = true;
      released.resolve();
    },
    get arrivals() {
      return arrivalCount;
    },
  };
};

const settle = async (promiseOrValue) => {
  try {
    return { ok: true, value: await promiseOrValue };
  } catch (error) {
    return { ok: false, error };
  }
};

const executeWithGate = async (gate, blockedOperation, interaction) => {
  const blockedResultPromise = settle(blockedOperation);
  let interactionResult;
  try {
    await gate.waitForArrivals();
    interactionResult = await settle(interaction());
  } catch (error) {
    interactionResult = { ok: false, error };
  } finally {
    gate.release();
  }
  const blockedResult = await blockedResultPromise;
  return { blockedResult, interactionResult };
};

const uniqueIds = (...groups) => [
  ...new Map(groups.flat().filter(Boolean).map((id) => [idString(id), id])).values(),
];

const classNameOf = (error) => {
  const candidate = String(error?.name || 'Error').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  return candidate || 'Error';
};

const quietLoadServices = async () => {
  const cloudinaryVariables = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ];
  const priorEnvironment = new Map(
    cloudinaryVariables.map((key) => [key, process.env[key]]),
  );
  const originalLog = console.log;
  const originalWarn = console.warn;

  // The real conversation-service module imports its default storage adapter.
  // Keep that module from configuring or announcing Cloudinary: this harness
  // injects an in-memory private store and must never upload externally.
  cloudinaryVariables.forEach((key) => { delete process.env[key]; });
  console.log = () => {};
  console.warn = () => {};
  try {
    const [
      companyModule,
      userModule,
      queueModelModule,
      ticketModelModule,
      messageModelModule,
      attachmentModelModule,
      configModelModule,
      fenceModelModule,
      sequenceModelModule,
      queueServiceModule,
      ticketServiceModule,
      conversationServiceModule,
      transactionModule,
      ticketKindModule,
    ] = await Promise.all([
      import('../src/models/Company.js'),
      import('../src/models/User.js'),
      import('../src/models/HelpdeskQueue.js'),
      import('../src/models/HelpdeskTicket.js'),
      import('../src/models/HelpdeskMessage.js'),
      import('../src/models/HelpdeskAttachment.js'),
      import('../src/models/HelpdeskTenantConfig.js'),
      import('../src/models/HelpdeskAuthorizationFence.js'),
      import('../src/models/TenantSequence.js'),
      import('../src/services/helpdesk/helpdeskQueueService.js'),
      import('../src/services/helpdesk/helpdeskTicketService.js'),
      import('../src/services/helpdesk/helpdeskConversationService.js'),
      import('../src/services/helpdesk/helpdeskTransaction.js'),
      import('../src/utils/supportTicketKinds.js'),
    ]);
    return {
      Company: companyModule.default,
      User: userModule.default,
      HelpdeskQueue: queueModelModule.default,
      HelpdeskTicket: ticketModelModule.default,
      HelpdeskMessage: messageModelModule.default,
      HelpdeskAttachment: attachmentModelModule.default,
      HelpdeskTenantConfig: configModelModule.default,
      HelpdeskAuthorizationFence: fenceModelModule.default,
      TenantSequence: sequenceModelModule.default,
      helpdeskQueueService: queueServiceModule.helpdeskQueueService,
      helpdeskTicketService: ticketServiceModule.helpdeskTicketService,
      helpdeskConversationService: conversationServiceModule.helpdeskConversationService,
      runHelpdeskTransaction: transactionModule.runHelpdeskTransaction,
      HELPDESK_TICKET_KIND: ticketKindModule.SUPPORT_TICKET_KIND.HELPDESK,
    };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    for (const [key, value] of priorEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const assertRequiredCollections = async (db, models) => {
  const requiredNames = [...new Set(Object.values(models)
    .filter((model) => model?.collection?.collectionName)
    .map((model) => model.collection.collectionName))];
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray())
    .map((collection) => collection.name));
  if (requiredNames.some((name) => !existing.has(name))) {
    throw new Error('A required staging collection is missing; no data was written.');
  }
};

const assertStagingConnection = async ({ connection, HelpdeskAuthorizationFence, models }) => {
  assertEffectiveDatabase(connection?.db?.databaseName);
  const hello = await connection.db.command({ hello: 1 });
  assertTransactionTopology(hello);
  const status = await connection.db.command({ connectionStatus: 1, showPrivileges: true });
  assertStagingOnlyAuthentication(status);
  const indexes = await HelpdeskAuthorizationFence.collection.listIndexes().toArray();
  assertRequiredFenceIndex(indexes);
  await assertRequiredCollections(connection.db, models);
};

const collectRows = async (queryFactory, recordFailure) => {
  try {
    return await queryFactory();
  } catch (error) {
    recordFailure(error);
    return [];
  }
};

const cleanupOwnedRecords = async ({ owned, models, privateFiles }) => {
  privateFiles.clear();
  const companyIds = uniqueIds(owned.companyIds);
  if (!companyIds.length) return;

  let firstFailure = null;
  const recordFailure = (error) => { firstFailure ||= error; };
  const queueRows = await collectRows(
    () => models.HelpdeskQueue.find({ companyId: { $in: companyIds } }).select('_id').lean(),
    recordFailure,
  );
  const queueIds = uniqueIds(owned.queueIds, queueRows.map((row) => row._id));
  const ticketRows = await collectRows(
    () => models.HelpdeskTicket.find({
      companyId: { $in: companyIds },
      ticketKind: models.HELPDESK_TICKET_KIND,
    }).select('_id').lean(),
    recordFailure,
  );
  const ticketIds = uniqueIds(owned.ticketIds, ticketRows.map((row) => row._id));
  const messageRows = ticketIds.length
    ? await collectRows(
      () => models.HelpdeskMessage.find({
        companyId: { $in: companyIds },
        ticketId: { $in: ticketIds },
      }).select('_id').lean(),
      recordFailure,
    )
    : [];
  const messageIds = uniqueIds(owned.messageIds, messageRows.map((row) => row._id));
  const attachmentRows = ticketIds.length
    ? await collectRows(
      () => models.HelpdeskAttachment.find({
        companyId: { $in: companyIds },
        ticketId: { $in: ticketIds },
      }).select('_id').lean(),
      recordFailure,
    )
    : [];
  const attachmentIds = uniqueIds(owned.attachmentIds, attachmentRows.map((row) => row._id));
  const fenceRows = queueIds.length && owned.userIds.length
    ? await collectRows(
      () => models.HelpdeskAuthorizationFence.find({
        companyId: { $in: companyIds },
        queueId: { $in: queueIds },
        userId: { $in: owned.userIds },
      }).select('_id').lean(),
      recordFailure,
    )
    : [];
  const fenceIds = uniqueIds(owned.fenceIds, fenceRows.map((row) => row._id));
  const configRows = await collectRows(
    () => models.HelpdeskTenantConfig.find({ companyId: { $in: companyIds } }).select('_id').lean(),
    recordFailure,
  );
  const configIds = uniqueIds(owned.configIds, configRows.map((row) => row._id));
  const sequenceRows = await collectRows(
    () => models.TenantSequence.find({
      companyId: { $in: companyIds },
      key: HELPDESK_TICKET_SEQUENCE_KEY,
    }).select('_id').lean(),
    recordFailure,
  );
  const sequenceIds = uniqueIds(owned.sequenceIds, sequenceRows.map((row) => row._id));

  const deleteGroups = [
    [models.HelpdeskAttachment, attachmentIds],
    [models.HelpdeskMessage, messageIds],
    [models.HelpdeskTicket, ticketIds],
    [models.HelpdeskAuthorizationFence, fenceIds],
    [models.HelpdeskQueue, queueIds],
    [models.HelpdeskTenantConfig, configIds],
    [models.TenantSequence, sequenceIds],
    [models.User, owned.userIds],
    [models.Company, companyIds],
  ];
  for (const [model, ids] of deleteGroups) {
    const filter = makeExactIdFilter(ids);
    if (!filter) continue;
    try {
      await model.deleteMany(filter);
    } catch (error) {
      recordFailure(error);
    }
  }

  const verifyGroups = deleteGroups;
  for (const [model, ids] of verifyGroups) {
    const filter = makeExactIdFilter(ids);
    if (!filter) continue;
    try {
      const remaining = await model.countDocuments(filter);
      if (remaining !== 0) recordFailure(new Error('A test-owned record remains after cleanup.'));
    } catch (error) {
      recordFailure(error);
    }
  }

  if (firstFailure) throw new Error('Exact-identifier cleanup did not fully complete.');
};

const createHarnessServices = ({ models, runHelpdeskTransaction }) => {
  const transactionLabels = new WeakMap();
  const transactionAttempts = { queue: 0, ticket: 0, message: 0 };
  let fenceBarrier = null;
  let storageBarrier = null;
  const privateFiles = new Map();

  const makeTransactionRunner = (label) => (work, options) => runHelpdeskTransaction(
    async (session, attempt) => {
      transactionLabels.set(session, label);
      transactionAttempts[label] += 1;
      return work(session, attempt);
    },
    options,
  );

  const fenceModel = {
    async bulkWrite(operations, options = {}) {
      const barrier = fenceBarrier;
      const label = transactionLabels.get(options.session);
      if (barrier && label === barrier.label) {
        const matchingOperation = (operations || []).some((operation) => {
          const filter = operation?.updateOne?.filter;
          return filter
            && idString(filter.queueId) === barrier.queueId
            && barrier.userIds.has(idString(filter.userId).toLowerCase());
        });
        if (matchingOperation) await barrier.arriveAndWait();
      }
      return models.HelpdeskAuthorizationFence.bulkWrite(operations, options);
    },
  };

  const armFenceBarrier = ({ label, queueId, userIds, arrivals = 1 }) => {
    if (fenceBarrier) throw new Error('A fence barrier is already armed.');
    const barrier = createArrivalBarrier(arrivals);
    fenceBarrier = Object.assign(barrier, {
      label,
      queueId: idString(queueId),
      userIds: new Set(userIds.map((userId) => idString(userId).toLowerCase())),
    });
    return {
      waitForArrivals: barrier.waitForArrivals,
      release() {
        barrier.release();
        if (fenceBarrier === barrier) fenceBarrier = null;
      },
      get arrivals() { return barrier.arrivals; },
    };
  };

  const armStorageBarrier = ({ ticketId }) => {
    if (storageBarrier) throw new Error('An attachment storage barrier is already armed.');
    const barrier = createArrivalBarrier(1);
    storageBarrier = Object.assign(barrier, { ticketId: idString(ticketId) });
    return {
      waitForArrivals: barrier.waitForArrivals,
      release() {
        barrier.release();
        if (storageBarrier === barrier) storageBarrier = null;
      },
    };
  };

  const storageKeyFor = ({ companyId, ticketId, attachmentId }) =>
    `${idString(companyId)}:${idString(ticketId)}:${idString(attachmentId)}`;

  const planAttachmentStorage = ({ attachmentId }) => ({
    storageProvider: 'LOCAL_PRIVATE',
    storageKey: idString(attachmentId),
  });

  const storeAttachment = async (input) => {
    const barrier = storageBarrier;
    if (barrier && barrier.ticketId === idString(input.ticketId)) await barrier.arriveAndWait();
    privateFiles.set(storageKeyFor(input), Buffer.from(input.buffer));
    return {
      storageProvider: input.storageProvider,
      storageKey: input.storageKey,
    };
  };

  const destroyAttachment = async ({ companyId, ticketId, storageKey }) =>
    privateFiles.delete(`${idString(companyId)}:${idString(ticketId)}:${idString(storageKey)}`);

  return {
    privateFiles,
    transactionAttempts,
    armFenceBarrier,
    armStorageBarrier,
    queueService: models.helpdeskQueueService({
      FenceModel: fenceModel,
      transactionRunner: makeTransactionRunner('queue'),
    }),
    ticketService: models.helpdeskTicketService({
      FenceModel: fenceModel,
      transactionRunner: makeTransactionRunner('ticket'),
    }),
    conversationService: models.helpdeskConversationService({
      FenceModel: fenceModel,
      transactionRunner: makeTransactionRunner('message'),
      planAttachmentStorage,
      storeAttachment,
      destroyAttachment,
    }),
  };
};

const buildMessageInput = ({ tenant, ticket, actor, body, messageType = 'PUBLIC' }) => ({
  companyId: tenant.companyId,
  actorId: actor._id,
  ticketNumber: ticket.ticketNumber,
  body,
  messageType,
  canReadQueue: true,
  canManage: true,
});

const assertNotFound = async (operation, label) => {
  const outcome = await settle(operation());
  assertion(!outcome.ok && Number(outcome.error?.statusCode) === 404, label);
};

const createTenantFixture = async ({ suffix, models, services, owned }) => {
  const companyId = new mongoose.Types.ObjectId();
  owned.companyIds.push(companyId);
  const code = `hfs${suffix}`;
  await models.Company.create({
    _id: companyId,
    name: `Helpdesk staging fixture ${suffix}`,
    code,
  });

  const users = {};
  for (const label of ['requester', 'manager', 'agentA', 'agentB', 'restrictedAgent']) {
    const userId = new mongoose.Types.ObjectId();
    owned.userIds.push(userId);
    users[label] = await models.User.create({
      _id: userId,
      name: `Staging ${label}`,
      email: `${suffix}.${label.toLowerCase()}@example.invalid`,
      password: randomBytes(32).toString('hex'),
      companyId,
      status: 'ACTIVE',
    });
  }

  const configId = new mongoose.Types.ObjectId();
  owned.configIds.push(configId);
  await models.HelpdeskTenantConfig.create({
    _id: configId,
    companyId,
    enabled: true,
    allowEmployeeTickets: true,
    attachmentsEnabled: true,
    confidentialTicketsEnabled: true,
    defaultPriority: 'normal',
    updatedBy: users.manager._id,
  });

  const queue = await services.queueService.createQueue({
    companyId,
    actorId: users.manager._id,
    input: {
      name: `Fence ${suffix}`,
      description: 'Disposable authorization-fence integration queue.',
      enabled: true,
      categories: [{ name: 'General' }],
      agents: [users.agentA._id, users.agentB._id, users.restrictedAgent._id].map(String),
      managers: [String(users.manager._id)],
      confidentiality: {
        enabled: true,
        agentIds: [String(users.restrictedAgent._id)],
        reviewerIds: [],
      },
    },
  });
  const queueId = new mongoose.Types.ObjectId(queue.id);
  owned.queueIds.push(queueId);

  return {
    companyId,
    users,
    queueId,
    categoryId: new mongoose.Types.ObjectId(queue.categories[0].id),
    queueAgentIds: [users.agentA._id, users.agentB._id, users.restrictedAgent._id],
  };
};

const createTicketFixture = async ({ tenant, subject, confidential = false, models, services, owned }) => {
  const created = await services.ticketService.createTicket({
    companyId: tenant.companyId,
    requesterId: tenant.users.requester._id,
    input: {
      queueId: String(tenant.queueId),
      categoryId: String(tenant.categoryId),
      subject,
      description: 'Disposable integration ticket content; do not expose.',
      confidential,
    },
  });
  const row = await models.HelpdeskTicket.findOne({
    companyId: tenant.companyId,
    ticketKind: models.HELPDESK_TICKET_KIND,
    ticketNumber: created.ticketNumber,
  }).select('_id').lean();
  assertion(Boolean(row?._id), 'ticket service persisted its test ticket');
  owned.ticketIds.push(row._id);
  return { id: row._id, ticketNumber: created.ticketNumber };
};

const updateQueueAgents = async ({ tenant, services, agentIds }) => services.queueService.updateQueue({
  companyId: tenant.companyId,
  actorId: tenant.users.manager._id,
  queueId: String(tenant.queueId),
  input: { agents: agentIds.map(String) },
});

const runHarness = async () => {
  validateOptIn(process.argv.slice(2));
  const parsedEnvironment = dotenv.parse(await readFile(STAGING_ENV_PATH, 'utf8'));
  const mongoUri = parsedEnvironment.MONGO_URI;
  if (typeof mongoUri !== 'string' || !mongoUri.trim()) {
    throw new Error('The staging environment file does not provide MONGO_URI.');
  }

  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(mongoUri, {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 10_000,
  });

  const models = await quietLoadServices();
  const modelRegistry = {
    Company: models.Company,
    User: models.User,
    HelpdeskQueue: models.HelpdeskQueue,
    HelpdeskTicket: models.HelpdeskTicket,
    HelpdeskMessage: models.HelpdeskMessage,
    HelpdeskAttachment: models.HelpdeskAttachment,
    HelpdeskTenantConfig: models.HelpdeskTenantConfig,
    HelpdeskAuthorizationFence: models.HelpdeskAuthorizationFence,
    TenantSequence: models.TenantSequence,
  };
  const owned = {
    companyIds: [],
    userIds: [],
    queueIds: [],
    ticketIds: [],
    messageIds: [],
    attachmentIds: [],
    fenceIds: [],
    configIds: [],
    sequenceIds: [],
  };
  const services = createHarnessServices({ models, runHelpdeskTransaction: models.runHelpdeskTransaction });
  let testFailure = null;
  let currentCase = 'staging safety preflight';
  let cleanupFailure = null;

  try {
    await assertStagingConnection({
      connection: mongoose.connection,
      HelpdeskAuthorizationFence: models.HelpdeskAuthorizationFence,
      models: modelRegistry,
    });

    currentCase = 'disposable tenant and Helpdesk fixture setup';
    const primary = await createTenantFixture({
      suffix: randomBytes(6).toString('hex'),
      models,
      services,
      owned,
    });
    const secondary = await createTenantFixture({
      suffix: randomBytes(6).toString('hex'),
      models,
      services,
      owned,
    });
    await createTicketFixture({
      tenant: primary,
      subject: 'Fence staging tenant boundary',
      models,
      services,
      owned,
    });
    await createTicketFixture({
      tenant: secondary,
      subject: 'Fence staging other tenant first',
      models,
      services,
      owned,
    });
    const secondaryIsolationTicket = await createTicketFixture({
      tenant: secondary,
      subject: 'Fence staging other tenant isolation',
      models,
      services,
      owned,
    });

    currentCase = 'tenant isolation';
    const sameNumberForeignTicketCount = await models.HelpdeskTicket.countDocuments({
      companyId: primary.companyId,
      ticketNumber: secondaryIsolationTicket.ticketNumber,
      ticketKind: models.HELPDESK_TICKET_KIND,
    });
    assertion(sameNumberForeignTicketCount === 0, 'foreign tenant ticket number does not collide with a local fixture');
    await assertNotFound(() => services.conversationService.createMessage(buildMessageInput({
      tenant: primary,
      ticket: secondaryIsolationTicket,
      actor: primary.users.agentB,
      body: 'cross-tenant attempt one',
    })), 'a foreign tenant ticket number is not resolved in the requesting tenant');
    await assertNotFound(() => services.conversationService.createMessage(buildMessageInput({
      tenant: secondary,
      ticket: secondaryIsolationTicket,
      actor: primary.users.agentA,
      body: 'cross-tenant attempt two',
    })), 'an agent from another tenant is not queue staff');
    const secondaryIsolationId = secondaryIsolationTicket.id;
    const crossTenantMessages = await models.HelpdeskMessage.countDocuments({
      companyId: secondary.companyId,
      ticketId: secondaryIsolationId,
    });
    assertion(crossTenantMessages === 0, 'tenant isolation attempts persisted no messages');
    console.log('PASS: tenant isolation');

    currentCase = 'message commit before queue revocation';
    const messageWinsTicket = await createTicketFixture({
      tenant: primary,
      subject: 'Fence message wins ordering',
      models,
      services,
      owned,
    });
    const queueAttemptsBeforeMessageWins = services.transactionAttempts.queue;
    const messageWinsGate = services.armFenceBarrier({
      label: 'queue',
      queueId: primary.queueId,
      userIds: [primary.users.agentA._id],
    });
    const revokeAfterMessage = services.queueService.updateQueue({
      companyId: primary.companyId,
      actorId: primary.users.manager._id,
      queueId: String(primary.queueId),
      input: { agents: primary.queueAgentIds.filter((id) => idString(id) !== idString(primary.users.agentA._id)).map(String) },
    });
    const firstOrdering = await executeWithGate(messageWinsGate, revokeAfterMessage, async () => {
      const result = await services.conversationService.createMessage(buildMessageInput({
        tenant: primary,
        ticket: messageWinsTicket,
        actor: primary.users.agentA,
        body: 'synthetic public response before revocation',
      }));
      const queueBeforeRelease = await models.HelpdeskQueue.findOne({
        _id: primary.queueId,
        companyId: primary.companyId,
      }).lean();
      const messageBeforeRelease = await models.HelpdeskMessage.findOne({
        _id: new mongoose.Types.ObjectId(result.id),
        companyId: primary.companyId,
        ticketId: messageWinsTicket.id,
      }).select('_id').lean();
      assertion(queueBeforeRelease?.agents?.some((id) => idString(id) === idString(primary.users.agentA._id)), 'membership remains active until the paused revocation commits');
      assertion(Boolean(messageBeforeRelease), 'message transaction committed before the paused revocation');
      return result;
    });
    assertion(firstOrdering.interactionResult.ok, 'message committed before revocation');
    assertion(firstOrdering.blockedResult.ok, 'queue revocation completed after the message commit');
    const postMessageQueue = await models.HelpdeskQueue.findOne({
      _id: primary.queueId,
      companyId: primary.companyId,
    }).lean();
    assertion(!postMessageQueue?.agents?.some((id) => idString(id) === idString(primary.users.agentA._id)), 'queue membership arrays remain authoritative after revocation');
    const messageWinsRow = await models.HelpdeskMessage.findOne({
      companyId: primary.companyId,
      ticketId: messageWinsTicket.id,
    }).select('_id').lean();
    assertion(Boolean(messageWinsRow), 'the already-committed message remains after revocation');
    const discoveredMessageWinsRows = await models.HelpdeskMessage.find({
      companyId: primary.companyId,
      ticketId: messageWinsTicket.id,
    }).select('_id').lean();
    owned.messageIds.push(...discoveredMessageWinsRows.map((row) => row._id));
    assertion(services.transactionAttempts.queue > queueAttemptsBeforeMessageWins, 'queue revocation transaction was exercised');
    console.log('PASS: message commit before queue revocation');

    await updateQueueAgents({ tenant: primary, services, agentIds: primary.queueAgentIds });
    const revocationWinsTicket = await createTicketFixture({
      tenant: primary,
      subject: 'Fence revocation wins ordering',
      models,
      services,
      owned,
    });
    const messageAttemptsBeforeRevocationWins = services.transactionAttempts.message;
    const revocationWinsGate = services.armFenceBarrier({
      label: 'message',
      queueId: primary.queueId,
      userIds: [primary.users.agentA._id],
    });
    const delayedInternalNote = services.conversationService.createMessage(buildMessageInput({
      tenant: primary,
      ticket: revocationWinsTicket,
      actor: primary.users.agentA,
      body: 'synthetic internal note blocked by revocation',
      messageType: 'INTERNAL',
    }));
    const secondOrdering = await executeWithGate(revocationWinsGate, delayedInternalNote, async () => {
      await updateQueueAgents({
        tenant: primary,
        services,
        agentIds: primary.queueAgentIds.filter((id) => idString(id) !== idString(primary.users.agentA._id)),
      });
      const queueAfterCommit = await models.HelpdeskQueue.findOne({
        _id: primary.queueId,
        companyId: primary.companyId,
      }).lean();
      assertion(!queueAfterCommit?.agents?.some((id) => idString(id) === idString(primary.users.agentA._id)), 'revocation committed before the delayed note resumed');
    });
    assertion(secondOrdering.interactionResult.ok, 'revocation committed while the note was paused');
    assertion(!secondOrdering.blockedResult.ok && Number(secondOrdering.blockedResult.error?.statusCode) === 404, 'delayed internal note was denied after transaction retry refreshed authorization');
    assertion(services.transactionAttempts.message - messageAttemptsBeforeRevocationWins >= 2, 'message transaction callback retried after a write conflict');
    const deniedTicketMessages = await models.HelpdeskMessage.countDocuments({
      companyId: primary.companyId,
      ticketId: revocationWinsTicket.id,
    });
    assertion(deniedTicketMessages === 0, 'revoked internal note left no persisted message');
    owned.messageIds.push(...(await models.HelpdeskMessage.find({
      companyId: primary.companyId,
      ticketId: revocationWinsTicket.id,
    }).select('_id').lean()).map((row) => row._id));

    await assertNotFound(() => services.conversationService.createMessage(buildMessageInput({
      tenant: primary,
      ticket: revocationWinsTicket,
      actor: primary.users.agentA,
      body: 'synthetic internal note after revocation',
      messageType: 'INTERNAL',
    })), 'a revoked agent cannot add internal notes');
    await assertNotFound(() => services.ticketService.updateStatus({
      companyId: primary.companyId,
      actorId: primary.users.agentA._id,
      ticketNumber: revocationWinsTicket.ticketNumber,
      status: 'in_progress',
    }), 'a revoked agent cannot change ticket status');
    await assertNotFound(() => services.ticketService.claimTicket({
      companyId: primary.companyId,
      actorId: primary.users.agentA._id,
      ticketNumber: revocationWinsTicket.ticketNumber,
    }), 'a revoked agent cannot claim a ticket');
    await assertNotFound(() => services.ticketService.updatePriority({
      companyId: primary.companyId,
      actorId: primary.users.agentA._id,
      ticketNumber: revocationWinsTicket.ticketNumber,
      priority: 'high',
    }), 'a revoked agent cannot change ticket priority');
    console.log('PASS: revocation commit before message and revoked-agent restrictions');

    currentCase = 'confidential-ticket authorization';
    const confidentialTicket = await createTicketFixture({
      tenant: primary,
      subject: 'Fence confidential authorization',
      confidential: true,
      models,
      services,
      owned,
    });
    await assertNotFound(() => services.conversationService.createMessage(buildMessageInput({
      tenant: primary,
      ticket: confidentialTicket,
      actor: primary.users.agentB,
      body: 'unauthorized confidential message',
      messageType: 'INTERNAL',
    })), 'ordinary queue agent cannot write to a confidential ticket');
    await assertNotFound(() => services.conversationService.createMessage(buildMessageInput({
      tenant: primary,
      ticket: confidentialTicket,
      actor: primary.users.manager,
      body: 'unauthorized confidential manager note',
      messageType: 'INTERNAL',
    })), 'queue manager does not bypass confidential-agent allowlist');
    const confidentialAllowedMessage = await services.conversationService.createMessage(buildMessageInput({
      tenant: primary,
      ticket: confidentialTicket,
      actor: primary.users.restrictedAgent,
      body: 'authorized confidential internal note',
      messageType: 'INTERNAL',
    }));
    const confidentialRows = await models.HelpdeskMessage.find({
      companyId: primary.companyId,
      ticketId: confidentialTicket.id,
    }).select('_id messageType').lean();
    owned.messageIds.push(...confidentialRows.map((row) => row._id));
    assertion(confidentialRows.length === 1 && confidentialRows[0].messageType === 'INTERNAL', 'only the allowlisted confidential agent persisted a note');
    owned.messageIds.push(new mongoose.Types.ObjectId(confidentialAllowedMessage.id));
    console.log('PASS: confidential-ticket authorization');

    currentCase = 'concurrent message sequencing and transaction retry';
    const sequenceTicket = await createTicketFixture({
      tenant: primary,
      subject: 'Fence concurrent message sequencing',
      models,
      services,
      owned,
    });
    const sequenceGate = services.armFenceBarrier({
      label: 'message',
      queueId: primary.queueId,
      userIds: [primary.users.agentB._id, primary.users.restrictedAgent._id],
      arrivals: 2,
    });
    const concurrentWrites = [
      settle(services.conversationService.createMessage(buildMessageInput({
        tenant: primary,
        ticket: sequenceTicket,
        actor: primary.users.agentB,
        body: 'concurrent public sequence probe',
      }))),
      settle(services.conversationService.createMessage(buildMessageInput({
        tenant: primary,
        ticket: sequenceTicket,
        actor: primary.users.restrictedAgent,
        body: 'concurrent internal sequence probe',
        messageType: 'INTERNAL',
      }))),
    ];
    let sequenceBarrierFailure = null;
    try {
      await sequenceGate.waitForArrivals();
    } catch (error) {
      sequenceBarrierFailure = error;
    } finally {
      sequenceGate.release();
    }
    const sequenceOutcomes = await Promise.all(concurrentWrites);
    if (sequenceBarrierFailure) throw sequenceBarrierFailure;
    assertion(sequenceOutcomes.every((outcome) => outcome.ok), 'both concurrent message transactions completed');
    const sequenceRows = await models.HelpdeskMessage.find({
      companyId: primary.companyId,
      ticketId: sequenceTicket.id,
    }).select('_id sequence publicSequence messageType').sort({ sequence: 1 }).lean();
    owned.messageIds.push(...sequenceRows.map((row) => row._id));
    const sequenceCounters = await models.HelpdeskTicket.findOne({
      _id: sequenceTicket.id,
      companyId: primary.companyId,
    }).select('lastMessageSequence lastPublicMessageSequence').lean();
    assertion(sequenceRows.length === 2, 'both concurrent messages persisted');
    assertion(sequenceRows[0].sequence === 1 && sequenceRows[1].sequence === 2, 'total message sequence is unique and monotonic');
    assertion(sequenceRows.filter((row) => row.messageType === 'PUBLIC' && row.publicSequence === 1).length === 1, 'public sequence advances independently');
    assertion(sequenceRows.filter((row) => row.messageType === 'INTERNAL' && row.publicSequence == null).length === 1, 'internal note has no public sequence');
    assertion(sequenceCounters?.lastMessageSequence === 2 && sequenceCounters?.lastPublicMessageSequence === 1, 'ticket counters match committed messages');
    console.log('PASS: concurrent message sequencing and transaction retry');

    currentCase = 'attachment authorization without Cloudinary';
    const authorizedAttachmentTicket = await createTicketFixture({
      tenant: primary,
      subject: 'Fence in-memory attachment authorization',
      models,
      services,
      owned,
    });
    const syntheticPdf = Buffer.from('%PDF-1.4\n% harness-only fixture\n');
    const attachmentMessage = await services.conversationService.createMessageWithAttachment({
      ...buildMessageInput({
        tenant: primary,
        ticket: authorizedAttachmentTicket,
        actor: primary.users.restrictedAgent,
        body: 'authorized in-memory attachment fixture',
      }),
      file: {
        originalname: 'harness-fixture.pdf',
        mimetype: 'application/pdf',
        buffer: syntheticPdf,
      },
    });
    const attachmentMessageId = new mongoose.Types.ObjectId(attachmentMessage.id);
    const authorizedAttachmentId = new mongoose.Types.ObjectId(attachmentMessage.attachments[0].attachmentId);
    owned.messageIds.push(attachmentMessageId);
    owned.attachmentIds.push(authorizedAttachmentId);
    const attachmentMessageRow = await models.HelpdeskMessage.findOne({
      _id: attachmentMessageId,
      companyId: primary.companyId,
      ticketId: authorizedAttachmentTicket.id,
    }).select('_id attachmentId').lean();
    const attachmentRow = await models.HelpdeskAttachment.findOne({
      _id: authorizedAttachmentId,
      companyId: primary.companyId,
      ticketId: authorizedAttachmentTicket.id,
      messageId: attachmentMessageId,
    }).select('_id +persistenceStatus').lean();
    assertion(Boolean(attachmentMessageRow?.attachmentId), 'authorized attachment message committed');
    assertion(attachmentRow?.persistenceStatus === 'ACTIVE', 'attachment metadata activated in the Mongo transaction');
    assertion(services.privateFiles.size === 1, 'attachment bytes stayed in the injected in-memory store');

    const deniedAttachmentTicket = await createTicketFixture({
      tenant: primary,
      subject: 'Fence revoked attachment authorization',
      models,
      services,
      owned,
    });
    const storageGate = services.armStorageBarrier({ ticketId: deniedAttachmentTicket.id });
    const rejectedAttachmentWrite = services.conversationService.createMessageWithAttachment({
      ...buildMessageInput({
        tenant: primary,
        ticket: deniedAttachmentTicket,
        actor: primary.users.agentB,
        body: 'revoked attachment authorization probe',
      }),
      file: {
        originalname: 'revoked-fixture.pdf',
        mimetype: 'application/pdf',
        buffer: syntheticPdf,
      },
    });
    const attachmentOrdering = await executeWithGate(
      storageGate,
      rejectedAttachmentWrite,
      () => updateQueueAgents({
        tenant: primary,
        services,
        agentIds: primary.queueAgentIds.filter((id) => idString(id) !== idString(primary.users.agentB._id)),
      }),
    );
    assertion(attachmentOrdering.interactionResult.ok, 'agent revocation committed while attachment bytes were staged');
    assertion(!attachmentOrdering.blockedResult.ok && Number(attachmentOrdering.blockedResult.error?.statusCode) === 404, 'attachment message was denied after final authorization refresh');
    const deniedAttachmentMessageCount = await models.HelpdeskMessage.countDocuments({
      companyId: primary.companyId,
      ticketId: deniedAttachmentTicket.id,
    });
    const deniedAttachmentCount = await models.HelpdeskAttachment.countDocuments({
      companyId: primary.companyId,
      ticketId: deniedAttachmentTicket.id,
    });
    owned.messageIds.push(...(await models.HelpdeskMessage.find({
      companyId: primary.companyId,
      ticketId: deniedAttachmentTicket.id,
    }).select('_id').lean()).map((row) => row._id));
    owned.attachmentIds.push(...(await models.HelpdeskAttachment.find({
      companyId: primary.companyId,
      ticketId: deniedAttachmentTicket.id,
    }).select('_id').lean()).map((row) => row._id));
    assertion(deniedAttachmentMessageCount === 0 && deniedAttachmentCount === 0, 'revoked attachment left no Mongo message or metadata');
    assertion(services.privateFiles.size === 1, 'failed authorization compensated only its in-memory staged bytes');
    console.log('PASS: attachment authorization without Cloudinary');

    // Retain exact fixture references for cleanup if a test completed before a later failure.
    owned.ticketIds = uniqueIds(owned.ticketIds);
    owned.messageIds = uniqueIds(owned.messageIds);
    owned.attachmentIds = uniqueIds(owned.attachmentIds);
  } catch (error) {
    testFailure = error;
    console.error(`FAIL: ${currentCase} (${classNameOf(error)}).`);
  } finally {
    try {
      await cleanupOwnedRecords({ owned, models: modelRegistry, privateFiles: services.privateFiles });
      console.log('PASS: exact-identifier cleanup');
    } catch (error) {
      cleanupFailure = error;
      console.error(`FAIL: exact-identifier cleanup (${classNameOf(error)}).`);
    }
    try {
      await mongoose.disconnect();
    } catch (error) {
      cleanupFailure ||= error;
      console.error(`FAIL: MongoDB session shutdown (${classNameOf(error)}).`);
    }
  }

  if (testFailure || cleanupFailure) process.exitCode = 1;
  if (!testFailure && !cleanupFailure) {
    console.log('Helpdesk staging integration harness completed; staging acceptance remains with the developer.');
  }
};

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  runHarness().catch((error) => {
    console.error(`FAIL: staging harness stopped safely (${classNameOf(error)}).`);
    mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}
