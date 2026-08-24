import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  { default: OfferAccessToken },
  { default: OfferHistory },
  { default: OfferLetter, OFFER_STATUSES },
  { default: OfferTemplate },
  renderer,
  { generateOfferPdf },
  tokenService,
  { sendMail },
  { DEFAULT_ROLE_MATRIX, DEFAULT_PERMISSIONS },
  pipelineService,
] = await Promise.all([
  import('../src/models/OfferAccessToken.js'),
  import('../src/models/OfferHistory.js'),
  import('../src/models/OfferLetter.js'),
  import('../src/models/OfferTemplate.js'),
  import('../src/utils/offerTemplateRenderer.js'),
  import('../src/utils/offerPdfService.js'),
  import('../src/services/offerTokenService.js'),
  import('../src/utils/mailer.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/services/candidatePipelineService.js'),
]);

const id = () => new mongoose.Types.ObjectId();
const offerFixture = () => ({
  companyId: id(),
  offerCode: 'OFF-000001',
  candidate: id(),
  job: id(),
  template: id(),
  templateSnapshot: {
    templateId: id(),
    name: 'Standard Offer',
    version: 3,
    content: 'Dear {{candidateName}}, your role is {{designation}} at {{companyName}}.',
    variables: ['candidateName', 'designation', 'companyName'],
  },
  renderedContent:
    'Dear Asha Rao, your role is Platform Engineer at Acme Private Limited.\n\n' +
    'We are pleased to offer this position subject to the terms recorded in this document.',
  unresolvedVariables: [],
  candidateSnapshot: {
    name: 'Asha Rao',
    email: 'asha@example.com',
    candidateCode: 'CAN-000001',
    phone: '',
  },
  jobSnapshot: {
    title: 'Platform Engineer',
    jobCode: 'JOB-000001',
    departmentName: 'Engineering',
    requisitionCode: 'REQ-000001',
  },
  companySnapshot: {
    name: 'Acme Private Limited',
    address: 'Chennai, Tamil Nadu, 600001',
  },
  terms: {
    designation: 'Platform Engineer',
    departmentName: 'Engineering',
    location: 'Chennai',
    employmentType: 'FULL_TIME',
    workMode: 'HYBRID',
    reportingManager: id(),
    reportingManagerName: 'Hiring Manager',
    joiningDate: new Date('2026-10-01T00:00:00.000Z'),
    offerDate: new Date('2026-08-24T00:00:00.000Z'),
    expiryDate: new Date('2026-09-01T23:59:59.999Z'),
    probationMonths: 6,
    noticePeriodDays: 30,
    additionalTerms: '',
  },
  compensationSnapshot: {
    currency: 'INR',
    annualCTC: 1800000,
    monthly: { basic: 75000, hra: 30000, allowances: 25000 },
    variablePay: 120000,
    bonus: 50000,
  },
  approval: { attempt: 1, approvedAt: new Date('2026-08-24T10:00:00.000Z') },
  createdBy: id(),
  updatedBy: id(),
});

