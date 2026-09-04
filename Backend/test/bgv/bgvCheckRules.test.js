// ============================================================
//  PHASE 30.1 — bgvCheckRules hermetic unit tests (pure)
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';

const {
  DEFAULT_BGV_SLA_DAYS,
  agingBucketBounds,
  computeSlaDueAt,
  containsRawDocumentNumber,
  isValidTransition,
  maskPhone,
  requiredCheckTypesForSettings,
  rollupCheckStatusFromEntries,
  sanitizeEvidenceMeta,
  roundGeoForAudit,
} = await import('../../src/services/bgv/bgvCheckRules.js');

const DAY = 24 * 60 * 60 * 1000;
const base = new Date('2026-09-01T00:00:00.000Z');

test('computeSlaDueAt defaults to 10 days and honours per-type overrides', () => {
  assert.equal(
    computeSlaDueAt({}, 'IDENTITY', base).getTime() - base.getTime(),
    DEFAULT_BGV_SLA_DAYS * DAY
  );
  const settings = { checkConfig: { EMPLOYMENT: { required: true, slaDays: 14 } } };
  assert.equal(computeSlaDueAt(settings, 'EMPLOYMENT', base).getTime() - base.getTime(), 14 * DAY);
  // Clamp: absurd values fall back to the default, never crash.
  assert.equal(computeSlaDueAt({ checkConfig: { ADDRESS: { slaDays: 0 } } }, 'ADDRESS', base).getTime() - base.getTime(), DEFAULT_BGV_SLA_DAYS * DAY);
  assert.equal(computeSlaDueAt({ checkConfig: { ADDRESS: { slaDays: 999 } } }, 'ADDRESS', base).getTime() - base.getTime(), DEFAULT_BGV_SLA_DAYS * DAY);
});

test('requiredCheckTypesForSettings creates required types only when configured off', () => {
  const plan = requiredCheckTypesForSettings({ checkConfig: { ADDRESS: { required: false } } });
  assert.deepEqual(
    plan.map((item) => [item.checkType, item.required]),
    [['IDENTITY', true], ['ADDRESS', false], ['EDUCATION', true], ['EMPLOYMENT', true], ['COURT_RECORD', true]]
  );
  assert.equal(plan.every((item) => item.slaDays === DEFAULT_BGV_SLA_DAYS), true);
});

test('isValidTransition — allowed edges pass', () => {
  assert.equal(isValidTransition('PENDING', 'IN_PROGRESS', {}).ok, true);
  assert.equal(isValidTransition('PENDING', 'SKIPPED', { isRequired: false }).ok, true);
  assert.equal(isValidTransition('IN_PROGRESS', 'VERIFIED', { resultSummary: 'ok' }).ok, true);
  assert.equal(isValidTransition('IN_PROGRESS', 'DISCREPANCY', { discrepancyNote: 'name mismatch' }).ok, true);
  assert.equal(isValidTransition('IN_PROGRESS', 'UTV', { closedReason: 'no response' }).ok, true);
  assert.equal(isValidTransition('IN_PROGRESS', 'INSUFFICIENT_DATA', {}).ok, true);
  assert.equal(isValidTransition('INSUFFICIENT_DATA', 'IN_PROGRESS', {}).ok, true);
  assert.equal(isValidTransition('DISCREPANCY', 'VERIFIED', { resultSummary: 'corrected' }).ok, true);
  assert.equal(isValidTransition('DISCREPANCY', 'IN_PROGRESS', { reason: 'more info received' }).ok, true);
});

test('isValidTransition — forbidden edges and guards reject with clear reasons', () => {
  assert.equal(isValidTransition('PENDING', 'VERIFIED', { resultSummary: 'x' }).ok, false);
  assert.equal(isValidTransition('PENDING', 'UTV', { closedReason: 'x' }).ok, false);
  assert.equal(isValidTransition('IN_PROGRESS', 'PENDING', {}).ok, false);
  // Required fields.
  assert.equal(isValidTransition('IN_PROGRESS', 'VERIFIED', {}).ok, false);
  assert.equal(isValidTransition('IN_PROGRESS', 'DISCREPANCY', {}).ok, false);
  assert.equal(isValidTransition('IN_PROGRESS', 'UTV', {}).ok, false);
  assert.match(isValidTransition('IN_PROGRESS', 'VERIFIED', {}).reason, /summary/i);
  // SKIPPED only for optional checks.
  assert.equal(isValidTransition('PENDING', 'SKIPPED', { isRequired: true }).ok, false);
  // Terminal states only via reopen-with-permission-and-reason.
  assert.equal(isValidTransition('VERIFIED', 'IN_PROGRESS', { canReopen: false }).ok, false);
  assert.equal(isValidTransition('VERIFIED', 'IN_PROGRESS', { canReopen: true }).ok, false); // reason missing
  assert.equal(isValidTransition('VERIFIED', 'IN_PROGRESS', { canReopen: true, reason: 'late evidence' }).ok, true);
  assert.equal(isValidTransition('UTV', 'VERIFIED', { canReopen: true, reason: 'r' }).ok, false);
});

