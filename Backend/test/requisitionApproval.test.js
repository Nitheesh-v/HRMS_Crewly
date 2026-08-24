import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  { default: AuditLog },
  { default: JobRequisition },
  { default: Notification },
  {
    approveRequisition,
    rejectRequisition,
    sendBackRequisition,
  },
  {
    approveRequisitionRules,
    rejectRequisitionRules,
    sendBackRequisitionRules,
  },
  { DEFAULT_ROLE_MATRIX },
] = await Promise.all([
  import('../src/models/AuditLog.js'),
  import('../src/models/JobRequisition.js'),
  import('../src/models/Notification.js'),
  import('../src/services/requisitionService.js'),
  import('../src/validators/requisitionValidator.js'),
  import('../src/utils/permissionRegistry.js'),
]);

const runRules = async (rules, body = {}) => {
  const req = { body };

  for (const rule of rules) {
    await new Promise((resolve, reject) => {
      const next = (error) => (error ? reject(error) : resolve());

      try {
        const result = rule(req, {}, next);
        if (result?.catch) result.catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  return req;
};

const populatedQuery = (value) => ({
  populate() {
    return this;
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  },
});

const requestContext = (comment = '') => ({
  req: {
    companyId: 'company-a',
    method: 'POST',
    originalUrl: '/api/recruitment/requisitions/requisition-1/approve',
    headers: {},
    user: {
      _id: 'reviewer-1',
      name: 'HR Reviewer',
      role: 'HR_MANAGER',
    },
  },
  requisitionId: 'requisition-1',
  comment,
});

const pendingRequisition = {
  _id: 'requisition-1',
  companyId: 'company-a',
  requisitionNumber: 'JR-0001',
  position: 'Software Engineer',
  requester: 'requester-1',
  status: 'PENDING_HR',
  latestReview: {
    decision: '',
    reviewedBy: null,
    reviewedAt: null,
    comment: '',
  },
  history: [],
};

test('Phase 27.2 role defaults grant decisions only to Company Admin and HR Manager', () => {
  const decisions = [
    'REQUISITION_APPROVE',
    'REQUISITION_REJECT',
    'REQUISITION_SEND_BACK',
  ];

  for (const role of ['COMPANY_ADMIN', 'HR_MANAGER']) {
    for (const permission of decisions) {
      assert.equal(DEFAULT_ROLE_MATRIX[role].includes(permission), true);
    }
  }

  for (const role of ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE']) {
    for (const permission of decisions) {
      assert.equal(DEFAULT_ROLE_MATRIX[role].includes(permission), false);
    }
  }
});

test('review validators enforce required rejection and send-back comments', async () => {
  await runRules(approveRequisitionRules, {});
  await runRules(approveRequisitionRules, { comment: 'Approved within budget' });

  await assert.rejects(
    runRules(rejectRequisitionRules, { comment: '   ' }),
    (error) => error.statusCode === 400 && /rejection reason/i.test(error.message)
  );

  await assert.rejects(
    runRules(sendBackRequisitionRules, {}),
    (error) => error.statusCode === 400 && /send-back comment/i.test(error.message)
  );

  await assert.rejects(
    runRules(sendBackRequisitionRules, { comment: 'x'.repeat(501) }),
    (error) => error.statusCode === 400 && /500 characters/i.test(error.message)
  );
});

test('all decisions use an atomic tenant-and-status filter and preserve review evidence', async () => {
  const originalFindOne = JobRequisition.findOne;
  const originalFindOneAndUpdate = JobRequisition.findOneAndUpdate;
  const originalAuditCreate = AuditLog.create;
  const originalNotificationCreate = Notification.create;

  const cases = [
    {
      decision: 'APPROVED',
      comment: '',
      service: approveRequisition,
      historyAction: 'REQUISITION_APPROVED',
    },
    {
      decision: 'REJECTED',
      comment: 'Budget is not approved',
      service: rejectRequisition,
      historyAction: 'REQUISITION_REJECTED',
    },
    {
      decision: 'SENT_BACK',
      comment: 'Add the replacement employee details',
      service: sendBackRequisition,
      historyAction: 'REQUISITION_SENT_BACK',
    },
  ];

  try {
    for (const reviewCase of cases) {
      let atomicCall;
      let auditPayload;
      let notificationPayload;

      JobRequisition.findOne = (filter) => ({
        select() {
          return this;
        },
        lean: async () => {
          assert.equal(filter.companyId, 'company-a');
          return { ...pendingRequisition };
        },
      });

      JobRequisition.findOneAndUpdate = (filter, update, options) => {
        atomicCall = { filter, update, options };

        const latestReview = update.$set.latestReview;
        const document = {
          ...pendingRequisition,
          status: update.$set.status,
          latestReview,
          lastModifiedBy: 'reviewer-1',
          history: [update.$push.history],
          toObject() {
            return {
              ...this,
              toObject: undefined,
            };
          },
        };

        return populatedQuery(document);
      };

      AuditLog.create = async (payload) => {
        auditPayload = payload;
        return payload;
      };

      Notification.create = async (payload) => {
        notificationPayload = payload;
        return payload;
      };

      const result = await reviewCase.service(
        requestContext(reviewCase.comment)
      );

      assert.deepEqual(atomicCall.filter, {
        _id: 'requisition-1',
        companyId: 'company-a',
        status: 'PENDING_HR',
      });
      assert.equal(atomicCall.options.new, true);
      assert.equal(atomicCall.options.runValidators, true);
      assert.equal(atomicCall.update.$set.status, reviewCase.decision);
      assert.equal(
        atomicCall.update.$set.latestReview.reviewedBy,
        'reviewer-1'
      );
      assert.equal(
        atomicCall.update.$set.latestReview.comment,
        reviewCase.comment
      );
      assert.equal(
        atomicCall.update.$push.history.action,
        reviewCase.historyAction
      );
      assert.equal(
        atomicCall.update.$push.history.fromStatus,
        'PENDING_HR'
      );
      assert.equal(
        atomicCall.update.$push.history.toStatus,
        reviewCase.decision
      );
      assert.equal(auditPayload.action, reviewCase.historyAction);
      assert.equal(auditPayload.method, 'POST');
      assert.equal(auditPayload.targetUser, 'requester-1');
      assert.equal(notificationPayload.user, 'requester-1');
      assert.equal(notificationPayload.companyId, 'company-a');
      assert.equal(result.status, reviewCase.decision);
    }
  } finally {
    JobRequisition.findOne = originalFindOne;
    JobRequisition.findOneAndUpdate = originalFindOneAndUpdate;
    AuditLog.create = originalAuditCreate;
    Notification.create = originalNotificationCreate;
  }
});

test('a simultaneous second decision loses the pending-status compare-and-set', async () => {
  const originalFindOne = JobRequisition.findOne;
  const originalFindOneAndUpdate = JobRequisition.findOneAndUpdate;

  try {
    JobRequisition.findOne = () => ({
      select() {
        return this;
      },
      lean: async () => ({ ...pendingRequisition }),
    });
    JobRequisition.findOneAndUpdate = () => populatedQuery(null);

    await assert.rejects(
      approveRequisition(requestContext()),
      (error) => error.statusCode === 409 && /another reviewer/i.test(error.message)
    );
  } finally {
    JobRequisition.findOne = originalFindOne;
    JobRequisition.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('cross-tenant decision attempts return not found and retain company filtering', async () => {
  const originalFindOne = JobRequisition.findOne;
  const seenFilters = [];

  try {
    JobRequisition.findOne = (filter) => {
      seenFilters.push(filter);
      return {
        select() {
          return this;
        },
        lean: async () => null,
      };
    };

    await assert.rejects(
      approveRequisition(requestContext()),
      (error) => error.statusCode === 404
    );

    assert.equal(seenFilters.length, 2);
    assert.equal(
      seenFilters.every((filter) => filter.companyId === 'company-a'),
      true
    );
  } finally {
    JobRequisition.findOne = originalFindOne;
  }
});

test('API routes expose the three exact-permission decision endpoints', async () => {
  const routeSource = await readFile(
    new URL('../src/routes/recruitmentRoutes.js', import.meta.url),
    'utf8'
  );

  const expectations = [
    ['/requisitions/:id/approve', 'REQUISITION_APPROVE'],
    ['/requisitions/:id/reject', 'REQUISITION_REJECT'],
    ['/requisitions/:id/send-back', 'REQUISITION_SEND_BACK'],
  ];

  for (const [path, permission] of expectations) {
    const routeIndex = routeSource.indexOf(`'${path}'`);
    const permissionIndex = routeSource.indexOf(
      `requirePermission('${permission}')`,
      routeIndex
    );

    assert.notEqual(routeIndex, -1);
    assert.notEqual(permissionIndex, -1);
    assert.equal(permissionIndex - routeIndex < 250, true);
  }
});
