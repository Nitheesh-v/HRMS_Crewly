import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_presence_controller_test';

const { default: PresenceTenantConfig } = await import(
  '../src/models/PresenceTenantConfig.js'
);
const { getConfig } = await import('../src/controllers/presenceController.js');

const COMPANY = '111111111111111111111111';

test('GET presence config reads the tenant config and returns it successfully', async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    PresenceTenantConfig,
    'findOneAndUpdate',
  );
  const queryCalls = [];
  Object.defineProperty(PresenceTenantConfig, 'findOneAndUpdate', {
    configurable: true,
    value: async (...args) => {
      queryCalls.push(args);
      return {
        companyId: COMPANY,
        enabled: true,
        employeePresenceVisible: true,
        statusMessagesEnabled: true,
        workLocationEnabled: true,
        wfhMode: 'self_declare',
        awayAfterMinutes: 5,
        offlineAfterMinutes: 15,
        lastSeenVisible: false,
        allowedWorkLocations: ['office', 'wfh', 'remote'],
        updatedBy: null,
      };
    },
  });

  let statusCode;
  let responseBody;
  let middlewareError;
  let settle;
  const responseSent = new Promise((resolve) => {
    settle = resolve;
  });
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      settle();
      return this;
    },
  };

  try {
    getConfig({ companyId: COMPANY }, res, (err) => {
      middlewareError = err;
      settle();
    });
    await responseSent;

    assert.ifError(middlewareError);
    assert.equal(statusCode, 200);
    assert.equal(responseBody.success, true);
    assert.equal(responseBody.message, 'Presence tenant config');
    assert.equal(responseBody.data.companyId, COMPANY);
    assert.equal(responseBody.data.awayAfterMinutes, 5);
    assert.equal(queryCalls.length, 1);
    assert.deepEqual(queryCalls[0][0], { companyId: COMPANY });
    assert.deepEqual(queryCalls[0][1], { $setOnInsert: { companyId: COMPANY } });
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(
        PresenceTenantConfig,
        'findOneAndUpdate',
        originalDescriptor,
      );
    } else {
      delete PresenceTenantConfig.findOneAndUpdate;
    }
  }
});
