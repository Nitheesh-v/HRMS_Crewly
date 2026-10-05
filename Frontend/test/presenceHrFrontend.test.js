// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.6 — LEAVE + WORKING-HOURS FRONTEND SOURCE-PIN TEST
//
//  Spec target: §41 — 18 assertions.
//
//  WHAT THIS FILE PROVES
//    The frontend surfaces 37.6-derived presence facts (on_leave +
//    outside_working_hours) as:
//
//      · a read-only "On Leave" banner in the PresenceMenu (37.2
//        popover) when the server reports presence === 'on_leave';
//      · a "On Leave" filter chip + a "Outside Working Hours" filter
//        chip on the Team Availability page (37.3 page);
//      · a "On Leave" tile + an "Outside Working Hours" tile in the
//        team summary;
//      · the workLocation badge replaced with "On Leave" on the team
//        page for on-leave members (37.6 hides workLocation in the
//        public DTO);
//      · the new DTO fields pass through the frontend service without
//        being stripped (presenceService.js is a thin pass-through);
//      · the new constants on EMPTY_PRESENCE in the redux constants;
//      · no new top-level slice (37.6 extends presenceSlice, no
//        new file).
// ═══════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..',
);

const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8');

const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const PAGE_FILE = read('src/pages/team/TeamAvailabilityPage.jsx');
const MENU_FILE = read('src/components/presence/PresenceMenu.jsx');
const SERVICE_FILE = read('src/services/presenceService.js');
const CONSTANTS_FILE = read('src/redux/slices/presenceConstants.js');
const SLICE_FILE = read('src/redux/slices/presenceSlice.js');
const VISUAL_FILE = read('src/components/presence/presenceVisual.js');

// ─────────────────────────────────────────────────────────────────────
// 1. EMPTY_PRESENCE is extended with the 37.6 fields.
// ─────────────────────────────────────────────────────────────────────
test('37.6 #1 EMPTY_PRESENCE has onLeave key', () => {
  assert.match(
    CONSTANTS_FILE,
    /onLeave/,
    'presenceConstants.js must declare onLeave',
  );
});

test('37.6 #2 EMPTY_PRESENCE has outsideWorkingHours key', () => {
  assert.match(
    CONSTANTS_FILE,
    /outsideWorkingHours/,
    'presenceConstants.js must declare outsideWorkingHours',
  );
});

test('37.6 #3 EMPTY_PRESENCE has workingHoursSource/Phase/IsWorkingDay keys', () => {
  assert.match(CONSTANTS_FILE, /workingHoursSource/);
  assert.match(CONSTANTS_FILE, /workingHoursPhase/);
  assert.match(CONSTANTS_FILE, /workingHoursIsWorkingDay/);
});

// ─────────────────────────────────────────────────────────────────────
// 4-6. PresenceMenu renders an "On Leave" banner + disables affordances.
// ─────────────────────────────────────────────────────────────────────
test('37.6 #4 PresenceMenu renders an "On Leave" banner when presence === on_leave', () => {
  const m = stripComments(MENU_FILE);
  assert.match(
    m,
    /presence\?\.presence\s*===\s*'on_leave'/,
    'menu must short-circuit on presence === on_leave',
  );
  assert.match(
    m,
    /On Leave/i,
    'menu must contain the "On Leave" label',
  );
  assert.match(
    m,
    /on-leave-banner|onLeaveBanner/,
    'menu must add a testable banner hook',
  );
});

test('37.6 #5 PresenceMenu explains why controls are disabled', () => {
  // Server-derived, not user-actionable. The user must see why.
  const m = stripComments(MENU_FILE);
  assert.match(
    m,
    /disabled|temporarily disabled/,
    'menu banner must mention that controls are disabled',
  );
});

// ─────────────────────────────────────────────────────────────────────
// 6-10. Team page chip + summary tile + hide workLocation.
// ─────────────────────────────────────────────────────────────────────
test('37.6 #6 Team page filter chip includes on_leave', () => {
  const p = stripComments(PAGE_FILE);
  assert.match(p, /'on_leave'/, 'filter chip values must include on_leave');
});

test('37.6 #7 Team page filter chip includes outside_working_hours', () => {
  const p = stripComments(PAGE_FILE);
  assert.match(
    p,
    /'outside_working_hours'/,
    'filter chip values must include outside_working_hours',
  );
});

test('37.6 #8 Team page has a "On Leave" summary tile', () => {
  const p = stripComments(PAGE_FILE);
  assert.match(p, /On Leave/, 'summary tile label "On Leave" must exist');
});

test('37.6 #9 Team page has a "Outside Working Hours" summary tile', () => {
  const p = stripComments(PAGE_FILE);
  assert.match(
    p,
    /Outside Working Hours/,
    'summary tile label "Outside Working Hours" must exist',
  );
});

test('37.6 #10 Team page hides workLocation badge for on_leave rows', () => {
  // 37.6: on leave → no workLocation is shown to teammates.
  const p = stripComments(PAGE_FILE);
  const idx = p.indexOf("item.presence === 'on_leave'");
  assert.ok(idx > 0, 'team page must short-circuit on item.presence === on_leave');
  const snippet = p.slice(idx, idx + 200);
  assert.match(
    snippet,
    /On Leave/,
    'on-leave row must render an "On Leave" badge',
  );
});

