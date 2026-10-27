// ═══════════════════════════════════════════════════════════════════════════
// THE THREE ATTENDANCE OPERATIONS SURFACES — pins.
//
// Re-cut to the supplied Stitch exports:
//   • Enterprise attendance policy      (screen.png)
//   • Overtime, comp-off & exceptions   (screen (2).png)
//   • Who's working today               (screen (4).png)
//
// The mocks are the structural truth, so these pins hold the blocks they draw.
// They also hold the honesty substitutions: the blocks the database cannot fill
// are rendered as "Not configured" rather than deleted or invented, and none of
// the three pages may claim a capability the backend does not have (desk
// capacity, Wi-Fi matching, biometric break validation, presence export).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const POLICY = 'src/pages/attendance/AttendancePolicyPage.jsx';
const OVERTIME = 'src/pages/attendance/AttendanceOvertimePage.jsx';
const TEAM = 'src/pages/attendance/AttendanceTeamPage.jsx';

const policy = read(POLICY);
const overtime = read(OVERTIME);
const team = read(TEAM);

const has = (source, needle, label) =>
  assert.ok(source.includes(needle), `${label}: expected to find ${JSON.stringify(needle)}`);

describe('attendance policy — the governance page', () => {
  test('the hero keeps the version, publish trail and the three actions', () => {
    has(policy, 'Enterprise attendance policy', 'title');
    has(policy, 'Workforce governance', 'eyebrow');
    has(policy, 'Version history ({history.length})', 'history action');
    has(policy, 'Save draft', 'draft action');
    has(policy, 'Publish policy update', 'publish action');
    has(policy, 'Base zone', 'timezone line');
    has(policy, 'Last published', 'publish stamp');
  });

  test('all six rule groups are drawn, in the mock order', () => {
    const order = [
      'Core hours & grace',
      'Break & meals',
      'Missing punch & regularization',
      'Overtime & comp-off',
      'Geofence & locations',
      'Audit & notifications',
    ];
    let cursor = -1;
    for (const label of order) {
      const at = policy.indexOf(label);
      assert.ok(at > cursor, `${label} must be present and follow the mock order`);
      cursor = at;
    }
    for (const n of ['01', '02', '03', '04', '05']) {
      has(policy, `Rule group {String(n).padStart(2, '0')}`, 'rule pill helper');
    }
  });

  test('the editable groups write real policy fields', () => {
    has(policy, "setSection('thresholds'", 'thresholds');
    has(policy, "setSection('grace'", 'grace');
    has(policy, "setSection('breaks'", 'breaks');
    has(policy, "setSection('missingPunch'", 'missing punch');
    has(policy, "setSection('overtime'", 'overtime');
    has(policy, "setSection('weeklyTarget'", 'weekly target');
    has(policy, 'saveLocation', 'geofence create/edit');
    has(policy, 'toggleLocationActive', 'geofence activate');
    has(policy, 'setNotification', 'notification toggles');
  });

  test('the blocks with no schema behind them say so instead of inventing', () => {
    has(policy, 'Monthly grace occurrences', 'grace occurrences block is kept');
    has(policy, 'The policy has no occurrence cap', 'and explains itself');
    has(policy, 'Monthly regularization limit', 'monthly limit block is kept');
    has(policy, 'Biometric break validation', 'biometric block is kept');
    has(policy, 'turnstile terminals are not wired', 'and explains itself');
    has(policy, 'Comp-off validity window', 'expiry block is kept');
    has(policy, 'Not configured', 'the unconfigured chip');
  });

  test('the health card is a ratio over real fields, not a compliance score', () => {
    has(policy, 'const checks = [', 'explicit field list');
    has(policy, 'const completeness = Math.round((configured / checks.length) * 100)', 'derived %');
    has(policy, 'not a compliance score', 'states what it is not');
  });

  test('the version timeline reads the history endpoint', () => {
    has(policy, 'history.map((row)', 'its own rows');
    has(policy, 'Version {row.configVersion}', 'the version');
    has(policy, 'row.activatedAt || row.updatedAt || row.createdAt', 'real timestamps');
  });

  test('no invented statute or score', () => {
    assert.ok(!/98\.4%/.test(policy), 'the mock score is not copied');
    assert.ok(!/Section 3 of the Industrial/.test(policy), 'no fabricated statute citation');
    assert.ok(!/1,842 employees|1,784 On-track/.test(policy), 'no fabricated headcounts');
  });
});

