// ═══════════════════════════════════════════════════════════════════════════
// OPERATIONS SURFACES — Assets, Profile Change Requests, and the performance
// cycle dialog.
//
// These three were rebuilt to the layouts the owner sent. What is pinned here
// is what a redesign usually breaks: the endpoints that do the work, the fact
// that every number on screen is counted from the response, and the absence of
// the dashboard furniture the mock carries but this API never had.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const assets = read('src/pages/assets/AssetsPage.jsx');
const changes = read('src/pages/profile/ProfileChangeRequestsPage.jsx');
const perf = read('src/pages/performance/PerformancePage.jsx');
const perfService = read('src/services/perfService.js');

describe('assets register', () => {
  test('uses the six asset endpoints and nothing invented', () => {
    for (const call of [
      'getMyAssets()',
      'getAllAssets()',
      'createAsset({',
      'assignAsset(',
      'returnAsset(',
      'deleteAsset(',
    ]) {
      assert.ok(assets.includes(call), `missing ${call}`);
    }
    // There is no endpoint for a repair queue, a scan or a purchase order.
    for (const missing of ['/assets/scan', 'repair', 'purchaseOrder']) {
      assert.equal(assets.includes(missing), false, `${missing} has no API behind it`);
    }
  });

  test('the register says what the model actually stores', () => {
    for (const field of ["name", "category", "serialNumber", "note", "status", 'currentHolder']) {
      assert.ok(assets.includes(field), `the row no longer shows ${field}`);
    }
    // Two statuses exist. "In service" and "ready to deploy" are the mock's
    // words for states this register cannot represent.
    assert.match(assets, /status === 'ASSIGNED' \? 'In use' : 'In stock'/);
    assert.equal(assets.includes('In service'), false);
    assert.equal(assets.includes('Ready to deploy'), false);
  });

  test('no telemetry the API does not collect', () => {
    for (const claim of ['AES-256', 'Battery Health', 'FileVault', 'Encrypted', 'warranty', 'Warranty']) {
      assert.equal(assets.includes(claim), false, `"${claim}" is not recorded anywhere`);
    }
  });

  test('the pool filters by category group and status, and pages', () => {
    assert.match(assets, /const GROUPS = \[/);
    assert.match(assets, /statusFilter !== 'ALL' && a\.status !== statusFilter/);
    assert.match(assets, /const PER_PAGE = 8;/);
    // Table and cards are the same rows read two ways; the mock has both.
    assert.match(assets, /const \[view, setView\] = useState\('TABLE'\)/);
    assert.match(assets, /Showing \{visible\.length\} of \{filtered\.length\}/);
  });

  test('a stock item can be assigned from the header, not only from its row', () => {
    assert.match(assets, /const doAssignFromPool = async \(\) => \{/);
    assert.match(assets, /await assignAsset\(poolForm\.assetId, \{ userId: poolForm\.userId/);
    assert.match(assets, /Assign asset\s*<\/button>/);
  });

  test('export is a CSV of the rows on screen, not a ZIP', () => {
    assert.match(assets, /a\.download = `assets-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.csv`/);
    assert.equal(assets.toLowerCase().includes('zip'), false);
  });

  test('adding an asset can hand it straight to a person', () => {
    assert.match(assets, /if \(form\.assignTo && newId\) \{/);
    assert.match(assets, /await assignAsset\(newId, \{ userId: form\.assignTo/);
    assert.match(assets, /the employee has been notified/i);
  });
});

describe('profile change queue', () => {
  test('keeps the three endpoints that decide anything', () => {
    for (const call of [
      'profileService.pendingChangeRequests()',
      "profileService.changeRequestHistory('approved')",
      "profileService.changeRequestHistory('rejected')",
      'profileService.decideChangeRequest(',
    ]) {
      assert.ok(changes.includes(call), `missing ${call}`);
    }
  });

  test('old and new value sit side by side, from the serialized diff', () => {
    assert.match(changes, /Current record/);
    assert.match(changes, /Proposed/);
    assert.match(changes, /change\.from/);
    assert.match(changes, /change\.to/);
    // Sensitive fields arrive masked and are labelled, never re-derived.
    assert.match(changes, /change\.sensitive \? 'bg-crewly-red\/15 text-crewly-red'/);
  });

  test('the counts are counted, not promised', () => {
    assert.match(changes, /const decided = history\.length;/);
    assert.match(changes, /const approvedCount = history\.filter/);
    assert.match(changes, /const decisionHours = useMemo/);
    // The mock's fixed "4.2h" and "12 auto-approved" have no source here.
    assert.equal(changes.includes('4.2'), false);
    assert.equal(changes.includes('Auto-approved'), false);
    assert.equal(changes.includes('SLA'), false);
  });

  test('the queue-status bar reports, it does not simulate', () => {
    assert.match(changes, /Queue status: \$\{pending\.length\} pending review/);
    assert.match(changes, /Queue status: all caught up/);
    // The mock's "Simulate Empty State" button has nothing behind it.
    assert.equal(changes.includes('Simulate'), false);
  });

  test('rejecting still requires a reason', () => {
    assert.match(changes, /disabled=\{saving \|\| \(deciding\.action === 'reject' && note\.trim\(\)\.length === 0\)\}/);
    assert.match(changes, /'Reason \(required\)'/);
  });

  test('a stale decision reloads instead of lying', () => {
    assert.match(changes, /if \(err\?\.status === 409\) reload\(\);/);
  });
});

describe('performance page', () => {
  const styles = read('src/style.css');

  test('the page is built from the sections the mock shows', () => {
    for (const heading of ['My appraisal', 'Team board', 'Performance history', 'Cycle phases', 'Draft cycles']) {
      assert.ok(perf.includes(heading), `the page lost its "${heading}" block`);
    }
    // The track is a real ordered list of the five stored phases, with a check
    // for the ones behind us — not a decorative image.
    assert.match(perf, /const PhaseStepper = \(\{ status \}\) => \{/);
    assert.match(perf, /<ol className="flex w-full items-start justify-between/);
    assert.match(perf, /Phase \{PHASES\.indexOf\(phase\) \+ 1\} of \{PHASES\.length\}/);
  });

  test('every number on the page is counted, and falls back to a dash', () => {
    for (const counted of ['selfReviewsIn', 'awaitingMe', 'weightTotal', 'goalsSet', 'avgProgress']) {
      assert.ok(perf.includes(`const ${counted} =`), `${counted} is no longer derived`);
    }
    assert.match(perf, /const weightTotal = [\s\S]{0,160}reduce\(/);
    assert.match(perf, /const selfReviewsIn = [\s\S]{0,120}filter\(/);
    // A tile with nothing to report shows an em dash, never a zero dressed up.
    assert.ok(perf.includes("'—'"), 'the dash fallback is gone');
  });

  test('the four tiles change with the role, they are not one fixed row', () => {
    assert.match(perf, /isHR\s*\n?\s*\? \[/);
    assert.ok(perf.includes('Participants'));
    assert.ok(perf.includes('Self reviews in'));
    assert.ok(perf.includes('Waiting on you'));
    assert.ok(perf.includes('My goals'));
  });

  test('goal progress is a labelled range control, not a colour alone', () => {
    assert.match(perf, /type="range"/);
    assert.match(perf, /aria-label=\{`Goal \$\{i \+ 1\} progress/);
    assert.match(perf, /className="goal-range flex-1"/);
    // The slider is styled by the app, not left as browser chrome.
    assert.match(styles, /\.goal-range::-webkit-slider-thumb/);
  });

  test('card headings stay section labels', () => {
    // The base heading scale would promote every card title to 24px, which is
    // what made the first rebuild read as a stack of page headers.
    assert.match(styles, /h2:not\(\.landing-shell h2\):not\(\.auth-shell h2\):not\(\.card-title\)/);
    assert.match(perf, /<h2 className="card-title[^"]*text-sm font-bold/);
  });

  test('the mock furniture this API cannot back is still absent', () => {
    for (const fake of ['9-box', 'Nine-box', 'Skill matrix', 'HiGoal', 'Calibration matrix', 'Attrition risk']) {
      assert.equal(perf.includes(fake), false, `"${fake}" has no data behind it`);
    }
  });

  test('the dialog keeps its footer on screen while the body scrolls', () => {
    assert.match(perf, /flex max-h-\[92vh\] w-full max-w-2xl flex-col overflow-hidden/);
    assert.match(perf, /min-h-0 flex-1 space-y-5 overflow-y-auto p-5/);
  });

  test('a draft cycle is HR\'s, not everybody\'s', () => {
    // GET /perf/cycles answers every role with drafts included. An employee
    // must not see one as "the latest cycle", nor be told to start one.
    assert.match(perf, /const drafts = isHR \? \(cyclesBox\.cycles \|\| \[\]\)\.filter\(\(c\) => c\.isDraft\) : \[\]/);
    assert.match(perf, /const list = isHR \? \(cyclesBox\.cycles \|\| \[\]\) : startedCycles/);
    assert.match(perf, /const startedCycles = useMemo\(\)?[\s\S]{0,120}filter\(\(c\) => !c\.isDraft\)/);
  });

  test('the review dialog is built like the rest of the page', () => {
    // It used to be a slate panel that only happened to invert with the theme.
    assert.equal(perf.includes('bg-slate-800'), false);
    assert.equal(perf.includes('text-slate-100'), false);
    assert.ok(perf.includes('aria-label={`Review ${reviewTarget.user?.name'), 'the dialog has no accessible name');
    // A rating-less save would write a zero the employee reads as a score.
    assert.match(perf, /disabled=\{busy \|\| !reviewForm\.rating\}/);
    // "No self review" is only true when there is no record at all.
    assert.match(perf, /Submitted without a written summary\./);
    assert.match(perf, /No self review was submitted\./);
  });
});

describe('performance cycle dialog', () => {
  test('sends only what the API now stores', () => {
    for (const field of [
      'methodology',
      'selfReviewDueAt',
      'managerReviewDueAt',
      'calibrationDueAt',
      'excludeProbation',
      'notifyParticipants',
    ]) {
      assert.ok(perf.includes(field), `the dialog never sends ${field}`);
    }
    assert.match(perf, /await createCycle\(\{ \.\.\.cycleForm, saveAsDraft: draft \}\)/);
    // A draft is backed by the server now; a Slack reminder still is not.
    assert.match(perf, /Save as draft/);
    assert.match(perf, /startCycle\(draft\._id/);
    assert.equal(perf.includes('Slack'), false);
  });

  test('the cohort number comes from the API, not from a guess', () => {
    assert.match(perfService, /export const getCycleCohort = async \(\) => unwrap\(await api\.get\('\/perf\/cohort'\)\)/);
    assert.match(perf, /setCohort\(await getCycleCohort\(\)\)/);
    assert.match(perf, /cohort\.total - \(cycleForm\.excludeProbation \? cohort\.onProbation : 0\)/);
  });

  test('the three methodologies are the three the model can store', () => {
    for (const id of ['STANDARD', 'THREE_SIXTY', 'OKR']) {
      assert.ok(perf.includes(`id: '${id}'`), `missing ${id}`);
    }
    assert.match(perf, /name="cycle-methodology"/);
  });

  test('a cycle cannot end before it starts', () => {
    assert.match(perf, /cycleForm\.endDate < cycleForm\.startDate/);
    assert.match(perf, /The cycle cannot end before it starts/);
  });
});
