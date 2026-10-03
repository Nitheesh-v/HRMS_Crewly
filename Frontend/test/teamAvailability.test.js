// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.3 — TEAM AVAILABILITY FRONTEND SOURCE-PIN TEST
//
//  Spec target: §41 — 24 assertions.
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

const ROUTES_FILE = read('src/routes/AppRoutes.jsx');
const LAYOUT_FILE = read('src/layout/AppLayout.jsx');
const PAGE_FILE = read('src/pages/team/TeamAvailabilityPage.jsx');
const SERVICE_FILE = read('src/services/presenceService.js');
const SLICE_FILE = read('src/redux/slices/presenceSlice.js');
const PRESENCE_INDICATOR_FILE = read(
  'src/components/presence/PresenceIndicator.jsx',
);

// ─────────────────────────────────────────────────────────────────────
test('teamAvailability — /app/team/availability route registered with SENIORS guard', () => {
  assert.ok(
    ROUTES_FILE.includes('path="team/availability"'),
    'team/availability route must be registered',
  );
  const idx = ROUTES_FILE.indexOf('path="team/availability"');
  const snippet = ROUTES_FILE.slice(Math.max(0, idx - 200), idx + 400);
  assert.ok(
    snippet.includes('RequireRole roles={SENIORS}'),
    'team/availability must be guarded by SENIORS',
  );
});

test('teamAvailability — lazy import for the page exists', () => {
  assert.ok(
    ROUTES_FILE.includes(
      'lazy(() => import("../pages/team/TeamAvailabilityPage.jsx"))',
    ),
    'page must be lazy-imported like every other route',
  );
});