test('allowlisted plain-text renderer is deterministic and reports unknown and unresolved variables', () => {
  const values = { candidateName: 'Asha', companyName: 'Acme' };
  const first = renderer.renderOfferTemplate({
    content: 'Dear {{candidateName}}, welcome to {{companyName}} as {{designation}}.',
    values,
  });
  const second = renderer.renderOfferTemplate({
    content: 'Dear {{candidateName}}, welcome to {{companyName}} as {{designation}}.',
    values,
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first.unresolvedVariables, ['designation']);
  assert.match(first.renderedContent, /\[Missing: designation]/);
  assert.equal(first.valid, false);

  const unsupported = renderer.extractOfferTemplateVariables(
    'Hello {{candidateName}} {{constructor}} {{arbitraryCode}}'
  );
  assert.deepEqual(unsupported.variables, ['candidateName']);
  assert.deepEqual(unsupported.unknownVariables, ['constructor', 'arbitraryCode']);
  assert.equal(renderer.OFFER_TEMPLATE_VARIABLES.includes('candidateName'), true);
  assert.equal(renderer.OFFER_TEMPLATE_VARIABLES.includes('salary'), true);
  assert.equal(renderer.OFFER_TEMPLATE_VARIABLES.includes('candidateEmail'), true);
  assert.equal(renderer.OFFER_TEMPLATE_VARIABLES.includes('probationPeriod'), true);
  assert.equal(renderer.OFFER_TEMPLATE_VARIABLES.includes('noticePeriod'), true);
  assert.equal(renderer.OFFER_TEMPLATE_VARIABLES.includes('constructor'), false);
});

test('dedicated offer records preserve snapshots, active uniqueness, immutable history and hashed-token fields', async () => {
  const offer = new OfferLetter(offerFixture());
  await offer.validate();
  assert.equal(offer.activeKey, 'ACTIVE');
  assert.equal(offer.templateSnapshot.version, 3);
  assert.equal(offer.compensationSnapshot.monthly.basic, 75000);
  assert.deepEqual(OFFER_STATUSES, [
    'DRAFT',
    'PENDING_APPROVAL',
    'APPROVED',
    'SENT',
    'VIEWED',
    'ACCEPTED',
    'REJECTED',
    'EXPIRED',
    'WITHDRAWN',
  ]);

  const indexes = OfferLetter.schema.indexes();
  assert.ok(indexes.some(([fields, options]) =>
    fields.companyId === 1 &&
    fields.candidate === 1 &&
    fields.job === 1 &&
    fields.activeKey === 1 &&
    options.unique === true &&
    options.partialFilterExpression?.activeKey === 'ACTIVE'
  ));
  assert.equal(OfferHistory.schema.path('action').options.immutable, true);
  assert.equal(OfferAccessToken.schema.path('tokenHash').options.select, false);
  assert.equal(OfferAccessToken.schema.path('tokenHash').options.immutable, true);
  assert.equal(OfferLetter.schema.path('documentSnapshots.storageKey').options.select, false);
  assert.equal(
    OfferAccessToken.schema.indexes().some(([, options]) => options.expireAfterSeconds !== undefined),
    false,
    'token authority records must not be deleted by a background TTL timer'
  );
  assert.equal(OfferTemplate.schema.path('content').options.maxlength, 8000);
});

test('PDF generation uses fixed snapshots and returns a valid private-document buffer', async () => {
  const buffer = await generateOfferPdf(offerFixture());
  assert.equal(Buffer.isBuffer(buffer), true);
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  assert.ok(buffer.length > 2000);
});

test('token issuance stores only a SHA-256 hash and concurrent re-issuance first revokes old authority', async () => {
  const originalUpdateMany = OfferAccessToken.updateMany;
  const originalCreate = OfferAccessToken.create;
  const calls = [];
  try {
    OfferAccessToken.updateMany = async (filter, update) => {
      calls.push({ type: 'revoke', filter, update });
      return { modifiedCount: 1 };
    };
    OfferAccessToken.create = async (payload) => {
      calls.push({ type: 'create', payload });
      return { _id: id(), ...payload };
    };

    const result = await tokenService.issueOfferToken({
      companyId: id(),
      offerId: id(),
      expiresAt: new Date(Date.now() + 60000),
      actorId: id(),
    });

    assert.equal(calls[0].type, 'revoke');
    assert.ok(calls[0].filter.companyId);
    assert.equal(calls[1].type, 'create');
    assert.ok(result.rawToken.length >= 60);
    assert.equal(calls[1].payload.tokenHash.length, 64);
    assert.notEqual(calls[1].payload.tokenHash, result.rawToken);
    assert.equal('rawToken' in calls[1].payload, false);
    assert.equal('secureToken' in calls[1].payload, false);
  } finally {
    OfferAccessToken.updateMany = originalUpdateMany;
    OfferAccessToken.create = originalCreate;
  }
});

test('production without SMTP fails closed instead of reporting MOCK delivery success', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = await sendMail({
      to: 'candidate@example.com',
      subject: 'Sensitive employment offer',
      text: 'private link',
      sensitive: true,
    });
    assert.equal(result.delivered, false);
    assert.match(result.error, /SMTP/i);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('RBAC grants enterprise offer authority to tenant HR roles only by default', () => {
  const permissions = [
    'OFFER_READ',
    'OFFER_CREATE',
    'OFFER_UPDATE',
    'OFFER_SUBMIT',
    'OFFER_APPROVE',
    'OFFER_RETURN',
    'OFFER_SEND',
    'OFFER_WITHDRAW',
    'OFFER_TEMPLATE_READ',
    'OFFER_TEMPLATE_CREATE',
    'OFFER_TEMPLATE_UPDATE',
  ];
  const registered = new Set(DEFAULT_PERMISSIONS.map((permission) => permission.name));

  for (const permission of permissions) {
    assert.equal(registered.has(permission), true, `${permission} must be registered`);
    assert.equal(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(permission), true);
    assert.equal(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes(permission), true);
    assert.equal(DEFAULT_ROLE_MATRIX.MANAGER.includes(permission), false);
    assert.equal(DEFAULT_ROLE_MATRIX.EMPLOYEE.includes(permission), false);
  }
});

test('generic pipeline updates cannot mark offer acceptance and offer transitions require workflow actions', async () => {
  await assert.rejects(
    pipelineService.transitionCandidateStage({
      companyId: id(),
      candidateId: id(),
      targetStage: 'OFFER_ACCEPTED',
      actorId: id(),
      metadata: { source: 'MANUAL' },
    }),
    (error) => error.statusCode === 403
  );
  await assert.rejects(
    pipelineService.transitionCandidateStage({
      companyId: id(),
      candidateId: id(),
      targetStage: 'OFFER',
      actorId: id(),
      metadata: { source: 'MANUAL' },
    }),
    (error) => error.statusCode === 403
  );
});

test('public GET is scanner-safe, decisions use compare-and-set, and token paths are redacted', async () => {
  const [publicService, routes, logger, audit, recruitmentRoutes] = await Promise.all([
    readFile(new URL('../src/services/publicOfferService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/publicCandidateOfferRoutes.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/middlewares/requestLogger.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/utils/securityauditService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8'),
  ]);

  assert.match(routes, /router\.get\('\/:secureToken'/);
  assert.match(routes, /router\.post\('\/:secureToken\/view'/);
  assert.match(routes, /router\.post\('\/:secureToken\/accept'/);
  assert.match(routes, /router\.post\('\/:secureToken\/reject'/);
  assert.match(publicService, /status: previousStatus/);
  assert.match(publicService, /idempotent: true/);
  assert.match(publicService, /finalDecisionCommitted/);
  assert.ok(
    publicService.lastIndexOf('await recordOfferHistory') <
      publicService.lastIndexOf('await finalizeOfferToken'),
    'immutable decision history must commit before token finalization'
  );
  const readHandler = publicService.slice(
    publicService.indexOf('export const getPublicOffer'),
    publicService.indexOf('export const recordPublicOfferView')
  );
  assert.doesNotMatch(readHandler, /OFFER_VIEWED|status:\s*'VIEWED'/);
  assert.match(logger, /\[REDACTED\]/);
  assert.match(audit, /\[REDACTED\]/);
  assert.doesNotMatch(recruitmentRoutes, /candidates\/:id\/offer/);
});

test('offer source has no executable-template or Phase 27.12 implementation artifacts', async () => {
  const files = [
    '../src/services/offerService.js',
    '../src/services/publicOfferService.js',
    '../src/utils/offerTemplateRenderer.js',
    '../src/utils/offerPdfService.js',
  ];
  const source = (await Promise.all(files.map((file) =>
    readFile(new URL(file, import.meta.url), 'utf8')
  ))).join('\n');

  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /new\s+Function\s*\(/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /PRE_ONBOARDING/);
  assert.doesNotMatch(source, /createEmployee|convertCandidate|BullMQ|Redis/i);
});
