import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
process.env.JWT_SECRET ||= 'test-jwt-secret-bgv';

const [
  { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX },
  { evaluateBgvCaseReadiness },
] = await Promise.all([
  import('../src/utils/permissionRegistry.js'),
  import('../src/services/backgroundVerificationService.js'),
]);

test('RBAC grants BGV permissions to admin and HR only by default', () => {
  const names = new Set(DEFAULT_PERMISSIONS.map((item) => item.name));
  for (const permission of [
    'BACKGROUND_VERIFICATION_READ',
    'BACKGROUND_VERIFICATION_CREATE',
    'BACKGROUND_VERIFICATION_VERIFY',
    'BACKGROUND_VERIFICATION_MANAGE',
    'BACKGROUND_VERIFICATION_SETTINGS_READ',
    'BACKGROUND_VERIFICATION_SETTINGS_MANAGE',
  ]) {
    assert.equal(names.has(permission), true, permission);
    assert.equal(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(permission), true);
    assert.equal(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes(permission), true);
    assert.equal(DEFAULT_ROLE_MATRIX.MANAGER.includes(permission), false);
    assert.equal(DEFAULT_ROLE_MATRIX.EMPLOYEE.includes(permission), false);
  }
});

test('BGV readiness treats optional open checks as non-blocking and never auto-rejects', () => {
  const readiness = evaluateBgvCaseReadiness([
    { required: true, status: 'VERIFIED' },
    { required: true, status: 'DISCREPANCY' },
    { required: false, status: 'NOT_STARTED' },
  ]);
  assert.equal(readiness.requiredCount, 2);
  assert.equal(readiness.verifiedRequiredCount, 1);
  assert.equal(readiness.discrepancyCount, 1);
  assert.equal(readiness.reviewable, true);
  assert.equal(readiness.openRequiredCount, 0);
});

test('BGV routes and provider architecture avoid external vendor hard dependency', async () => {
  const [routes, service, dispatcher, provider] = await Promise.all([
    readFile(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/services/backgroundVerificationService.js', import.meta.url),
      'utf8'
    ),
    readFile(new URL('../src/services/bgv/bgvDispatcher.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/bgv/internalBgvProvider.js', import.meta.url), 'utf8'),
  ]);

  assert.match(routes, /background-verification\/start/);
  assert.match(routes, /background-verifications\/:caseId\/complete/);
  assert.match(service, /evaluateBgvForConversion/);
  assert.match(service, /CLEAR_WITH_DISCREPANCIES/);
  assert.doesNotMatch(service, /rejectCandidate|currentStage\s*=\s*['\"]REJECTED['\"]/);
  assert.match(dispatcher, /BGV_START/);
  assert.match(dispatcher, /Phase 28/);
  assert.match(provider, /INTERNAL/);
  assert.doesNotMatch(provider, /apiKey|secret/i);
});

test('conversion service consults BGV eligibility hook', async () => {
  const source = await readFile(
    new URL('../src/services/candidateConversionService.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /evaluateBgvForConversion/);
  assert.match(source, /bgvRequiredBeforeConversion|bgvEligibility/);
});
