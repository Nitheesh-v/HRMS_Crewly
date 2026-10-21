import assert from 'node:assert/strict';
import test from 'node:test';

import HelpdeskAuthorizationFence from '../src/models/HelpdeskAuthorizationFence.js';
import {
  bumpHelpdeskAuthorizationFence,
  changedHelpdeskQueueFenceUserIds,
  _test as fenceTest,
} from '../src/services/helpdesk/helpdeskAuthorizationFence.js';
import { makeFakeHelpdeskFenceModel } from './helpers/helpdeskTransactions.js';

const oid = (number) => Number(number).toString(16).padStart(24, '0');
const COMPANY = oid(100);
const QUEUE = oid(900);
const USER_A = oid(10);
const USER_B = oid(2);
const USER_C = oid(3);
const MANAGER_A = oid(4);
const MANAGER_B = oid(5);
const REVIEWER = oid(6);

test('authorization fence stores coordination metadata only and declares the exact unique compound index', () => {
  const index = HelpdeskAuthorizationFence.schema.indexes().find(([keys, options]) =>
    options.name === 'helpdesk_authorization_fence_unique',
  );
  assert.ok(index);
  assert.deepEqual(index[0], { companyId: 1, queueId: 1, userId: 1 });
  assert.equal(index[1].unique, true);
  assert.equal(HelpdeskAuthorizationFence.schema.path('agents'), undefined);
  assert.equal(HelpdeskAuthorizationFence.schema.path('managers'), undefined);
  assert.equal(HelpdeskAuthorizationFence.schema.path('activeMembership'), undefined);
});

test('queue revocation identifies old and new agents/managers and confidentiality agents, not reviewers', () => {
  const affected = changedHelpdeskQueueFenceUserIds({
    current: {
      agents: [USER_A, USER_B],
      managers: [MANAGER_A],
      confidentiality: { enabled: true, agentIds: [USER_A], reviewerIds: [REVIEWER] },
    },
    next: {
      agents: [USER_B, USER_C],
      managers: [MANAGER_B],
      confidentiality: { enabled: true, agentIds: [USER_C], reviewerIds: [] },
    },
  });
  assert.deepEqual(affected.sort(), [USER_A, USER_B, USER_C, MANAGER_A, MANAGER_B].sort());

  const confidentialityToggle = changedHelpdeskQueueFenceUserIds({
    current: { agents: [USER_A], managers: [MANAGER_A], confidentiality: { enabled: false, agentIds: [] } },
    next: { agents: [USER_A], managers: [MANAGER_A], confidentiality: { enabled: true, agentIds: [USER_A] } },
  });
  assert.deepEqual(confidentialityToggle.sort(), [USER_A, MANAGER_A].sort());
});

test('fence writes are tenant/queue/principal scoped, session-bound, and deduplicated', async () => {
  const FenceModel = makeFakeHelpdeskFenceModel();
  const session = { id: 'fake-session' };
  await bumpHelpdeskAuthorizationFence({
    FenceModel,
    companyId: COMPANY,
    queueId: QUEUE,
    userIds: [USER_A, USER_A.toUpperCase(), USER_B],
    session,
  });

  assert.equal(FenceModel.calls.length, 1);
  assert.equal(FenceModel.calls[0].hasSession, true);
  assert.deepEqual(
    FenceModel.calls[0].operations.map((operation) => operation.filter.userId.toLowerCase()),
    [USER_A, USER_B],
  );
  assert.ok(FenceModel.calls[0].operations.every((operation) =>
    operation.filter.companyId === COMPANY
      && operation.filter.queueId === QUEUE
      && operation.upsert === true
      && operation.update.$inc.writeVersion === 1,
  ));
  assert.equal(FenceModel.rows.size, 2);
  for (const row of FenceModel.rows.values()) {
    assert.deepEqual(Object.keys(row).sort(), ['companyId', 'queueId', 'userId', 'writeVersion']);
  }
});

test('duplicate-key upsert races are marked transient so the transaction reauthorizes', async () => {
  const FenceModel = {
    async bulkWrite() {
      const error = new Error('unique fence insert raced');
      error.code = 11000;
      throw error;
    },
  };
  await assert.rejects(
    bumpHelpdeskAuthorizationFence({
      FenceModel,
      companyId: COMPANY,
      queueId: QUEUE,
      userIds: [USER_A],
      session: { id: 'fake-session' },
    }),
    (error) => error.name === 'HelpdeskFenceConflictError'
      && error.helpdeskTransientTransactionError === true,
  );
  assert.equal(fenceTest.duplicateKeyOnly({ code: 11000 }), true);
  assert.equal(fenceTest.duplicateKeyOnly({ code: 112 }), false);
});
