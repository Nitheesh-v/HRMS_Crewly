import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  { default: PreOnboardingAccessToken },
  { default: PreOnboardingHistory },
  { default: PreOnboarding, PRE_ONBOARDING_STATUSES },
  { default: PreOnboardingDocumentRequirement },
  { default: CandidateDocumentRequirement },
  { default: CandidateDocument },
  { default: CandidateDocumentVersion },
  securityService,
  {
    evaluatePreOnboardingReadiness,
  },
  { DEFAULT_ROLE_MATRIX, DEFAULT_PERMISSIONS },
  pipelineService,
  { maskDocumentNumber, fingerprintSensitiveValue },
  { hashToken },
] = await Promise.all([
  import('../src/models/PreOnboardingAccessToken.js'),
  import('../src/models/PreOnboardingHistory.js'),
  import('../src/models/PreOnboarding.js'),
  import('../src/models/PreOnboardingDocumentRequirement.js'),
  import('../src/models/CandidateDocumentRequirement.js'),
  import('../src/models/CandidateDocument.js'),
  import('../src/models/CandidateDocumentVersion.js'),
  import('../src/services/preOnboardingDocumentSecurityService.js'),
  import('../src/services/preOnboardingService.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/services/candidatePipelineService.js'),
  import('../src/utils/fieldEncryption.js'),
  import('../src/utils/securityPolicy.js'),
]);

const id = () => new mongoose.Types.ObjectId();

test('readiness engine requires every mandatory requirement to be verified', () => {
  const readiness = evaluatePreOnboardingReadiness([
    { required: true, status: 'VERIFIED' },
    { required: true, status: 'UNDER_REVIEW' },
    { required: false, status: 'PENDING' },
  ]);

  assert.equal(readiness.totalRequired, 2);
  assert.equal(readiness.verifiedRequired, 1);
  assert.equal(readiness.underReviewRequired, 1);
  assert.equal(readiness.ready, false);

  const ready = evaluatePreOnboardingReadiness([
    { required: true, status: 'VERIFIED' },
    { required: true, status: 'VERIFIED' },
    { required: false, status: 'PENDING' },
  ]);
  assert.equal(ready.ready, true);
});

test('document numbers are masked and fingerprinted without storing clear values in helpers', () => {
  assert.equal(maskDocumentNumber('ABCDE1234F').endsWith('234F'), true);
  assert.equal(maskDocumentNumber('ABCDE1234F').includes('ABCDE'), false);
  assert.equal(fingerprintSensitiveValue('abcde1234f').length, 64);
  assert.equal(
    fingerprintSensitiveValue('abcde1234f'),
    fingerprintSensitiveValue('ABCDE1234F')
  );
});

test('file inspection accepts valid PDF signatures and rejects executables and mismatched types', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');
  const inspected = await securityService.inspectPreOnboardingFile({
    file: {
      buffer: pdf,
      mimetype: 'application/pdf',
      originalname: 'id.pdf',
    },
    allowedMimeTypes: ['application/pdf'],
    maxFileSize: 5 * 1024 * 1024,
  });
  assert.equal(inspected.mimeType, 'application/pdf');
  assert.equal(inspected.scanStatus, 'NOT_CONFIGURED');

  await assert.rejects(
    securityService.inspectPreOnboardingFile({
      file: {
        buffer: Buffer.from('MZ executable'),
        mimetype: 'application/pdf',
        originalname: 'malware.exe',
      },
      allowedMimeTypes: ['application/pdf'],
      maxFileSize: 5 * 1024 * 1024,
    }),
    (error) => error.statusCode === 400
  );
});

test('RBAC grants pre-onboarding authority to tenant HR roles only by default', () => {
  const permissions = [
    'PRE_ONBOARDING_READ',
    'PRE_ONBOARDING_CREATE',
    'PRE_ONBOARDING_UPDATE',
    'PRE_ONBOARDING_SEND',
    'PRE_ONBOARDING_READY',
    'PRE_ONBOARDING_WITHDRAW',
    'PRE_ONBOARDING_DOCUMENT_READ',
    'PRE_ONBOARDING_DOCUMENT_VERIFY',
    'PRE_ONBOARDING_SETTINGS_READ',
    'PRE_ONBOARDING_SETTINGS_MANAGE',
  ];
  const registered = new Set(DEFAULT_PERMISSIONS.map((item) => item.name));

  for (const permission of permissions) {
    assert.equal(registered.has(permission), true, `${permission} must be registered`);
    assert.equal(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(permission), true);
    assert.equal(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes(permission), true);
    assert.equal(DEFAULT_ROLE_MATRIX.MANAGER.includes(permission), false);
    assert.equal(DEFAULT_ROLE_MATRIX.EMPLOYEE.includes(permission), false);
  }
});

test('generic pipeline updates cannot enter pre-onboarding or jump to JOINED', async () => {
  await assert.rejects(
    pipelineService.transitionCandidateStage({
      companyId: id(),
      candidateId: id(),
      targetStage: 'PRE_ONBOARDING',
      actorId: id(),
      metadata: { source: 'MANUAL' },
    }),
    (error) => error.statusCode === 403
  );

  await assert.rejects(
    pipelineService.transitionCandidateStage({
      companyId: id(),
      candidateId: id(),
      targetStage: 'JOINED',
      actorId: id(),
      metadata: { source: 'MANUAL' },
    }),
    (error) => error.statusCode === 403
  );
});