test('rollupCheckStatusFromEntries — worst-wins matrix, never a rejection', () => {
  const s = (statuses) => rollupCheckStatusFromEntries(statuses.map((status) => ({ status })));
  assert.equal(s([]), 'PENDING');
  assert.equal(s(['PENDING', 'PENDING']), 'PENDING');
  assert.equal(s(['VERIFIED', 'DISCREPANCY']), 'DISCREPANCY');
  assert.equal(s(['VERIFIED', 'UTV']), 'UTV');
  assert.equal(s(['DISCREPANCY', 'UTV']), 'DISCREPANCY');
  assert.equal(s(['VERIFIED', 'INSUFFICIENT_DATA']), 'INSUFFICIENT_DATA');
  assert.equal(s(['VERIFIED', 'SKIPPED']), 'VERIFIED');
  assert.equal(s(['SKIPPED', 'SKIPPED']), 'IN_PROGRESS');
  assert.equal(s(['VERIFIED', 'PENDING']), 'IN_PROGRESS');
  assert.equal(s(['VERIFIED', 'IN_PROGRESS']), 'IN_PROGRESS');
});

test('containsRawDocumentNumber flags Aadhaar/PAN/passport patterns only', () => {
  assert.equal(containsRawDocumentNumber('aadhaar 1234 5678 9012'), true);
  assert.equal(containsRawDocumentNumber('123456789012'), true);
  assert.equal(containsRawDocumentNumber({ pan: 'ABCDE1234F' }), true);
  assert.equal(containsRawDocumentNumber('passport P1234567'), true);
  assert.equal(containsRawDocumentNumber('XXXX XXXX 9012'), false);
  assert.equal(containsRawDocumentNumber('employee id 44128'), false);
  assert.equal(containsRawDocumentNumber(''), false);
  assert.equal(containsRawDocumentNumber(null), false);
});

test('maskPhone, geo rounding and evidence meta allowlists', () => {
  assert.equal(maskPhone('9876543210'), 'XXXX-XXXX-3210');
  assert.equal(maskPhone(''), '');
  assert.equal(roundGeoForAudit(12.9715987), 12.972);
  assert.deepEqual(sanitizeEvidenceMeta('CALL_LOG', { phone: '98765', durationSec: 90, outcome: 'no answer', secret: 'drop' }), {
    phone: '98765',
    durationSec: 90,
    outcome: 'no answer',
  });
  assert.deepEqual(sanitizeEvidenceMeta('FIELD_VISIT', { geoLat: '12.97', geoLng: 80.2, geoAccuracyM: 12, extra: 'x' }), {
    geoLat: 12.97,
    geoLng: 80.2,
    geoAccuracyM: 12,
  });
  assert.deepEqual(sanitizeEvidenceMeta('LINK', { url: 'https://example.com/report' }), { url: 'https://example.com/report' });
  assert.deepEqual(sanitizeEvidenceMeta('LINK', { url: 'javascript:alert(1)' }), { url: '' });
  assert.deepEqual(sanitizeEvidenceMeta('NOTE', { anything: 'else' }), {});
});

test('agingBucketBounds produces initiatedAt ranges', () => {
  const now = new Date('2026-09-10T00:00:00.000Z');
  const bounds = agingBucketBounds('4-7', now);
  assert.equal(bounds.$lte.getTime(), now.getTime() - 4 * DAY);
  assert.equal(bounds.$gte.getTime(), now.getTime() - 8 * DAY);
  const openEnded = agingBucketBounds('>12', now);
  assert.equal(openEnded.$gte, undefined);
  assert.equal(agingBucketBounds('bogus', now), null);
});