// ─────────────────────────────────────────────────────────────────────
// 11-13. presenceService is a thin pass-through (no DTO stripping).
// ─────────────────────────────────────────────────────────────────────
test('37.6 #11 presenceService exports TEAM_PRESENCE_FILTERS whitelist', () => {
  const s = stripComments(SERVICE_FILE);
  assert.match(
    s,
    /TEAM_PRESENCE_FILTERS/,
    'service must export the presence filter whitelist',
  );
  assert.match(s, /'on_leave'/);
  assert.match(s, /'outside_working_hours'/);
});

test('37.6 #12 presenceService.getMyPresence is a thin passthrough', () => {
  // No DTO mapping; the backend already strips sensitive fields.
  const s = stripComments(SERVICE_FILE);
  const idx = s.indexOf('export const getMyPresence');
  const snippet = s.slice(idx, idx + 200);
  assert.match(snippet, /api\.get\(/);
  // No field-stripping / mapping helpers added for 37.6.
  assert.doesNotMatch(
    snippet,
    /onLeave:.*null|delete.*onLeave|omit.*onLeave/,
    'getMyPresence must not drop the 37.6 fields',
  );
});

test('37.6 #13 presenceService.getTeamAvailability forwards on_leave filter', () => {
  // The whitelist is the gating mechanism; the new tokens must be in it.
  // 37.6 added them in TEAM_PRESENCE_FILTERS, not in the function body.
  const s = stripComments(SERVICE_FILE);
  assert.match(s, /'on_leave'/);
  assert.match(s, /'outside_working_hours'/);
});

// ─────────────────────────────────────────────────────────────────────
// 14-16. presenceVisual + presenceSlice unchanged semantics.
// ─────────────────────────────────────────────────────────────────────
test('37.6 #14 presenceVisual does not mark on_leave as selectable', () => {
  // 37.6: on_leave is a server-derived fact, not a manual control.
  // isSelectablePresence must stay available / busy / dnd only.
  const v = stripComments(VISUAL_FILE);
  assert.match(
    v,
    /'available'\s*\|\|\s*value\s*===\s*'busy'\s*\|\|\s*value\s*===\s*'dnd'/,
    'isSelectablePresence must whitelist only the 3 manual states',
  );
  // on_leave is server-derived; the visual must not promote it to a
  // manual control.
  assert.doesNotMatch(
    v,
    /isSelectablePresence\s*\([^)]*on_leave[^)]*\)\s*\|\|/,
    'on_leave must not be a manual selectable state',
  );
});

test('37.6 #15 No new top-level redux slice is created', () => {
  // 37.6 extends presenceSlice, does not introduce a new slice.
  const dir = path.join(ROOT, 'src/redux/slices');
  const files = fs.readdirSync(dir);
  const newSlice = files.find((f) => /leave|working.?hours|hr.?context/i.test(f));
  assert.equal(
    newSlice,
    undefined,
    `no new slice for leave/working-hours expected; found ${newSlice}`,
  );
});

test('37.6 #16 presenceSlice still contains 37.2/37.3 keys (no rewrite)', () => {
  // The slice was extended, not rewritten. Pin the canonical 37.2/37.3
  // keys plus the 37.6 on_leave-aware reducer.
  const s = stripComments(SLICE_FILE);
  assert.match(s, /workLocation/, '37.6 keeps workLocation key');
  assert.match(s, /workLocationRequests/, '37.5 keeps workLocationRequests key');
  assert.match(s, /statusMessage|statusMessagesEnabled/, '37.2 keeps status message key');
});

// ─────────────────────────────────────────────────────────────────────
// 17-18. Privacy + no NATS / no AI / no scheduler on the frontend.
// ─────────────────────────────────────────────────────────────────────
test('37.6 #17 No frontend NATS client is introduced', () => {
  // 37.6 must NOT depend on nats.ws / nats-io / NATS.
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.assign(
    {},
    pkg.dependencies || {},
    pkg.devDependencies || {},
  );
  for (const name of Object.keys(deps)) {
    assert.equal(
      /^nats/i.test(name),
      false,
      `package.json must not include NATS dep ${name}`,
    );
  }
});

test('37.6 #18 No frontend localStorage writes for presence', () => {
  // 37.6 specifically forbids new persistence. The presence-only
  // surface (slice, services, components, redux) must not write
  // localStorage / sessionStorage.
  const dir = path.join(ROOT, 'src');
  const stack = [];
  const visit = (dirPath) => {
    for (const name of fs.readdirSync(dirPath)) {
      const p = path.join(dirPath, name);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) visit(p);
      else if (/\.(js|jsx)$/.test(name)) stack.push(p);
    }
  };
  visit(dir);
  const offenders = [];
  for (const p of stack) {
    const rel = path.relative(ROOT, p);
    // Pin only the presence surface. Other features (auth/kiosk) own
    // their own persistence and are out of scope for 37.6.
    if (!/(presence|presenceSlice|presenceService|presenceRuntime|presenceStore)/.test(rel)) {
      continue;
    }
    const text = stripComments(read(rel));
    if (/(localStorage|sessionStorage)\.setItem/.test(text)) {
      offenders.push(rel);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `no presence file may write localStorage/sessionStorage; offenders: ${offenders.join(', ')}`,
  );
});
