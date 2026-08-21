import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  { default: AuditLog },
  { default: Department },
  { default: JobPosting },
  { default: JobRequisition },
  { default: Notification },
  { createJobFromRequisition },
  { createJobFromRequisitionRules },
] = await Promise.all([
  import('../src/models/AuditLog.js'),
  import('../src/models/Department.js'),
  import('../src/models/JobPosting.js'),
  import('../src/models/JobRequisition.js'),
  import('../src/models/Notification.js'),
  import('../src/services/requisitionService.js'),
  import('../src/validators/requisitionValidator.js'),
]);

const requestContext = (payload = {}) => ({
  req: {
    companyId: 'company-a',
    method: 'POST',
    originalUrl: '/api/recruitment/requisitions/requisition-1/create-job',
    headers: {},
    user: {
      _id: 'hr-1',
      name: 'HR Reviewer',
      role: 'HR_MANAGER',
    },
  },
  requisitionId: 'requisition-1',
  payload,
});

const approvedRequisition = {
  _id: 'requisition-1',
  companyId: 'company-a',
  requisitionNumber: 'JR-0001',
  department: 'department-1',
  team: 'Platform',
  position: 'Software Engineer',
  openings: 3,
  experienceLevel: 'EXPERIENCED',
  minExperience: 2,
  maxExperience: 5,
  requiredSkills: ['React', 'Node.js'],
  preferredSkills: ['Redis'],
  salaryMin: 20000,
  salaryMax: 40000,
  hiringBudget: 500000,
  employmentType: 'FULL_TIME',
  workMode: 'HYBRID',
  location: 'Chennai',
  hiringReason: 'EXPANSION',
  hiringReasonDetails: 'New product team',
  priority: 'HIGH',
  expectedJoiningDate: new Date('2026-10-01T00:00:00.000Z'),
  requester: 'requester-1',
  status: 'APPROVED',
  jobPosting: null,
  history: [],
};

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

const selectableQuery = (value) => ({
  select() {
    return Promise.resolve(value);
  },
});

const restoreMethods = (entries) => {
  entries.forEach(([target, name, method]) => {
    target[name] = method;
  });
};

test('job source index permits only one job per tenant requisition', () => {
  const sourceIndex = JobPosting.schema.indexes().find(
    ([fields]) => fields.companyId === 1 && fields.sourceRequisition === 1
  );

  assert.ok(sourceIndex);
  assert.equal(sourceIndex[1].unique, true);
  assert.deepEqual(sourceIndex[1].partialFilterExpression, {
    sourceRequisition: { $type: 'objectId' },
  });
});

test('create-job validator limits the editable description', async () => {
  await runRules(createJobFromRequisitionRules, {});
  await runRules(createJobFromRequisitionRules, {
    description: 'Role responsibilities',
  });

  await assert.rejects(
    runRules(createJobFromRequisitionRules, {
      description: 'x'.repeat(2001),
    }),
    (error) => error.statusCode === 400 && /2000 characters/i.test(error.message)
  );
});

test('approved requisition creates one linked job with tenant-owned approved data', async () => {
  const originals = [
    [JobRequisition, 'findOne', JobRequisition.findOne],
    [JobRequisition, 'findOneAndUpdate', JobRequisition.findOneAndUpdate],
    [JobPosting, 'findOne', JobPosting.findOne],
    [JobPosting, 'create', JobPosting.create],
    [Department, 'findOne', Department.findOne],
    [AuditLog, 'create', AuditLog.create],
    [Notification, 'create', Notification.create],
  ];

  let requisitionFilter;
  let duplicateFilter;
  let departmentFilter;
  let jobPayload;
  let linkCall;
  let auditPayload;
  let notificationPayload;

  try {
    JobRequisition.findOne = async (filter) => {
      requisitionFilter = filter;
      return { ...approvedRequisition };
    };
    JobPosting.findOne = (filter) => {
      duplicateFilter = filter;
      return selectableQuery(null);
    };
    Department.findOne = (filter) => {
      departmentFilter = filter;
      return selectableQuery({ _id: 'department-1' });
    };
    JobPosting.create = async (payload) => {
      jobPayload = payload;
      return {
        _id: 'job-1',
        ...payload,
        populate: async () => {},
        toObject() {
          return { ...payload, _id: 'job-1' };
        },
      };
    };
    JobRequisition.findOneAndUpdate = async (filter, update, options) => {
      linkCall = { filter, update, options };
      return {
        ...approvedRequisition,
        jobPosting: 'job-1',
        jobCreatedBy: 'hr-1',
        jobCreatedAt: update.$set.jobCreatedAt,
      };
    };
    AuditLog.create = async (payload) => {
      auditPayload = payload;
      return payload;
    };
    Notification.create = async (payload) => {
      notificationPayload = payload;
      return payload;
    };

    const result = await createJobFromRequisition(
      requestContext({
        description: '  Refined role description  ',
        companyId: 'company-b',
        openings: 999,
      })
    );

    assert.deepEqual(requisitionFilter, {
      _id: 'requisition-1',
      companyId: 'company-a',
    });
    assert.deepEqual(duplicateFilter, {
      companyId: 'company-a',
      sourceRequisition: 'requisition-1',
    });
    assert.equal(departmentFilter.companyId, 'company-a');
    assert.equal(jobPayload.companyId, 'company-a');
    assert.equal(jobPayload.sourceRequisition, 'requisition-1');
    assert.equal(jobPayload.sourceRequisitionNumber, 'JR-0001');
    assert.equal(jobPayload.title, 'Software Engineer');
    assert.equal(jobPayload.openings, 3);
    assert.equal(jobPayload.department, 'department-1');
    assert.deepEqual(jobPayload.requiredSkills, ['React', 'Node.js']);
    assert.deepEqual(jobPayload.preferredSkills, ['Redis']);
    assert.equal(jobPayload.salaryMin, 20000);
    assert.equal(jobPayload.salaryMax, 40000);
    assert.equal(jobPayload.hiringBudget, 500000);
    assert.equal(jobPayload.workMode, 'HYBRID');
    assert.equal(jobPayload.description, 'Refined role description');
    assert.equal(jobPayload.createdBy, 'hr-1');
    assert.deepEqual(linkCall.filter, {
      _id: 'requisition-1',
      companyId: 'company-a',
      status: 'APPROVED',
      jobPosting: null,
    });
    assert.equal(linkCall.options.new, true);
    assert.equal(linkCall.options.runValidators, true);
    assert.equal(linkCall.update.$set.jobPosting, 'job-1');
    assert.equal(
      linkCall.update.$push.history.action,
      'REQUISITION_JOB_CREATED'
    );
    assert.equal(auditPayload.action, 'REQUISITION_JOB_CREATED');
    assert.equal(auditPayload.method, 'POST');
    assert.equal(auditPayload.targetUser, 'requester-1');
    assert.equal(notificationPayload.companyId, 'company-a');
    assert.equal(notificationPayload.user, 'requester-1');
    assert.equal(result._id, 'job-1');
  } finally {
    restoreMethods(originals);
  }
});

