// ═══════════════════════════════════════════════════════════════════════════
// LEAVES & SCHEDULES — pins for the four rebuilt surfaces.
//
// The mock set for these pages (Work Schedules, Leave Approvals, Holiday
// Calendar, My Leaves & Time Off) asked for structure: summary tiles with a
// status pill, a bucket tab row, cards with a work-window inset and a weekday
// strip, a request card with a stated reason and an action rail, and a
// calendar with typed day chips. Every number in them has to come from a
// response the API actually returns — so these pins hold both halves:
//
//   1. the layout blocks the mock specifies are present;
//   2. the honesty substitutions stay (no bulk endpoint, no half-day field,
//      no invented colour outside the Crewly tokens).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const SCHEDULES = 'src/pages/schedule/SchedulesPage.jsx';
const HOLIDAYS = 'src/pages/schedule/HolidaysPage.jsx';
const LEAVES = 'src/pages/leaves/LeavesPage.jsx';
const APPROVALS = 'src/pages/leaves/LeaveApprovalsPage.jsx';

const schedules = read(SCHEDULES);
const holidays = read(HOLIDAYS);
const leaves = read(LEAVES);
const approvals = read(APPROVALS);

const has = (source, needle, label) =>
  assert.ok(source.includes(needle), `${label}: expected to find ${JSON.stringify(needle)}`);

describe('work schedules — the mock, with numbers that exist', () => {
  test('header carries the eyebrow, title and the two-line subtitle', () => {
    has(schedules, 'Operational cadence', 'eyebrow');
    has(schedules, 'Work schedules', 'title');
    has(schedules, 'Reusable working-day patterns', 'subtitle');
  });

  test('four summary tiles, each with its status pill', () => {
    has(schedules, 'Active patterns', 'tile 1');
    has(schedules, 'Live config', 'pill 1');
    has(schedules, 'Largest assignment', 'tile 2');
    has(schedules, 'Late grace allowance', 'tile 3');
    has(schedules, 'Standardized', 'pill 3');
    has(schedules, 'Compliance', 'tile 4');
  });

  test('bucket tab row with counts and the default tier line', () => {
    has(schedules, 'All schedules', 'bucket');
    has(schedules, 'Core daytime', 'bucket');
    has(schedules, 'Crosses midnight', 'bucket');
    has(schedules, 'Part week', 'bucket');
    has(schedules, 'Default tier:', 'default tier');
  });

  test('each schedule card keeps the work window, weekday strip and actions', () => {
    has(schedules, 'Work window', 'inset');
    has(schedules, 'net / day', 'net hours');
    has(schedules, 'Active working days', 'weekday strip');
    has(schedules, 'Off', 'dimmed weekday');
    has(schedules, 'Edit policy', 'card action');
    has(schedules, 'Assign', 'card action');
  });

  test('the coverage card is arithmetic over real schedules, not a roster feed', () => {
    has(schedules, 'Daily capacity &amp; floor coverage', 'coverage card');
    has(schedules, "const inside = wraps ? hour >= start || hour < end : hour >= start && hour < end;", 'hour overlap maths');
    has(schedules, 'Highest simultaneous occupancy'.replace('Highest simultaneous occupancy', 'Peak overlap'), 'peak callout');
    has(schedules, 'Grace and break logic', 'policy card');
  });

  test('non-HR readers get the gate instead of the register', () => {
    has(schedules, 'Only an admin or HR manager manages work schedules', 'gate copy');
  });
});

describe('leave approvals — one decision at a time', () => {
  test('console header, queue tiles and the three tabs', () => {
    has(approvals, 'Management console', 'eyebrow');
    has(approvals, 'Leave approvals &amp; management', 'title');
    has(approvals, 'Pending queue', 'tile');
    has(approvals, 'Longest waiting', 'tile');
    has(approvals, 'Pending review', 'tab');
    has(approvals, 'History & decisions', 'tab');
    has(approvals, 'Leave policies', 'tab');
  });

  test('the request card keeps the reason quote, the cost tile and the action rail', () => {
    has(approvals, 'What it costs', 'cost tile');
    has(approvals, 'Overlaps', 'overlap tile');
    has(approvals, 'Approve leave', 'approve');
    has(approvals, 'Decline with note', 'decline');
    has(approvals, 'Message', 'message');
    has(approvals, 'Preview zero-pending state', 'collapsed zero state');
    has(approvals, 'Next seven days', 'outlook strip');
  });

  test('bulk actions loop the per-leave endpoint — there is no bulk route', () => {
    assert.ok(/for \(const leave of deciding\.leaves\)/.test(approvals), 'bulk action walks the queue');
    assert.ok(
      approvals.includes('await leaveService.decide(leave._id, deciding.action, note)'),
      'each decision is recorded on its own request',
    );
    assert.ok(
      !/bulkDecide|bulk-approve|leaves\/bulk/.test(approvals),
      'no invented bulk endpoint',
    );
    has(approvals, 'the register has no all-at-once', 'stated limitation');
  });

  test('the policy tab states the caps the engine applies', () => {
    has(approvals, 'Yearly allocation per type', 'policy table');
    has(approvals, 'COMP_OFF', 'comp-off row');
    has(approvals, 'As earned', 'comp-off is not a quota');
  });
});

