import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
process.env.PRIVATE_RESUME_STORAGE_DIR = path.resolve(
  'private_storage/test-candidate-resumes'
);
process.env.NODE_ENV = 'test';

const [
  { default: AuditLog },
  { default: Candidate },
  { default: EmailDelivery },
  { default: CandidateHistory },
  { default: CandidateResume },
  { default: Company },
  { default: JobPosting },
  { default: Subscription },
  { default: TenantSequence },
  { default: express },
  applicationService,
  applicationJobs,
  inboxService,
  resumeSecurity,
  applicationValidators,
  uploadMiddleware,
  permissionRegistry,
] = await Promise.all([
  import('../src/models/AuditLog.js'),
  import('../src/models/Candidate.js'),
  import('../src/models/EmailDelivery.js'),
  import('../src/models/CandidateHistory.js'),
  import('../src/models/CandidateResume.js'),
  import('../src/models/Company.js'),
  import('../src/models/JobPosting.js'),
  import('../src/models/Subscription.js'),
  import('../src/models/TenantSequence.js'),
  import('express'),
  import('../src/services/candidateApplicationService.js'),
  import('../src/services/candidateApplicationJobs.js'),
  import('../src/services/candidateInboxService.js'),
  import('../src/services/resumeSecurityService.js'),
  import('../src/validators/candidateApplicationValidator.js'),
  import('../src/middlewares/publicResumeUpload.js'),
  import('../src/utils/permissionRegistry.js'),
]);

const restorable = (...entries) => {
  const originals = entries.map(([target, method]) => [
    target,
    method,
    target[method],
  ]);

  return () => {
    originals.forEach(([target, method, original]) => {
      target[method] = original;
    });
  };
};

const leanQuery = (value) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  sort() {
    return this;
  },
  limit() {
    return this;
  },
  lean() {
    return Promise.resolve(value);
  },
});

const listQuery = (value) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  sort() {
    return this;
  },
  skip() {
    return this;
  },
  limit() {
    return this;
  },
  lean() {
    return Promise.resolve(value);
  },
});

const runRules = async (rules, request = {}) => {
  const req = {
    body: {},
    params: {},
    query: {},
    ...request,
  };

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

const pdfFile = () => {
  const buffer = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
  return {
    buffer,
    size: buffer.length,
    mimetype: 'application/pdf',
    originalname: '../../candidate resume.pdf',
  };
};

const docxFile = () => {
  const buffer = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(
      '[Content_Types].xml\u0000_rels/.rels\u0000word/document.xml\u0000'
    ),
  ]);

  return {
    buffer,
    size: buffer.length,
    mimetype:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    originalname: 'candidate.docx',
  };
};

const eligibleCompany = {
  _id: '64b000000000000000000001',
  name: 'Acme Labs',
  careerPortalEnabled: true,
};
const eligibleSubscription = {
  status: 'ACTIVE',
  plan: 'PRO',
  planRef: {
    features: { recruitment: true },
    limits: { recruitmentCandidatesMonthly: 100 },
  },
  enabledModules: [],
};
const eligibleJob = {
  _id: '64b000000000000000000002',
  companyId: eligibleCompany._id,
  sourceRequisition: '64b000000000000000000003',
  jobCode: 'JOB-000001',
  title: 'Platform Engineer',
  status: 'OPEN',
  publicationStatus: 'PUBLISHED',
  applicationDeadline: new Date(Date.now() + 86_400_000),
};

const mockEligibleTarget = () => {
  Company.findOne = () => leanQuery(eligibleCompany);
  Subscription.findOne = () => ({
    populate: async () => eligibleSubscription,
  });
  JobPosting.findOne = () => leanQuery(eligibleJob);
  JobPosting.exists = async () => null;
};

test('resume inspection accepts PDF and practical DOCX signatures without claiming a scan', async () => {
  const pdf = await resumeSecurity.inspectResumeFile(pdfFile());
  const docx = await resumeSecurity.inspectResumeFile(docxFile());

  assert.equal(pdf.mimeType, 'application/pdf');
  assert.equal(pdf.originalFileName, 'candidate resume.pdf');
  assert.equal(pdf.scanStatus, 'NOT_CONFIGURED');
  assert.equal(pdf.checksumSha256.length, 64);
  assert.equal(docx.originalFileName, 'candidate.docx');
  assert.equal(docx.scanStatus, 'NOT_CONFIGURED');
});