test('non-approved and cross-tenant requisitions cannot create jobs', async () => {
  const originalFindOne = JobRequisition.findOne;

  try {
    JobRequisition.findOne = async (filter) => {
      assert.equal(filter.companyId, 'company-a');
      return null;
    };

    await assert.rejects(
      createJobFromRequisition(requestContext()),
      (error) => error.statusCode === 404
    );

    JobRequisition.findOne = async () => ({
      ...approvedRequisition,
      status: 'PENDING_HR',
    });

    await assert.rejects(
      createJobFromRequisition(requestContext()),
      (error) => error.statusCode === 409 && /only an approved/i.test(error.message)
    );
  } finally {
    JobRequisition.findOne = originalFindOne;
  }
});

test('existing linkage blocks duplicate job creation before insertion', async () => {
  const originalFindOne = JobRequisition.findOne;
  const originalCreate = JobPosting.create;
  let createCalled = false;

  try {
    JobRequisition.findOne = async () => ({
      ...approvedRequisition,
      jobPosting: 'job-existing',
    });
    JobPosting.create = async () => {
      createCalled = true;
      return null;
    };

    await assert.rejects(
      createJobFromRequisition(requestContext()),
      (error) => error.statusCode === 409 && /already been created/i.test(error.message)
    );
    assert.equal(createCalled, false);
  } finally {
    JobRequisition.findOne = originalFindOne;
    JobPosting.create = originalCreate;
  }
});

test('a lost atomic link race removes the unlinked job and returns conflict', async () => {
  const originals = [
    [JobRequisition, 'findOne', JobRequisition.findOne],
    [JobRequisition, 'findOneAndUpdate', JobRequisition.findOneAndUpdate],
    [JobPosting, 'findOne', JobPosting.findOne],
    [JobPosting, 'create', JobPosting.create],
    [JobPosting, 'deleteOne', JobPosting.deleteOne],
    [Department, 'findOne', Department.findOne],
  ];
  let deleteFilter;

  try {
    JobRequisition.findOne = async () => ({ ...approvedRequisition });
    JobPosting.findOne = () => selectableQuery(null);
    Department.findOne = () => selectableQuery({ _id: 'department-1' });
    JobPosting.create = async (payload) => ({
      _id: 'job-loser',
      title: payload.title,
    });
    JobRequisition.findOneAndUpdate = async () => null;
    JobPosting.deleteOne = async (filter) => {
      deleteFilter = filter;
      return { deletedCount: 1 };
    };

    await assert.rejects(
      createJobFromRequisition(requestContext()),
      (error) => error.statusCode === 409 && /another HR user/i.test(error.message)
    );

    assert.deepEqual(deleteFilter, {
      _id: 'job-loser',
      companyId: 'company-a',
      sourceRequisition: 'requisition-1',
    });
  } finally {
    restoreMethods(originals);
  }
});

test('API route requires recruitment create permission and job posting quota', async () => {
  const routeSource = await readFile(
    new URL('../src/routes/recruitmentRoutes.js', import.meta.url),
    'utf8'
  );
  const routeIndex = routeSource.indexOf(
    "'/requisitions/:id/create-job'"
  );
  const permissionIndex = routeSource.indexOf(
    "requirePermission('RECRUITMENT_CREATE')",
    routeIndex
  );
  const quotaIndex = routeSource.indexOf(
    "checkUsageLimit('jobPostingsMonthly')",
    routeIndex
  );

  assert.notEqual(routeIndex, -1);
  assert.notEqual(permissionIndex, -1);
  assert.notEqual(quotaIndex, -1);
  assert.equal(permissionIndex - routeIndex < 250, true);
  assert.equal(quotaIndex - routeIndex < 300, true);
});