describe('holiday calendar — month, year, list', () => {
  test('view toggle, filter tags and the add action', () => {
    has(holidays, 'Filter tags', 'tag row');
    has(holidays, "'Month'", 'month view');
    has(holidays, "'Year'", 'year view');
    has(holidays, "'List'", 'list view');
    has(holidays, 'Add holiday', 'create');
    has(holidays, 'Today', 'today jump');
  });

  test('the month grid labels every empty cell honestly', () => {
    has(holidays, 'Regular shift', 'working day');
    has(holidays, 'Weekend', 'weekend');
    has(holidays, 'Compliance note:', 'statutory note');
  });

  test('the rail carries entitlement and the claim path the API backs', () => {
    has(holidays, 'My entitlement', 'entitlement');
    has(holidays, 'Optional holidays', 'optional bucket');
    has(holidays, 'Claim this holiday', 'pick');
    has(holidays, 'scheduleService.pick', 'pick endpoint');
    has(holidays, 'scheduleService.unpick', 'unpick endpoint');
    has(holidays, 'Upcoming', 'upcoming list');
  });

  test('no debug logging left in the page', () => {
    assert.ok(!holidays.includes('console.log'), 'HolidaysPage must not log');
  });
});

describe('my leaves — balances, pace, draft, trail', () => {
  test('four balance cards read the balance array', () => {
    has(leaves, 'My leaves &amp; time off', 'title');
    has(leaves, 'left', 'remaining');
    has(leaves, 'Allocated', 'allocated');
    has(leaves, 'Comp-off', 'comp-off card');
    has(leaves, 'no yearly quota', 'comp-off footnote');
  });

  test('the pace card totals the buckets rather than inventing a quota', () => {
    has(leaves, 'Leave consumption pace', 'pace card');
    has(leaves, 'Where the days went', 'per-bucket breakdown');
    has(leaves, 'Awaiting decision', 'pending bucket');
    has(leaves, 'Next public holiday', 'holiday link');
    has(leaves, 'scheduleService', 'holiday source');
  });

  test('the quick-apply draft explains the scope limit instead of faking it', () => {
    has(leaves, 'Start a request', 'draft card');
    has(leaves, "'First half'", 'scope chip');
    has(leaves, 'Requests are counted in whole working days', 'stated limit');
    has(leaves, 'aria-disabled="true"', 'half-day chips are not actionable');
  });

  test('the trail keeps the window chip, pager and cancel path', () => {
    has(leaves, 'Time off trail', 'trail');
    has(leaves, 'Absence window', 'window column');
    has(leaves, 'Page {current} of {pages}', 'pager');
    has(leaves, 'leaveService.cancel', 'cancel');
  });
});

describe('the rebuild stays on Crewly tokens', () => {
  test('no raw hex colours in any of the four pages', () => {
    for (const [file, source] of [
      [SCHEDULES, schedules],
      [HOLIDAYS, holidays],
      [LEAVES, leaves],
      [APPROVALS, approvals],
    ]) {
      assert.ok(!/#[0-9a-fA-F]{6}\b/.test(source), `${file} must not hard-code a hex colour`);
    }
  });

  test('no sky / indigo / purple / blue utility classes', () => {
    for (const [file, source] of [
      [SCHEDULES, schedules],
      [HOLIDAYS, holidays],
      [LEAVES, leaves],
      [APPROVALS, approvals],
    ]) {
      assert.ok(
        !/\b(?:bg|text|border|ring)-(?:blue|indigo|sky|purple|violet|cyan)-\d{2,3}\b/.test(source),
        `${file} must not import the mock palette`,
      );
    }
  });

  test('every surface uses the shared card / inset tokens', () => {
    for (const [file, source] of [
      [SCHEDULES, schedules],
      [HOLIDAYS, holidays],
      [LEAVES, leaves],
      [APPROVALS, approvals],
    ]) {
      assert.ok(source.includes('card'), `${file} must use the card token`);
      assert.ok(source.includes('crewly-inset'), `${file} must use the inset token`);
    }
  });
});