test('resume inspection rejects disguised files and active document content', async () => {
  await assert.rejects(
    resumeSecurity.inspectResumeFile({
      ...pdfFile(),
      buffer: Buffer.from('MZ executable content'),
      size: 21,
    }),
    (error) => error.statusCode === 400 && /valid PDF/i.test(error.message)
  );

  await assert.rejects(
    resumeSecurity.inspectResumeFile({
      ...pdfFile(),
      buffer: Buffer.from('%PDF-1.7\n/JavaScript action\n%%EOF'),
      size: 35,
    }),
    (error) => error.statusCode === 400 && /active content/i.test(error.message)
  );

  const activeDocx = docxFile();
  activeDocx.buffer = Buffer.concat([
    activeDocx.buffer,
    Buffer.from('word/vbaProject.bin'),
  ]);
  activeDocx.size = activeDocx.buffer.length;

  await assert.rejects(
    resumeSecurity.inspectResumeFile(activeDocx),
    (error) => error.statusCode === 400 && /active content/i.test(error.message)
  );
});

test('multipart middleware enforces PDF/DOCX type and bounded file size', async () => {
  const app = express();
  app.post('/upload', uploadMiddleware.publicResumeUpload, (req, res) => {
    res.status(204).end();
  });
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ message: error.message });
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/upload`;
    const valid = new FormData();
    valid.append(
      'resume',
      new Blob([pdfFile().buffer], { type: 'application/pdf' }),
      'resume.pdf'
    );
    const validResponse = await fetch(baseUrl, {
      method: 'POST',
      body: valid,
    });
    assert.equal(validResponse.status, 204);

    const oversized = new FormData();
    oversized.append(
      'resume',
      new Blob(
        [Buffer.alloc(uploadMiddleware.MAX_RESUME_FILE_SIZE + 1)],
        { type: 'application/pdf' }
      ),
      'resume.pdf'
    );
    const oversizedResponse = await fetch(baseUrl, {
      method: 'POST',
      body: oversized,
    });
    const oversizedBody = await oversizedResponse.json();
    assert.equal(oversizedResponse.status, 400);
    assert.match(oversizedBody.message, /MB or smaller/i);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('application validator normalizes only allowed public fields and rejects internal controls', async () => {
  const request = await runRules(
    applicationValidators.candidateApplicationRules,
    {
      params: {
        companySlug: '  Acme-Labs  ',
        jobCode: ' job-000001 ',
      },
      body: {
        fullName: '  Ada Lovelace  ',
        email: '  ADA@Example.COM ',
        phone: '+91 98765 43210',
        totalExperience: '5.5',
        relevantExperience: '4',
        linkedIn: 'https://www.linkedin.com/in/ada',
        consent: 'true',
      },
    }
  );

  assert.equal(request.params.companySlug, 'acme-labs');
  assert.equal(request.params.jobCode, 'JOB-000001');
  assert.equal(request.body.fullName, 'Ada Lovelace');
  assert.equal(request.body.email, 'ada@example.com');
  assert.equal(request.body.totalExperience, 5.5);

  await assert.rejects(
    runRules(applicationValidators.candidateApplicationRules, {
      params: { companySlug: 'acme-labs', jobCode: 'JOB-000001' },
      body: {
        fullName: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '9876543210',
        consent: 'true',
        companyId: 'attacker-company',
        stage: 'HIRED',
      },
    }),
    (error) =>
      error.statusCode === 400 && /unsupported field/i.test(error.message)
  );
});

test('public application builds controlled candidate, resume, history and PII-safe response', async () => {
  const restore = restorable(
    [Company, 'findOne'],
    [Subscription, 'findOne'],
    [JobPosting, 'findOne'],
    [JobPosting, 'exists'],
    [Candidate, 'findOne'],
    [Candidate, 'countDocuments'],
    [Candidate, 'create'],
    [Candidate, 'deleteOne'],
    [CandidateResume, 'create'],
    [CandidateResume, 'deleteMany'],
    [CandidateHistory, 'create'],
    [CandidateHistory, 'deleteMany'],
    [TenantSequence, 'findOneAndUpdate'],
    [AuditLog, 'create'],
    [EmailDelivery, 'findOne'],
    [EmailDelivery, 'create'],
    [EmailDelivery, 'updateOne']
  );
  let candidatePayload;
  let resumePayload;
  const historyPayloads = [];

  try {
    mockEligibleTarget();
    Candidate.findOne = () => leanQuery(null);
    Candidate.countDocuments = async () => 0;
    TenantSequence.findOneAndUpdate = async () => ({ value: 7 });
    Candidate.create = async (payload) => {
      candidatePayload = payload;
      return { _id: '64b000000000000000000007', ...payload };
    };
    Candidate.deleteOne = async () => ({ deletedCount: 1 });
    CandidateResume.create = async (payload) => {
      resumePayload = payload;
      return payload;
    };
    CandidateResume.deleteMany = async () => ({ deletedCount: 1 });
    CandidateHistory.create = async (payload) => {
      historyPayloads.push(payload);
      return payload;
    };
    CandidateHistory.deleteMany = async () => ({ deletedCount: 1 });
    AuditLog.create = async (payload) => payload;
    // 28.3: the confirmation is a queued delivery intent. With no
    // Redis in the test env the enqueue fails and the delivery is
    // marked FAILED_TO_QUEUE — the application still succeeds.
    EmailDelivery.findOne = async () => null;
    EmailDelivery.create = async (payload) => ({
      _id: '64b0000000000000000000e1',
      ...payload,
    });
    EmailDelivery.updateOne = async () => ({ modifiedCount: 1 });

    const result = await applicationService.submitCandidateApplication({
      companySlug: 'acme-labs',
      jobCode: 'JOB-000001',
      fields: {
        fullName: 'Ada Lovelace',
        email: ' ADA@Example.com ',
        phone: '+91 98765 43210',
        location: 'Chennai',
        currentCompany: 'Analytical Engines',
        currentTitle: 'Engineer',
        totalExperience: 5,
        relevantExperience: 4,
        expectedSalary: 2000000,
        noticePeriod: 30,
        degree: 'BSc',
        institution: 'University',
        graduationYear: 2020,
        skills: 'Node.js, MongoDB, node.js',
        linkedIn: 'https://www.linkedin.com/in/ada',
        consent: 'true',
        stage: 'HIRED',
      },
      file: pdfFile(),
      req: {
        method: 'POST',
        originalUrl: '/api/public/careers/acme-labs/jobs/JOB-000001/apply',
        headers: {},
        ip: '127.0.0.1',
      },
    });

    assert.equal(candidatePayload.companyId, eligibleCompany._id);
    assert.equal(candidatePayload.job, eligibleJob._id);
    assert.equal(candidatePayload.requisition, eligibleJob.sourceRequisition);
    assert.equal(candidatePayload.candidateCode, 'CAN-000007');
    assert.equal(candidatePayload.email, 'ada@example.com');
    assert.equal(candidatePayload.source, 'CAREER_PAGE');
    assert.equal(candidatePayload.stage, 'APPLIED');
    assert.equal(candidatePayload.applicationStatus, 'APPLIED');
    assert.equal(candidatePayload.status, 'ACTIVE');
    assert.deepEqual(candidatePayload.skills, ['Node.js', 'MongoDB']);
    assert.equal(resumePayload.parsingStatus, 'PENDING');
    assert.equal(resumePayload.scanStatus, 'NOT_CONFIGURED');
    assert.ok(resumePayload.storageKey);
    assert.equal(historyPayloads[0].action, 'CANDIDATE_APPLIED');
    // 28.3: the confirmation is a queued delivery intent, not a
    // synchronous send. The record exists either way; the queue
    // outcome depends on whether Redis is available in the env.
    const confirmation = historyPayloads.find(
      (payload) =>
        payload.action === 'APPLICATION_CONFIRMATION_REQUESTED' ||
        payload.action === 'APPLICATION_CONFIRMATION_FAILED_TO_QUEUE'
    );
    assert.ok(confirmation, 'application confirmation record must exist');
    assert.ok(
      ['QUEUED', 'FAILED_TO_QUEUE'].includes(confirmation.metadata.deliveryStatus)
    );
    assert.deepEqual(Object.keys(result).sort(), [
      'applicationReference',
      'job',
      'submittedAt',
    ]);
    assert.deepEqual(Object.keys(result.job).sort(), ['jobCode', 'title']);
    assert.equal(JSON.stringify(result).includes('ada@example.com'), false);
  } finally {
    restore();
    await rm(process.env.PRIVATE_RESUME_STORAGE_DIR, {
      recursive: true,
      force: true,
    });
  }
});

test('same-job duplicate is acknowledged without storage or a second candidate', async () => {
  const restore = restorable(
    [Company, 'findOne'],
    [Subscription, 'findOne'],
    [JobPosting, 'findOne'],
    [JobPosting, 'exists'],
    [Candidate, 'findOne'],
    [Candidate, 'countDocuments'],
    [Candidate, 'create']
  );
  let candidateCreated = false;
  let usageCounted = false;

  try {
    mockEligibleTarget();
    Candidate.findOne = (filter) => {
      assert.equal(filter.job, eligibleJob._id);
      assert.equal(filter.email, 'ada@example.com');
      return leanQuery({ candidateCode: 'CAN-000005' });
    };
    Candidate.countDocuments = async () => {
      usageCounted = true;
      return 0;
    };
    Candidate.create = async () => {
      candidateCreated = true;
    };

    const result = await applicationService.submitCandidateApplication({
      companySlug: 'acme-labs',
      jobCode: eligibleJob.jobCode,
      fields: { email: 'ADA@example.com' },
      file: pdfFile(),
      req: null,
    });

    assert.equal(result.applicationReference, 'CAN-000005');
    assert.equal(candidateCreated, false);
    assert.equal(usageCounted, false);
  } finally {
    restore();
  }
});

test('the same normalized email remains independently scoped to each job', async () => {
  const restore = restorable(
    [Company, 'findOne'],
    [Subscription, 'findOne'],
    [JobPosting, 'findOne'],
    [JobPosting, 'exists'],
    [Candidate, 'findOne']
  );
  const capturedFilters = [];

  try {
    mockEligibleTarget();
    JobPosting.findOne = (filter) =>
      leanQuery({
        ...eligibleJob,
        _id: filter.jobCode === 'JOB-000001'
          ? '64b000000000000000000021'
          : '64b000000000000000000022',
        jobCode: filter.jobCode,
      });
    Candidate.findOne = (filter) => {
      capturedFilters.push(filter);
      return leanQuery({
        candidateCode:
          filter.job === '64b000000000000000000021'
            ? 'CAN-000021'
            : 'CAN-000022',
      });
    };

    const first = await applicationService.submitCandidateApplication({
      companySlug: 'acme-labs',
      jobCode: 'JOB-000001',
      fields: { email: 'same@example.com' },
      file: pdfFile(),
      req: null,
    });
    const second = await applicationService.submitCandidateApplication({
      companySlug: 'acme-labs',
      jobCode: 'JOB-000002',
      fields: { email: 'same@example.com' },
      file: pdfFile(),
      req: null,
    });

    assert.equal(first.applicationReference, 'CAN-000021');
    assert.equal(second.applicationReference, 'CAN-000022');
    assert.equal(capturedFilters[0].email, 'same@example.com');
    assert.equal(capturedFilters[1].email, 'same@example.com');
    assert.notEqual(capturedFilters[0].job, capturedFilters[1].job);
  } finally {
    restore();
  }
});

test('confirmation queue failure is recorded without throwing or deleting the application', async () => {
  const restore = restorable([CandidateHistory, 'create']);
  let historyPayload;

  try {
    CandidateHistory.create = async (payload) => {
      historyPayload = payload;
      return payload;
    };

    // 28.3: the transport is the BullMQ queue. A queue failure must
    // be recorded (FAILED_TO_QUEUE) and never thrown — the business
    // side (the committed application) is untouched, and there is no
    // synchronous fallback.
    const result = await applicationJobs.requestApplicationConfirmation({
      candidate: {
        _id: '64b000000000000000000031',
        companyId: eligibleCompany._id,
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        candidateCode: 'CAN-000031',
      },
      company: eligibleCompany,
      job: eligibleJob,
      dispatch: async () => {
        throw new Error('simulated queue outage');
      },
    });

    assert.equal(result.queued, false);
    assert.equal(result.deliveryStatus, 'FAILED_TO_QUEUE');
    assert.equal(historyPayload.action, 'APPLICATION_CONFIRMATION_FAILED_TO_QUEUE');
    assert.equal(historyPayload.metadata.deliveryStatus, 'FAILED_TO_QUEUE');
    assert.equal(historyPayload.metadata.deliveryId, null);
    assert.equal(
      JSON.stringify(historyPayload.metadata).includes('ada@example.com'),
      false
    );
  } finally {
    restore();
  }
});

test('candidate indexes enforce same-job email uniqueness and tenant code uniqueness', () => {
  const indexes = Candidate.schema.indexes();
  const duplicateIndex = indexes.find(
    ([fields]) => fields.job === 1 && fields.email === 1
  );
  const codeIndex = indexes.find(
    ([fields]) => fields.companyId === 1 && fields.candidateCode === 1
  );

  assert.ok(duplicateIndex);
  assert.equal(duplicateIndex[1].unique, true);
  assert.ok(codeIndex);
  assert.equal(codeIndex[1].unique, true);
  assert.equal(
    CandidateResume.schema.path('storageKey').options.select,
    false
  );
  assert.equal(
    CandidateResume.schema.path('checksumSha256').options.select,
    false
  );
});

test('closed or expired application target returns safe unavailability', async () => {
  const restore = restorable(
    [Company, 'findOne'],
    [Subscription, 'findOne'],
    [JobPosting, 'findOne'],
    [JobPosting, 'exists']
  );
  let capturedFilter;

  try {
    mockEligibleTarget();
    JobPosting.findOne = (filter) => {
      capturedFilter = filter;
      return leanQuery(null);
    };
    JobPosting.exists = async () => ({ _id: eligibleJob._id });

    await assert.rejects(
      applicationService.submitCandidateApplication({
        companySlug: 'acme-labs',
        jobCode: eligibleJob.jobCode,
        fields: { email: 'ada@example.com' },
        file: pdfFile(),
        req: null,
      }),
      (error) => error.statusCode === 410
    );

    assert.equal(capturedFilter.companyId, eligibleCompany._id);
    assert.equal(capturedFilter.status, 'OPEN');
    assert.equal(capturedFilter.publicationStatus, 'PUBLISHED');
    assert.ok(Array.isArray(capturedFilter.$and));
  } finally {
    restore();
  }
});

test('candidate inbox search and detail always include authenticated company scope', async () => {
  const restore = restorable(
    [Candidate, 'find'],
    [Candidate, 'findOne'],
    [Candidate, 'countDocuments'],
    [CandidateResume, 'find']
  );
  let listFilter;
  let detailFilter;

  try {
    Candidate.find = (filter) => {
      listFilter = filter;
      return listQuery([]);
    };
    Candidate.countDocuments = async () => 0;
    CandidateResume.find = () => ({ distinct: async () => [] });

    const result = await inboxService.listCandidateInbox({
      companyId: '64b000000000000000000010',
      query: { search: '[private]+', page: 1, limit: 20 },
    });

    assert.equal(listFilter.companyId, '64b000000000000000000010');
    assert.equal(listFilter.$or[0].candidateCode.source, '\\[private\\]\\+');
    assert.equal(result.meta.total, 0);

    Candidate.findOne = (filter) => {
      detailFilter = filter;
      return leanQuery(null);
    };

    await assert.rejects(
      inboxService.getCandidateInboxDetail({
        companyId: '64b000000000000000000010',
        candidateRef: 'CAN-000001',
      }),
      (error) => error.statusCode === 404
    );
    assert.equal(detailFilter.companyId, '64b000000000000000000010');
    assert.equal(detailFilter.candidateCode, 'CAN-000001');
  } finally {
    restore();
  }
});

test('candidate startup backfill enables Mongoose update-pipeline mode', async () => {
  const restore = restorable(
    [Candidate, 'find'],
    [Candidate, 'updateMany']
  );
  let pipelineOptions;

  try {
    Candidate.find = () => leanQuery([]);
    Candidate.updateMany = async (_filter, update, options = {}) => {
      if (Array.isArray(update)) pipelineOptions = options;
      return { modifiedCount: 0 };
    };

    const identifiers = await import('../src/utils/candidateIdentifiers.js');
    const result = await identifiers.ensureCandidateIdentifiers();

    assert.deepEqual(pipelineOptions, { updatePipeline: true });
    assert.equal(result.applicationDatesBackfilled, 0);
  } finally {
    restore();
  }
});

test('candidate RBAC, private retrieval and race-safe identifiers stay locked to exact boundaries', async () => {
  assert.ok(
    permissionRegistry.DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(
      'CANDIDATE_READ'
    )
  );
  assert.ok(
    permissionRegistry.DEFAULT_ROLE_MATRIX.HR_MANAGER.includes(
      'CANDIDATE_READ'
    )
  );
  assert.equal(
    permissionRegistry.DEFAULT_ROLE_MATRIX.MANAGER.includes('CANDIDATE_READ'),
    false
  );
  assert.equal(
    permissionRegistry.DEFAULT_ROLE_MATRIX.TEAM_LEAD.includes(
      'CANDIDATE_READ'
    ),
    false
  );
  assert.equal(
    permissionRegistry.DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('CANDIDATE_READ'),
    false
  );

  const [routes, storageSource, controllerSource, identifierSource] =
    await Promise.all([
      readFile(
        new URL('../src/routes/recruitmentRoutes.js', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../src/services/resumeStorageService.js', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../src/controllers/candidateInboxController.js', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../src/utils/candidateIdentifiers.js', import.meta.url),
        'utf8'
      ),
    ]);

  for (const route of [
    '/candidates/inbox',
    '/candidates/:candidateRef/detail',
    '/candidates/:candidateRef/resume',
  ]) {
    const routeIndex = routes.indexOf(`'${route}'`);
    const permissionIndex = routes.indexOf(
      "requirePermission('CANDIDATE_READ')",
      routeIndex
    );
    assert.notEqual(routeIndex, -1);
    assert.notEqual(permissionIndex, -1);
    assert.equal(permissionIndex - routeIndex < 180, true);
  }

  assert.match(storageSource, /DOWNLOAD_TTL_SECONDS = 5 \* 60/);
  assert.match(storageSource, /type: 'authenticated'/);
  assert.match(controllerSource, /pipeline\(Readable\.fromWeb/);
  assert.equal(controllerSource.includes('res.redirect'), false);
  assert.equal(identifierSource.includes('countDocuments'), false);
  assert.equal(identifierSource.includes('.save('), false);
  assert.equal(identifierSource.includes('findOneAndUpdate'), true);
  assert.equal(identifierSource.includes('bulkWrite'), true);
});

// ---------------------------------------------------------------
// Hermetic-suite cleanup (Phase 30.1.2).
// These tests drive real services, and a service that enqueues goes through
// queueFactory. When the developer's Backend/.env happens to ENABLE Redis, that
// opens a live BullMQ connection and caches it, and nothing in this file closes
// it: the event loop stays alive after the last assertion, so `node --test`
// prints every check as ✔ and then never exits - which looks exactly like a hung
// suite (and on a cloud endpoint it can sit in reconnect backoff for minutes).
// Release whatever the process opened so the file ends when the tests end.
// With Redis disabled both calls are no-ops, so this is free.
// ---------------------------------------------------------------
after(async () => {
  const { closeAllQueues } = await import('../src/queues/queueFactory.js');
  const { closeRedis } = await import('../src/config/redis.js');
  await closeAllQueues();
  await closeRedis();
});
