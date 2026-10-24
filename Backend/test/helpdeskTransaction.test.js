import assert from 'node:assert/strict';
import test from 'node:test';

import { runHelpdeskTransaction } from '../src/services/helpdesk/helpdeskTransaction.js';
import { helpdeskTenantConfigService } from '../src/services/helpdesk/helpdeskTenantConfigService.js';

const labelledError = (message, label) => {
  const error = new Error(message);
  error.errorLabels = [label];
  return error;
};

const makeSession = ({ commit = async () => {} } = {}) => {
  const calls = { starts: 0, commits: 0, aborts: 0, ends: 0, options: [] };
  let active = false;
  const session = {
    calls,
    startTransaction(options) {
      calls.starts += 1;
      calls.options.push(options);
      active = true;
    },
    inTransaction() { return active; },
    async commitTransaction() {
      calls.commits += 1;
      await commit(calls.commits, session);
      active = false;
    },
    async abortTransaction() {
      calls.aborts += 1;
      active = false;
    },
    async endSession() {
      calls.ends += 1;
      active = false;
    },
  };
  return session;
};

test('transient work conflicts retry the callback and refresh the authorization read', async () => {
  let authorized = true;
  const observations = [];
  const sessions = [];
  const startSession = () => {
    const session = makeSession();
    sessions.push(session);
    return session;
  };

  await assert.rejects(
    runHelpdeskTransaction(async (_session, attempt) => {
      observations.push({ attempt, authorized });
      if (attempt === 0) {
        authorized = false;
        throw labelledError('snapshot conflicted', 'TransientTransactionError');
      }
      if (!authorized) {
        const error = new Error('membership was revoked');
        error.statusCode = 404;
        throw error;
      }
      return 'unreachable';
    }, { startSession, maxAttempts: 3 }),
    (error) => error.statusCode === 404,
  );

  assert.deepEqual(observations, [
    { attempt: 0, authorized: true },
    { attempt: 1, authorized: false },
  ]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].calls.aborts, 1);
  assert.equal(sessions[1].calls.aborts, 1);
  assert.equal(sessions.every((session) => session.calls.ends === 1), true);
});

test('transient transaction conflicts are retried only up to the configured bounded attempts', async () => {
  const sessions = [];
  let workCalls = 0;
  await assert.rejects(
    runHelpdeskTransaction(async () => {
      workCalls += 1;
      throw labelledError('still conflicted', 'TransientTransactionError');
    }, {
      startSession: () => {
        const session = makeSession();
        sessions.push(session);
        return session;
      },
      maxAttempts: 2,
    }),
    (error) => error.statusCode === 503,
  );
  assert.equal(workCalls, 2);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((session) => session.calls.aborts === 1 && session.calls.ends === 1));
});

test('unknown commit results retry commit only and never blindly replay the transaction callback', async () => {
  let workCalls = 0;
  let commitCalls = 0;
  const session = makeSession({
    commit: async () => {
      commitCalls += 1;
      throw labelledError('commit acknowledgement is uncertain', 'UnknownTransactionCommitResult');
    },
  });

  await assert.rejects(
    runHelpdeskTransaction(async () => {
      workCalls += 1;
      return 'single write attempt';
    }, {
      startSession: () => session,
      maxAttempts: 5,
      maxCommitAttempts: 3,
    }),
    (error) => error.statusCode === 503 && error.commitOutcomeUnknown === true,
  );

  assert.equal(workCalls, 1);
  assert.equal(commitCalls, 3);
  assert.equal(session.calls.aborts, 0);
  assert.equal(session.calls.ends, 1);
});

test('session-backed tenant config reads preserve Mongo transient labels for transaction retry', async () => {
  const session = { id: 'session-for-config-read' };
  const driverError = labelledError('transient config snapshot conflict', 'TransientTransactionError');
  const query = {
    session(received) {
      assert.equal(received, session);
      return this;
    },
    lean() { return this; },
    then(onFulfilled, onRejected) {
      return Promise.reject(driverError).then(onFulfilled, onRejected);
    },
  };
  const service = helpdeskTenantConfigService({
    ConfigModel: { findOne: () => query },
  });

  await assert.rejects(
    service.readConfig({ companyId: '000000000000000000000064', session }),
    (error) => error === driverError && error.errorLabels.includes('TransientTransactionError'),
  );
});

test('unlabelled commit network errors are treated as uncertain and are not replayed', async () => {
  let workCalls = 0;
  let commitCalls = 0;
  const session = makeSession({
    commit: async () => {
      commitCalls += 1;
      throw new Error('connection lost after commit request');
    },
  });

  await assert.rejects(
    runHelpdeskTransaction(async () => {
      workCalls += 1;
      return 'single write attempt';
    }, { startSession: () => session }),
    (error) => error.statusCode === 503 && error.commitOutcomeUnknown === true,
  );
  assert.equal(workCalls, 1);
  assert.equal(commitCalls, 1);
  assert.equal(session.calls.aborts, 0);
});