describe('overtime, comp-off & exceptions', () => {
  test('hero, tabs and billing cycle', () => {
    has(overtime, 'Overtime, comp-off &amp; attendance exceptions', 'title');
    has(overtime, 'Work-life ergonomics', 'eyebrow');
    has(overtime, 'View guidelines', 'policy link');
    has(overtime, 'Claim overtime', 'primary action');
    has(overtime, 'Overtime &amp; comp-off claims', 'tab 1');
    has(overtime, 'Review queue', 'tab 2');
    has(overtime, 'Punch regularizations', 'tab 3 links the real surface');
    has(overtime, 'Work mode requests', 'tab 4 links the real surface');
    has(overtime, 'Billing cycle', 'the cycle line');
  });

  test('three metrics, each from a real read', () => {
    has(overtime, 'Available comp-off bank', 'bank tile');
    has(overtime, 'leaveService.my()', 'bank comes from the leave balance');
    has(overtime, 'Pending manager approval', 'pending tile');
    has(overtime, 'Approved this quarter', 'quarter tile');
    has(overtime, 'quarterOf(r.attendanceDate)', 'quarter is computed, not assumed');
  });

  test('the eligible-day cards keep schedule, punch, extra and the claim action', () => {
    has(overtime, 'Eligible overtime &amp; weekend days', 'section');
    has(overtime, 'Sched:', 'schedule line');
    has(overtime, 'Punch:', 'punch line');
    has(overtime, 'Eligible:', 'eligible line');
    has(overtime, 'openForm(day)', 'claim action');
    has(overtime, 'BLOCKER_LABEL', 'below-threshold reasons are named');
  });

  test('the table keeps the mock columns and the decide path', () => {
    has(overtime, 'Date worked', 'column');
    has(overtime, 'Excess hours', 'column');
    has(overtime, 'Compensation', 'column');
    has(overtime, 'Approver', 'column');
    has(overtime, 'attendanceOvertimeService.approve', 'approve');
    has(overtime, 'attendanceOvertimeService.reject', 'reject');
    has(overtime, 'attendanceOvertimeService.cancel', 'cancel');
  });

  test('the unbacked rail blocks are stated, not faked', () => {
    has(overtime, 'Quarterly overtime cap — the policy has no cap field.', 'cap');
    has(overtime, 'Comp-off expiry (60-day rule) — no expiry is enforced.', 'expiry');
    assert.ok(!/1\.5x Multiplier|2\.0x Comp/.test(overtime), 'no copied multiplier claim');
    assert.ok(!/₹/.test(overtime), 'no currency symbol: this surface tracks time, not money');
    assert.ok(!/inr|rupee/i.test(overtime), 'no money formatting either');
  });
});

describe("who's working today", () => {
  test('the hero keeps presence, privacy and the sync stamp', () => {
    has(team, "Who&apos;s working", 'title');
    has(team, 'Real-time presence', 'eyebrow');
    has(team, 'Consensual &amp; privacy-first', 'privacy line');
    has(team, 'Live sync', 'sync stamp');
  });

  test('all seven counters survive', () => {
    for (const label of [
      'Working now',
      'On break',
      'Completed',
      'Not yet in',
      'Late arrival',
      'On leave',
      'Action required',
    ]) {
      has(team, label, 'counter');
    }
    has(team, 'counts.exceptions', 'action required is the exception count');
  });

  test('filters keep search, department, status and the work-mode chips', () => {
    has(team, 'Filter by name, employee code or role', 'search');
    has(team, 'All departments ({departments.length})', 'department select');
    has(team, 'All statuses', 'status select');
    has(team, 'In office', 'mode chip');
    has(team, 'Remote / WFH', 'mode chip');
    has(team, 'Field / client site', 'mode chip');
  });

  test('the closing cards are derived or explicitly empty', () => {
    has(team, 'Presence by modality', 'donut card');
    has(team, 'const shareOf = (n)', 'share is computed');
    has(team, 'Floor capacity', 'capacity card is kept');
    has(team, 'Not configured', 'and states it has no desk register');
    has(team, 'Operational attention', 'attention card');
    has(team, '/app/attendance/regularizations', 'resolve path is real');
  });

  test('the board stays a presence board', () => {
    has(team, 'Presence, not surveillance.', 'ethical footer');
    assert.ok(!/latitude|longitude|geolocation|navigator\.geolocation/.test(team), 'never shows coordinates');
    assert.ok(!/productivity score|keystroke/i.test(team.replace('keystrokes', '')), 'no activity claims');
  });
});

describe('the three surfaces are on the same token set', () => {
  test('each page declares the Warm Organic scope and no raw hex', () => {
    for (const [file, source] of [
      [POLICY, policy],
      [OVERTIME, overtime],
      [TEAM, team],
    ]) {
      assert.ok(source.includes('st-surface'), `${file} must declare the scope`);
      assert.ok(!/#[0-9a-fA-F]{6}\b/.test(source), `${file} must not hard-code a hex colour`);
    }
  });

  test('no dark-only white alphas crept back in', () => {
    for (const [file, source] of [
      [POLICY, policy],
      [OVERTIME, overtime],
      [TEAM, team],
    ]) {
      assert.ok(!/\b(bg|border)-white\/(5|10|20)\b/.test(source), `${file} uses st- surfaces instead`);
    }
  });
});
