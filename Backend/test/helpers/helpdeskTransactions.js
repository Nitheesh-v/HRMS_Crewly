import { runHelpdeskTransaction } from '../../src/services/helpdesk/helpdeskTransaction.js';

export const runFakeHelpdeskTransaction = async (work) =>
  work({ id: 'fake-helpdesk-session' });

export const makeFakeHelpdeskLifecycleEventModel = () => {
  const rows = [];
  return {
    rows,
    async create(documents, options = {}) {
      const inserted = (Array.isArray(documents) ? documents : [documents]).map((document) => ({
        ...structuredClone(document),
      }));
      rows.push(...inserted);
      return inserted;
    },
  };
};

export const makeFakeHelpdeskFenceModel = () => {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    async bulkWrite(operations, options = {}) {
      calls.push({
        operations: operations.map((operation) => ({
          filter: { ...operation.updateOne.filter },
          update: structuredClone(operation.updateOne.update),
          upsert: operation.updateOne.upsert,
        })),
        hasSession: Boolean(options.session),
      });
      for (const operation of operations) {
        const { filter, update, upsert } = operation.updateOne;
        const key = `${String(filter.companyId)}:${String(filter.queueId)}:${String(filter.userId).toLowerCase()}`;
        let row = rows.get(key);
        if (!row && upsert) {
          row = { ...filter, writeVersion: 0 };
          rows.set(key, row);
        }
        if (row) row.writeVersion += Number(update.$inc?.writeVersion || 0);
      }
      return { acknowledged: true, matchedCount: operations.length, modifiedCount: operations.length };
    },
  };
};

export const makeHelpdeskFenceRaceHarness = ({ FenceModel, pauseWhen = () => false } = {}) => {
  if (!FenceModel?.rows || typeof FenceModel.bulkWrite !== 'function') {
    throw new TypeError('A fake Helpdesk fence model is required');
  }
  let transactionNumber = 0;
  let pauseUsed = false;
  let releasePausedWrite;
  let notifyPausedWrite;
  const pausedWrite = new Promise((resolve) => { notifyPausedWrite = resolve; });
  const releaseGate = new Promise((resolve) => { releasePausedWrite = resolve; });
  const originalBulkWrite = FenceModel.bulkWrite.bind(FenceModel);
  const raceAttempts = [];
  FenceModel.raceAttempts = raceAttempts;
  const fenceKey = ({ companyId, queueId, userId }) =>
    `${String(companyId)}:${String(queueId)}:${String(userId).toLowerCase()}`;

  FenceModel.bulkWrite = async (operations, options = {}) => {
    const session = options.session;
    raceAttempts.push({
      sessionId: session?.id || null,
      operations: operations.map((operation) => ({ filter: { ...operation.updateOne.filter } })),
    });
    if (session && !pauseUsed && pauseWhen({ operations, session })) {
      pauseUsed = true;
      notifyPausedWrite({ operations, session });
      await releaseGate;
    }
    if (session?.fenceSnapshot instanceof Map) {
      for (const operation of operations) {
        const key = fenceKey(operation.updateOne.filter);
        const expectedVersion = session.fenceSnapshot.get(key) || 0;
        const currentVersion = FenceModel.rows.get(key)?.writeVersion || 0;
        if (currentVersion !== expectedVersion) {
          const error = new Error('simulated Helpdesk fence write conflict');
          error.helpdeskTransientTransactionError = true;
          throw error;
        }
      }
    }
    return originalBulkWrite(operations, options);
  };

  const transactionRunner = (work) => runHelpdeskTransaction(work, {
    startSession: () => {
      const session = {
        id: `fake-helpdesk-session-${transactionNumber + 1}`,
        fenceSnapshot: new Map(),
        active: false,
        startTransaction() {
          transactionNumber += 1;
          this.id = `fake-helpdesk-session-${transactionNumber}`;
          this.fenceSnapshot = new Map([...FenceModel.rows].map(([key, row]) => [key, row.writeVersion || 0]));
          this.active = true;
        },
        inTransaction() { return this.active; },
        async commitTransaction() { this.active = false; },
        async abortTransaction() { this.active = false; },
        async endSession() { this.active = false; },
      };
      return session;
    },
  });

  return {
    transactionRunner,
    raceAttempts,
    waitForPausedWrite: () => pausedWrite,
    releasePausedWrite: () => releasePausedWrite(),
    get transactionCount() { return transactionNumber; },
  };
};