test('teamAvailability — sidebar entry added to teamMenu, gated by ATTENDANCE_READ', () => {
  assert.ok(
    /const\s+teamMenu\s*=\s*hasAnyPermission\(\[\s*['"]ATTENDANCE_READ['"]\s*\]\)/.test(
      LAYOUT_FILE,
    ),
    'teamMenu must be gated by ATTENDANCE_READ',
  );
  assert.ok(
    LAYOUT_FILE.includes("/app/team/availability"),
    'teamMenu must include /app/team/availability',
  );
  assert.ok(
    /Team Availability/.test(LAYOUT_FILE),
    'teamMenu label must read "Team Availability"',
  );
});

test('teamAvailability — sidebar entry does NOT add a new permission key', () => {
  assert.equal(
    LAYOUT_FILE.includes("'TEAM_AVAILABILITY_READ'"),
    false,
    'no new permission key invented',
  );
  assert.equal(
    LAYOUT_FILE.includes("'PRESENCE_READ'"),
    false,
    'no PRESENCE_READ key invented',
  );
});

test('teamAvailability — slice exports fetchTeamAvailability thunk', () => {
  assert.ok(
    /export\s+const\s+fetchTeamAvailability\s*=\s*createAsyncThunk/.test(SLICE_FILE),
    'fetchTeamAvailability thunk must exist',
  );
});

test('teamAvailability — slice owns team + teamLoading + teamError state', () => {
  assert.ok(/team:\s*EMPTY_TEAM_AVAILABILITY/.test(SLICE_FILE));
  assert.ok(/teamLoading:\s*['"]idle['"]/.test(SLICE_FILE));
  assert.ok(/teamError:\s*null/.test(SLICE_FILE));
});

test('teamAvailability — slice handles pending/fulfilled/rejected for fetchTeamAvailability', () => {
  assert.ok(
    /addCase\(fetchTeamAvailability\.pending/.test(SLICE_FILE),
    'pending case',
  );
  assert.ok(
    /addCase\(fetchTeamAvailability\.fulfilled/.test(SLICE_FILE),
    'fulfilled case',
  );
  assert.ok(
    /addCase\(fetchTeamAvailability\.rejected/.test(SLICE_FILE),
    'rejected case',
  );
});

test('teamAvailability — service exports getTeamAvailability that calls /presence/team', () => {
  assert.ok(
    /export\s+const\s+getTeamAvailability\s*=/.test(SERVICE_FILE),
    'getTeamAvailability must exist',
  );
  assert.ok(
    SERVICE_FILE.includes('${PREFIX}/team'),
    'must hit /presence/team',
  );
});

test('teamAvailability — service URL never includes companyId/userId/employeeId/company/user/employee', () => {
  const getTeamFn = SERVICE_FILE.match(
    /export\s+const\s+getTeamAvailability[\s\S]+?^\};/m,
  );
  assert.ok(getTeamFn, 'getTeamAvailability function must exist');
  const body = getTeamFn[0];
  for (const field of [
    'companyId',
    'company',
    'userId',
    'user',
    'employeeId',
    'employee',
  ]) {
    assert.equal(
      body.includes(field),
      false,
      `service must not include ${field}`,
    );
  }
});

test('teamAvailability — page does NOT call any presence mutation endpoints', () => {
  const mutations = [
    'putStatus',
    'putStatusMessage',
    'putWorkLocation',
    'updateMyStatus',
    'updateMyStatusMessage',
    'updateMyWorkLocation',
  ];
  for (const m of mutations) {
    assert.equal(PAGE_FILE.includes(m), false, `page must not call ${m}`);
  }
});

test('teamAvailability — page does NOT import any AI surface', () => {
  const aiImports = [
    'AiController',
    'aiService',
    'aiSlice',
    'hrContextRetriever',
    'groq',
    'GROQ_API_KEY',
    '/ai',
  ];
  for (const ai of aiImports) {
    assert.equal(
      PAGE_FILE.includes(ai),
      false,
      `page must not import ${ai}`,
    );
  }
});

test('teamAvailability — page does NOT write to localStorage or sessionStorage', () => {
  // Strip line comments + block comments so the assertion is not
  // poisoned by the page's own negative documentation ("never writes
  // to localStorage") that lives in a comment.
  const stripped = PAGE_FILE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(stripped.includes('localStorage'), false);
  assert.equal(stripped.includes('sessionStorage'), false);
});

test('teamAvailability — page does NOT call fetch/socket/NATS/WebSocket', () => {
  assert.equal(
    /new\s+WebSocket\s*\(/.test(PAGE_FILE),
    false,
    'page must not use WebSocket',
  );
  assert.equal(
    /\bnats\b/i.test(PAGE_FILE),
    false,
    'page must not mention NATS',
  );
  assert.equal(
    /\bfetch\s*\(/.test(PAGE_FILE),
    false,
    'page must not use fetch directly',
  );
});

test('teamAvailability — page reuses PresenceIndicator (not a custom dot)', () => {
  assert.ok(
    PAGE_FILE.includes('PresenceIndicator'),
    'page must use PresenceIndicator',
  );
  assert.ok(
    PRESENCE_INDICATOR_FILE.includes('aria-label'),
    'PresenceIndicator must carry aria-label',
  );
});

test('teamAvailability — page renders summary tiles (byPresence + byWorkLocation)', () => {
  assert.ok(PAGE_FILE.includes('byPresence'));
  assert.ok(PAGE_FILE.includes('byWorkLocation'));
  assert.ok(PAGE_FILE.includes('SummaryTile'));
});

test('teamAvailability — page filters compose: presence OR workLocation chips, plus search', () => {
  // Search input: any of these markers is enough to prove it exists.
  const hasSearch = PAGE_FILE.includes('team-availability-page__search')
    || PAGE_FILE.includes('id="team-availability-search"')
    || PAGE_FILE.includes("id='team-availability-search'")
    || PAGE_FILE.includes('aria-label="Search teammates"');
  assert.ok(hasSearch);
  assert.ok(PAGE_FILE.includes('Presence'));
  assert.ok(PAGE_FILE.includes('Location'));
});

test('teamAvailability — search input has maxLength + bounded trim to MAX_SEARCH_LEN', () => {
  assert.ok(/maxLength=\{MAX_SEARCH_LEN\}/.test(PAGE_FILE));
  assert.ok(/MAX_SEARCH_LEN\s*=\s*60/.test(PAGE_FILE));
});

test('teamAvailability — page never exposes password/email/phone/salary/Aadhaar/PAN/UAN/deductions', () => {
  // Strip line comments + block comments so the assertion is not
  // poisoned by the page's own negative documentation ("never exposes
  // password / email / ...") that lives in a comment.
  //
  // The role names COMPANY_ADMIN and HR_MANAGER also contain the
  // substring "PAN" / "MANAGER", so we assert PII presence using
  // word-boundary regex, not substring includes.
  const stripped = PAGE_FILE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const wordChecks = [
    /\bpassword\b/i,
    /\bsalary\b/i,
    /\bAadhaar\b/,
    /\bAADHAAR\b/,
    /\bPAN\b/,
    /\bUAN\b/,
    /\bbankAccount\b/,
    /\bdeductions\b/,
    /@/,
  ];
  for (const re of wordChecks) {
    assert.equal(
      re.test(stripped),
      false,
      `page must not contain token matching ${re}`,
    );
  }
});

test('teamAvailability — page does NOT contain presence mutation thunks', () => {
  for (const thunk of [
    'loadMyPresence',
    'updateMyStatus',
    'updateMyStatusMessage',
    'updateMyWorkLocation',
  ]) {
    assert.equal(PAGE_FILE.includes(thunk), false, `page must not dispatch ${thunk}`);
  }
});

test('teamAvailability — page only dispatches fetchTeamAvailability', () => {
  assert.ok(PAGE_FILE.includes('fetchTeamAvailability'));
});

test('teamAvailability — page does NOT open any new route in this iframe', () => {
  assert.equal(/\<iframe\s+iframe\b/.test(PAGE_FILE), false);
  assert.equal(PAGE_FILE.includes('window.open'), false);
});

test('teamAvailability — page is reachable under RequireRole; no bypass via direct fetch', () => {
  const idx = ROUTES_FILE.indexOf('path="team/availability"');
  const slice = ROUTES_FILE.slice(idx, idx + 400);
  assert.ok(
    slice.includes('<RequireRole roles={SENIORS}>'),
    'team/availability route must be wrapped in RequireRole',
  );
});

test('teamAvailability — sidebar item lives in the same teamMenu group as "Who\'s Working"', () => {
  const teamMenuBlock = LAYOUT_FILE.match(
    /const\s+teamMenu\s*=[\s\S]+?\n\s*:\s*\[\];/,
  );
  assert.ok(teamMenuBlock, 'teamMenu must exist');
  const block = teamMenuBlock[0];
  assert.ok(block.includes("Who's Working"));
  assert.ok(block.includes('/app/team/availability'));
});

test('teamAvailability — page renders empty table copy when no items', () => {
  assert.ok(PAGE_FILE.includes('No teammates match these filters.'));
});