test('token issuance stores only a SHA-256 hash and capability is limited to pre-onboarding portal', async () => {
  const paths = PreOnboardingAccessToken.schema.paths;
  assert.equal(paths.tokenHash.options.select, false);
  assert.deepEqual(paths.capability.enumValues, ['PRE_ONBOARDING_PORTAL']);

  const companyId = id();
  const preOnboardingId = id();
  const candidateId = id();
  const actorId = id();
  const expiresAt = new Date(Date.now() + 86400000);

  // Use in-memory stubs through the model validators without DB when possible.
  const sample = new PreOnboardingAccessToken({
    companyId,
    preOnboarding: preOnboardingId,
    candidate: candidateId,
    tokenHash: hashToken('x'.repeat(48)),
    expiresAt,
    issuedBy: actorId,
  });
  assert.equal(sample.capability, 'PRE_ONBOARDING_PORTAL');
  assert.equal(sample.tokenHash.length, 64);
  assert.notEqual(sample.tokenHash, 'x'.repeat(48));
});

test('document and case models preserve statuses, snapshots and immutable history contracts', () => {
  assert.ok(PRE_ONBOARDING_STATUSES.includes('READY_TO_JOIN'));
  assert.ok(PRE_ONBOARDING_STATUSES.includes('ACTION_REQUIRED'));
  assert.ok(
    CandidateDocumentRequirement.schema.path('status').enumValues.includes(
      'RESUBMISSION_REQUIRED'
    )
  );
  assert.ok(CandidateDocument.schema.path('status').enumValues.includes('VERIFIED'));
  assert.equal(
    CandidateDocumentVersion.schema.path('storageKey').options.select,
    false
  );
  assert.equal(
    CandidateDocumentVersion.schema.path('checksumSha256').options.select,
    false
  );

  const history = new PreOnboardingHistory({
    companyId: id(),
    preOnboarding: id(),
    candidate: id(),
    job: id(),
    action: 'PRE_ONBOARDING_STARTED',
    previousStatus: 'NOT_STARTED',
    newStatus: 'IN_PROGRESS',
    actorType: 'TENANT_USER',
    actor: id(),
  });
  assert.equal(history.action, 'PRE_ONBOARDING_STARTED');
});

test('public portal routes are scanner-safe and token paths are redacted', async () => {
  const [routes, logger, audit, recruitmentRoutes, indexRoutes] = await Promise.all([
    readFile(
      new URL('../src/routes/publicCandidatePreOnboardingRoutes.js', import.meta.url),
      'utf8'
    ),
    readFile(new URL('../src/middlewares/requestLogger.js', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/utils/securityauditService.js', import.meta.url),
      'utf8'
    ),
    readFile(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/index.js', import.meta.url), 'utf8'),
  ]);

  assert.match(routes, /router\.get\(\s*'\/:secureToken'/);
  assert.match(routes, /router\.post\(\s*'\/:secureToken\/view'/);
  assert.match(routes, /router\.post\(\s*'\/:secureToken\/documents\/:requirementCode'/);
  assert.match(indexRoutes, /public\/candidate\/pre-onboarding/);
  assert.match(logger, /pre-onboarding/);
  assert.match(audit, /pre-onboarding/);
  assert.match(recruitmentRoutes, /pre-onboarding\/:preOnboardingId\/mark-ready/);
  assert.match(
    recruitmentRoutes,
    /candidates\/:candidateId\/pre-onboarding\/start/
  );
});

test('phase 27.12 source has no employee conversion, executable templates, or queue/bullmq', async () => {
  const files = [
    '../src/services/preOnboardingService.js',
    '../src/services/publicPreOnboardingService.js',
    '../src/controllers/preOnboardingController.js',
    '../src/controllers/publicPreOnboardingController.js',
  ];
  const source = (
    await Promise.all(
      files.map((file) => readFile(new URL(file, import.meta.url), 'utf8'))
    )
  ).join('\n');

  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /new\s+Function\s*\(/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /BullMQ|Redis/i);
  assert.doesNotMatch(source, /createEmployee|User\.create|tempPassword/);
  assert.doesNotMatch(source, /targetStage:\s*'JOINED'/);
  assert.match(source, /READY_TO_JOIN/);
  assert.match(source, /PRE_ONBOARDING_STARTED/);
});

test('requirement model supports configurable categories and deactivation-friendly fields', () => {
  const path = PreOnboardingDocumentRequirement.schema.path('category');
  assert.ok(path.enumValues.includes('IDENTITY'));
  assert.ok(path.enumValues.includes('TAX'));
  assert.equal(
    PreOnboardingDocumentRequirement.schema.path('active').instance,
    'Boolean'
  );
  assert.equal(
    PreOnboarding.schema.path('candidateSnapshot.name').isRequired,
    true
  );
});
