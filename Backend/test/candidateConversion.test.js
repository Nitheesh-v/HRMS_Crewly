import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
process.env.JWT_SECRET ||= 'test-jwt-secret-for-conversion';
process.env.CLIENT_URL ||= 'http://localhost:5173';

const [
  { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX },
  { evaluateConversionEligibility },
  { generateUnusablePassword },
] = await Promise.all([
  import('../src/utils/permissionRegistry.js'),
  import('../src/services/candidateConversionService.js'),
  import('../src/services/accountSetupService.js'),
]);

test('RBAC registers CANDIDATE_CONVERT for admin and HR only by default', () => {
  const names = new Set(DEFAULT_PERMISSIONS.map((item) => item.name));
  assert.equal(names.has('CANDIDATE_CONVERT'), true);
  assert.equal(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes('CANDIDATE_CONVERT'), true);
  assert.equal(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('CANDIDATE_CONVERT'), true);
  assert.equal(DEFAULT_ROLE_MATRIX.MANAGER.includes('CANDIDATE_CONVERT'), false);
  assert.equal(DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('CANDIDATE_CONVERT'), false);
});

test('conversion eligibility requires READY_TO_JOIN pre-onboarding and accepted offer', () => {
  const base = {
    candidate: {
      currentStage: 'PRE_ONBOARDING',
      convertedUser: null,
    },
    offer: { status: 'ACCEPTED', _id: 'offer1' },
    preOnboarding: {
      status: 'READY_TO_JOIN',
      offer: 'offer1',
    },
    readiness: { ready: true, blockingReasons: [] },
  };

  assert.equal(evaluateConversionEligibility(base).eligible, true);

  assert.equal(
    evaluateConversionEligibility({
      ...base,
      candidate: { ...base.candidate, currentStage: 'OFFER_ACCEPTED' },
    }).eligible,
    false
  );

  assert.equal(
    evaluateConversionEligibility({
      ...base,
      offer: { status: 'SENT', _id: 'offer1' },
    }).eligible,
    false
  );

  assert.equal(
    evaluateConversionEligibility({
      ...base,
      readiness: { ready: false, blockingReasons: ['docs pending'] },
    }).eligible,
    false
  );
});

test('account setup password generator never returns a simple temp password', () => {
  const password = generateUnusablePassword();
  assert.equal(password.length > 20, true);
  assert.doesNotMatch(password, /^Talent@\d{4}$/);
  assert.doesNotMatch(password, /^Welcome@123$/i);
});

test('conversion routes and source avoid plaintext password email handoff', async () => {
  const [routes, service, mailer] = await Promise.all([
    readFile(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/services/candidateConversionService.js', import.meta.url),
      'utf8'
    ),
    readFile(new URL('../src/utils/mailer.js', import.meta.url), 'utf8'),
  ]);

  assert.match(routes, /convert-to-employee/);
  assert.match(routes, /conversion-preview/);
  assert.match(service, /generateUnusablePassword/);
  assert.match(service, /sendAccountSetupInvitation/);
  assert.match(service, /EMPLOYEE_CONVERSION/);
  assert.doesNotMatch(service, /tempPassword/);
  assert.doesNotMatch(service, /welcomeEmail\(/);
  assert.match(mailer, /accountSetupEmail/);
  assert.match(mailer, /Set up your password/);
});

test('user model and conversion model enforce one employee per candidate provenance', async () => {
  const [userModel, conversionModel] = await Promise.all([
    readFile(new URL('../src/models/User.js', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/models/CandidateEmployeeConversion.js', import.meta.url),
      'utf8'
    ),
  ]);

  assert.match(userModel, /candidateId/);
  assert.match(userModel, /accountSetupRequired/);
  assert.match(userModel, /partialFilterExpression:\s*\{\s*candidateId/);
  assert.match(conversionModel, /companyId: 1, candidate: 1/);
  assert.match(conversionModel, /COMPLETED/);
});
