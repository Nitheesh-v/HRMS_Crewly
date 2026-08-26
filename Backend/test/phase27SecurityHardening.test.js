import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
process.env.JWT_SECRET ||= 'test-jwt-secret-phase27-16';

const read = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), 'utf8');

test('legacy convert path no longer issues temporary passwords', async () => {
  const controller = await read('../src/controllers/recruitmentController.js');
  assert.match(controller, /Legacy candidate conversion is retired/);
  assert.doesNotMatch(controller, /tempPassword\s*=/);
  assert.doesNotMatch(controller, /Talent@/);
  assert.doesNotMatch(controller, /welcomeEmail\(/);
});

test('public recruitment mounts are limited to career offer and pre-onboarding portals', async () => {
  const index = await read('../src/routes/index.js');
  assert.match(index, /\/public\/careers/);
  assert.match(index, /\/public\/candidate\/offers/);
  assert.match(index, /\/public\/candidate\/pre-onboarding/);
  assert.doesNotMatch(index, /\/public\/recruitment\/candidates/);
  assert.doesNotMatch(index, /\/public\/offers\/manage/);
});

test('offer and pre-onboarding tokens store hashes only and rate-limit by hash', async () => {
  const [offerToken, preToken, offerModel, preModel] = await Promise.all([
    read('../src/services/offerTokenService.js'),
    read('../src/services/preOnboardingTokenService.js'),
    read('../src/models/OfferAccessToken.js'),
    read('../src/models/PreOnboardingAccessToken.js'),
  ]);

  assert.match(offerToken, /hashToken\(rawToken\)/);
  assert.match(preToken, /hashToken\(rawToken\)/);
  assert.match(offerToken, /offerTokenRateLimitKey/);
  assert.match(preToken, /preOnboardingTokenRateLimitKey/);
  assert.match(offerModel, /select:\s*false/);
  assert.match(preModel, /select:\s*false/);
  assert.doesNotMatch(offerModel, /rawToken/);
  assert.doesNotMatch(preModel, /rawToken/);
});

test('malware scan abstractions never claim CLEAN without a scanner', async () => {
  const [resumeScan, docScan] = await Promise.all([
    read('../src/services/resumeSecurityService.js'),
    read('../src/services/preOnboardingDocumentSecurityService.js'),
  ]);

  assert.match(resumeScan, /NOT_CONFIGURED/);
  assert.match(docScan, /NOT_CONFIGURED/);
  assert.doesNotMatch(resumeScan, /status:\s*'CLEAN'/);
  assert.doesNotMatch(docScan, /status:\s*'CLEAN'/);
});

test('BGV and ATS paths do not auto-reject candidates from scores or discrepancies', async () => {
  const [bgv, ats, decision] = await Promise.all([
    read('../src/services/backgroundVerificationService.js'),
    read('../src/services/atsMatchingService.js'),
    read('../src/services/candidateDecisionService.js'),
  ]);

  assert.match(bgv, /Never auto-reject candidate on discrepancy/);
  assert.doesNotMatch(bgv, /targetStage:\s*'REJECTED'/);
  // ATS may advance APPLIED → ATS_SCREENING only; must never reject from score.
  assert.match(ats, /targetStage:\s*'ATS_SCREENING'/);
  assert.doesNotMatch(ats, /targetStage:\s*'REJECTED'/);
  assert.doesNotMatch(ats, /targetStage:\s*'SELECTED'/);
  assert.doesNotMatch(ats, /targetStage:\s*'SHORTLISTED'/);
  assert.match(decision, /FINAL_DECISION/);
});

test('secure conversion remains the only employee handoff and is idempotent by unique constraints', async () => {
  const [routes, conversion, userModel, conversionModel] = await Promise.all([
    read('../src/routes/recruitmentRoutes.js'),
    read('../src/services/candidateConversionService.js'),
    read('../src/models/User.js'),
    read('../src/models/CandidateEmployeeConversion.js'),
  ]);

  assert.match(routes, /convert-to-employee/);
  assert.match(conversion, /generateUnusablePassword/);
  assert.match(conversion, /sendAccountSetupInvitation/);
  assert.match(conversion, /idempotent:\s*true/);
  assert.match(userModel, /candidateId/);
  assert.match(userModel, /employeeCode/);
  assert.match(userModel, /partialFilterExpression/);
  assert.match(conversionModel, /companyId: 1, candidate: 1/);
});

test('public GET offer handlers remain scanner-safe decision-free', async () => {
  const [routes, service] = await Promise.all([
    read('../src/routes/publicCandidateOfferRoutes.js'),
    read('../src/services/publicOfferService.js'),
  ]);

  assert.match(routes, /router\.get\('\/:secureToken'/);
  assert.match(routes, /router\.post\('\/:secureToken\/accept'/);
  assert.match(routes, /router\.post\('\/:secureToken\/reject'/);
  const getHandler = service.slice(
    service.indexOf('export const getPublicOffer'),
    service.indexOf('export const recordPublicOfferView')
  );
  assert.doesNotMatch(getHandler, /status:\s*'ACCEPTED'|status:\s*'REJECTED'|OFFER_ACCEPTED/);
});

test('tenant-scoped recruitment aggregations match companyId before grouping', async () => {
  const analytics = await read('../src/services/recruitmentAnalyticsService.js');
  assert.match(analytics, /companyId:\s*companyObjectId|companyId:\s*filters\.companyId|companyId,/);
  assert.match(analytics, /\$match/);
  assert.doesNotMatch(analytics, /req\.body\.companyId/);
  assert.doesNotMatch(analytics, /req\.query\.companyId/);
});

test('error handler hides stacks outside development 500s', async () => {
  const handler = await read('../src/middlewares/errorHandler.js');
  assert.match(handler, /NODE_ENV === 'development'/);
  assert.match(handler, /statusCode >= 500/);
  assert.doesNotMatch(handler, /stack:\s*err\.stack,\s*\n\s*\}/);
});
