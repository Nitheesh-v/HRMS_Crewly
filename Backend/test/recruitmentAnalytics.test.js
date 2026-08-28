import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
process.env.JWT_SECRET ||= 'test-jwt-secret-analytics';

const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } = await import(
  '../src/utils/permissionRegistry.js'
);

test('RBAC registers recruitment analytics read for admin and HR only by default', () => {
  const names = new Set(DEFAULT_PERMISSIONS.map((item) => item.name));
  assert.equal(names.has('RECRUITMENT_ANALYTICS_READ'), true);
  assert.equal(
    DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes('RECRUITMENT_ANALYTICS_READ'),
    true
  );
  assert.equal(
    DEFAULT_ROLE_MATRIX.HR_MANAGER.includes('RECRUITMENT_ANALYTICS_READ'),
    true
  );
  assert.equal(
    DEFAULT_ROLE_MATRIX.MANAGER.includes('RECRUITMENT_ANALYTICS_READ'),
    false
  );
  assert.equal(
    DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('RECRUITMENT_ANALYTICS_READ'),
    false
  );
});

test('analytics route and service enforce company scope and documented metrics', async () => {
  const [routes, service] = await Promise.all([
    readFile(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/services/recruitmentAnalyticsService.js', import.meta.url),
      'utf8'
    ),
  ]);

  assert.match(routes, /\/analytics\/overview/);
  assert.match(routes, /RECRUITMENT_ANALYTICS_READ/);
  assert.match(service, /companyId: filters\.companyId|companyId: companyObjectId|companyId,/);
  assert.match(service, /TIME TO HIRE/);
  assert.match(service, /TIME TO FILL/);
  assert.match(service, /READY_TO_JOIN/);
  assert.match(service, /acceptedAt/);
  assert.match(service, /applicationDate/);
  assert.doesNotMatch(service, /req\.body\.companyId/);
  // No direct queue (BullMQ) or ioredis client usage in this service.
  // 28.7 added the centralized fail-open cache abstraction — that is
  // the only infrastructure dependency allowed here.
  assert.doesNotMatch(service, /BullMQ|new Redis|from 'ioredis'/);
  assert.match(service, /redisCacheService/);
});

test('analytics source does not expose document contents or compensation in work queues', async () => {
  const service = await readFile(
    new URL('../src/services/recruitmentAnalyticsService.js', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(service, /storageKey/);
  assert.doesNotMatch(service, /renderedContent/);
  assert.doesNotMatch(service, /documentNumberFingerprint/);
  assert.match(service, /workQueue/);
  assert.match(service, /funnel/);
});
