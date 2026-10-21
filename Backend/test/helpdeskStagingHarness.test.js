import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertEffectiveDatabase,
  assertRequiredFenceIndex,
  assertStagingOnlyAuthentication,
  assertTransactionTopology,
  createHarnessServices,
  makeExactIdFilter,
  validateOptIn,
} from '../scripts/helpdesk-staging-integration.js';

const validFenceIndex = () => ({
  name: 'helpdesk_authorization_fence_unique',
  key: { companyId: 1, queueId: 1, userId: 1 },
  unique: true,
});

test('staging harness requires both explicit write confirmations', () => {
  assert.equal(validateOptIn([
    '--allow-staging-writes',
    '--confirm-database=crewly_staging',
  ]), true);
  assert.throws(() => validateOptIn([]));
  assert.throws(() => validateOptIn(['--allow-staging-writes']));
  assert.throws(() => validateOptIn([
    '--allow-staging-writes',
    '--confirm-database=production',
  ]));
  assert.throws(() => validateOptIn([
    '--allow-staging-writes',
    '--confirm-database=crewly_staging',
    '--extra',
  ]));
});

test('staging harness accepts only the exact effective database', () => {
  assert.equal(assertEffectiveDatabase('crewly_staging'), true);
  for (const databaseName of ['crewly_prod', 'CREWLY_STAGING', 'test', '', undefined]) {
    assert.throws(() => assertEffectiveDatabase(databaseName));
  }
});

test('staging harness requires one authenticated user with only readWrite on staging', () => {
  const validStatus = {
    authInfo: {
      authenticatedUsers: [{ user: 'harness-user', db: 'admin' }],
      authenticatedUserRoles: [{ role: 'readWrite', db: 'crewly_staging' }],
      authenticatedUserPrivileges: [{
        resource: { db: 'crewly_staging', collection: '' },
        actions: ['find', 'insert', 'update', 'remove'],
      }],
    },
  };
  assert.equal(assertStagingOnlyAuthentication(validStatus), true);
  assert.throws(() => assertStagingOnlyAuthentication({
    authInfo: {
      ...validStatus.authInfo,
      authenticatedUserPrivileges: [{
        resource: { db: 'admin', collection: '' },
        actions: ['find'],
      }],
    },
  }));
  assert.throws(() => assertStagingOnlyAuthentication({
    authInfo: {
      ...validStatus.authInfo,
      authenticatedUserPrivileges: [{
        resource: { cluster: true },
        actions: ['listDatabases'],
      }],
    },
  }));
  assert.throws(() => assertStagingOnlyAuthentication({
    authInfo: {
      authenticatedUsers: [{ user: 'harness-user', db: 'admin' }],
      authenticatedUserRoles: [{ role: 'readWrite', db: 'admin' }],
    },
  }));
  assert.throws(() => assertStagingOnlyAuthentication({
    authInfo: {
      authenticatedUsers: [{ user: 'harness-user', db: 'admin' }],
      authenticatedUserRoles: [
        { role: 'readWrite', db: 'crewly_staging' },
        { role: 'dbAdmin', db: 'crewly_staging' },
      ],
    },
  }));
  assert.throws(() => assertStagingOnlyAuthentication({
    authInfo: {
      authenticatedUsers: [],
      authenticatedUserRoles: [],
    },
  }));
});

test('staging harness requires a transaction-capable replica set or mongos', () => {
  assert.equal(assertTransactionTopology({ setName: 'fixture-rs', maxWireVersion: 17 }), true);
  assert.equal(assertTransactionTopology({ msg: 'isdbgrid', maxWireVersion: 17 }), true);
  assert.throws(() => assertTransactionTopology({ maxWireVersion: 17 }));
  assert.throws(() => assertTransactionTopology({ setName: 'missing-version' }));
  assert.throws(() => assertTransactionTopology({ setName: 'old-rs', maxWireVersion: 6 }));
});

test('staging harness requires the exact unique authorization-fence compound index', () => {
  assert.equal(assertRequiredFenceIndex([validFenceIndex()]), true);
  assert.throws(() => assertRequiredFenceIndex([]));
  assert.throws(() => assertRequiredFenceIndex([{ ...validFenceIndex(), unique: false }]));
  assert.throws(() => assertRequiredFenceIndex([{
    ...validFenceIndex(),
    key: { companyId: 1, userId: 1, queueId: 1 },
  }]));
  assert.throws(() => assertRequiredFenceIndex([{
    ...validFenceIndex(),
    key: { companyId: 1, queueId: 1, userId: 1, extra: 1 },
  }]));
});

test('staging harness disables only disposable Helpdesk notification intents', () => {
  const services = createHarnessServices({
    models: {
      HelpdeskAuthorizationFence: {},
      helpdeskQueueService: (dependencies) => dependencies,
      helpdeskTicketService: (dependencies) => dependencies,
      helpdeskConversationService: (dependencies) => dependencies,
    },
    runHelpdeskTransaction: async () => ({ committed: true }),
  });

  assert.equal(services.ticketService.notificationIntentsEnabled, false);
  assert.equal(services.conversationService.notificationIntentsEnabled, false);
  assert.equal(typeof services.ticketService.transactionRunner, 'function');
  assert.equal(typeof services.conversationService.transactionRunner, 'function');
  assert.equal(typeof services.conversationService.storeAttachment, 'function');
});

test('cleanup filters are limited to exact owned _id values and empty cleanup is a no-op', () => {
  assert.equal(makeExactIdFilter([]), null);
  assert.deepEqual(makeExactIdFilter(['owned-a', 'owned-a', 'owned-b']), {
    _id: { $in: ['owned-a', 'owned-b'] },
  });
  assert.deepEqual(makeExactIdFilter(['owned-a']), {
    _id: { $in: ['owned-a'] },
  });
  assert.throws(() => makeExactIdFilter([undefined]));
});
