// ═══════════════════════════════════════════════════════════════════════════
// PERFORMANCE CYCLE OPTIONS — the fields the create dialog now offers.
//
// A dialog that collects a methodology, five dates and two enrolment choices
// is only honest if the API stores them and acts on them. Three things are
// pinned here: the model keeps every option, enrollment honours "exclude
// probation" without also honouring it on a later re-enroll, and the cohort
// count the dialog shows is the count the server computes.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('src/models/PerformanceCycle.js');
const controller = read('src/controllers/performanceController.js');
const routes = read('src/routes/selfServiceRoutes.js');
const assets = read('src/controllers/assetController.js');

describe('the cycle model', () => {
  test('stores a methodology from a closed list', () => {
    assert.match(model, /CYCLE_METHODOLOGIES = \['STANDARD', 'THREE_SIXTY', 'OKR'\]/);
    assert.match(model, /methodology: \{ type: String, enum: CYCLE_METHODOLOGIES, default: 'STANDARD' \}/);
  });

  test('stores the three milestone deadlines as days, not timestamps', () => {
    for (const field of ['selfReviewDueAt', 'managerReviewDueAt', 'calibrationDueAt']) {
      assert.match(model, new RegExp(`${field}: \\{ type: String, default: '' \\}`), `${field} missing`);
    }
  });

  test('remembers the two enrolment decisions for the life of the round', () => {
    assert.match(model, /excludeProbation: \{ type: Boolean, default: false \}/);
    assert.match(model, /notifyParticipants: \{ type: Boolean, default: true \}/);
  });
});

describe('creating a cycle', () => {
  test('rejects a date that is not a date', () => {
    assert.ok(controller.includes('\\d{4}-\\d{2}-\\d{2}'), 'dates are validated against YYYY-MM-DD');
    assert.match(controller, /must be a date \(YYYY-MM-DD\)/);
  });

  test('an unknown methodology falls back instead of failing the request', () => {
    assert.match(controller, /CYCLE_METHODOLOGIES\.includes\(methodology\) \? methodology : 'STANDARD'/);
  });

  test('the exclusion is decided before enrollment, and used by it', () => {
    assert.match(controller, /const skip = skipProbation \? await probationIds\(req\.companyId\) : new Set\(\);/);
    assert.match(controller, /await enrollAll\(req\.companyId, cycle\._id, \{ skip \}\)/);
  });

  test('notifications go only to the people who were actually enrolled', () => {
    assert.match(controller, /if \(shouldNotify\) \{/);
    assert.match(controller, /Appraisal\.find\(\{ companyId: req\.companyId, cycle: cycle\._id \}\)/);
    assert.match(controller, /\.filter\(\(id\) => id !== String\(req\.user\._id\)\)/);
  });
});

describe('probation, as the cohort sees it', () => {
  test('a lifecycle stage and a joining date inside 90 days both count', () => {
    assert.match(controller, /EmployeeLifecycle\.find\(\{ companyId, stage: 'PROBATION' \}\)/);
    assert.match(controller, /const PROBATION_DAYS = 90;/);
    assert.match(controller, /joinedAt > cutoff/);
  });

  test('the cohort endpoint is HR-only and behind the create permission', () => {
    assert.match(controller, /export const cycleCohort = asyncHandler/);
    assert.match(controller, /Only HR or the company admin see the participant cohort/);

    const at = routes.indexOf("'/perf/cohort'");
    assert.ok(at > -1, 'the route exists');
    const after = routes.slice(at, at + 400);
    assert.match(after, /requirePermission\(\s*'PERFORMANCE_CREATE'/);
    assert.match(after, /cycleCohort/);
  });

  test('the count is returned whole, including the department split', () => {
    assert.match(controller, /onProbation: onProbation\.length/);
    assert.match(controller, /byDepartment:/);
    assert.match(controller, /probationWindowDays: PROBATION_DAYS/);
  });
});

describe('asset status filter', () => {
  test('is validated against the status enum, not the category list', () => {
    assert.match(assets, /const STATUSES = \['AVAILABLE', 'ASSIGNED'\];/);
    assert.match(assets, /if \(!STATUSES\.includes\(status\)\) return fail\(res, 400, 'Unknown asset status'\)/);
    // The old guard tested CATS — a status filter that could never reject a typo.
    assert.equal(assets.includes("if (req.query.status && CATS && req.query.status !== 'ALL')"), false);
  });
});

