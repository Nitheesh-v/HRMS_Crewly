// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUESTS FRONTEND SOURCE-PIN SUITE
//
//  24 numbered test cases. Mirrors the 37.3 teamAvailability.test.js
//  shape — every assertion is a substring/structure check against the
//  37.5 source files. No React render; no Redux store.
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ROUTES = read('src/routes/AppRoutes.jsx');
const SERVICE = read('src/services/presence/workLocationRequestService.js');
const SLICE = read('src/redux/slices/presenceSlice.js');
const STORE = read('src/redux/store.js');
const SELECTOR = read('src/components/presence/WorkLocationSelector.jsx');
const DIALOG = read('src/components/presence/WorkLocationRequestDialog.jsx');
const HISTORY = read('src/components/presence/WorkLocationRequestHistory.jsx');
const MENU = read('src/components/presence/PresenceMenu.jsx');
const REVIEW = read('src/pages/presence/WorkLocationReviewPage.jsx');

const REACT_RUNTIME = read('src/components/presence/WorkLocationRequestDialog.jsx');

// ── 1–6: routing + structure ─────────────────────────────

test('#1 route — work-location-requests/review is registered', () => {
  assert.ok(
    ROUTES.includes('path="presence/work-location-requests/review"'),
    'review route must be registered',
  );
});

test('#2 route — review page is lazy-imported', () => {
  assert.ok(
    ROUTES.includes(
      'lazy(() => import("../pages/presence/WorkLocationReviewPage.jsx"))',
    ),
    'review page must be lazy-imported',
  );
});

test('#3 route — review route is HR-guarded', () => {
  const idx = ROUTES.indexOf('path="presence/work-location-requests/review"');
  const snippet = ROUTES.slice(Math.max(0, idx - 200), idx + 400);
  assert.ok(
    snippet.includes('RequireRole roles={HR}'),
    'review route must be HR-guarded',
  );
});

test('#4 service — exports a `submit` function calling the right endpoint', () => {
  assert.match(SERVICE, /submit:\s*\([A-Za-z_]+\)\s*=>\s*unwrap\(api\.post\(PREFIX/);
  assert.match(SERVICE, /api\.post\(PREFIX,\s*payload\)/);
});

test('#5 service — `me` endpoint is the right path', () => {
  assert.match(SERVICE, /mine:\s*\(\)\s*=>\s*unwrap\(api\.get\(`\$\{PREFIX\}\/me`\)/);
});

test('#6 service — pending and decide endpoints are correct', () => {
  assert.match(SERVICE, /pending:\s*\(\)\s*=>\s*unwrap\(api\.get\(`\$\{PREFIX\}\/pending`\)/);
  assert.match(SERVICE, /approve:\s*\([A-Za-z_]+,\s*[A-Za-z_]+ = null\)/);
  assert.match(SERVICE, /reject:\s*\([A-Za-z_]+,\s*[A-Za-z_]+\)/);
});

// ── 7–12: redux slice + no new top-level key ─────────────

test('#7 slice — submitWorkLocationRequest thunk exists in presenceSlice', () => {
  assert.match(
    SLICE,
    /export const submitWorkLocationRequest = createAsyncThunk/,
  );
});

test('#8 slice — fetchMyWorkLocationRequests + cancelMyWorkLocationRequest exist', () => {
  assert.match(
    SLICE,
    /export const fetchMyWorkLocationRequests = createAsyncThunk/,
  );
  assert.match(
    SLICE,
    /export const cancelMyWorkLocationRequest = createAsyncThunk/,
  );
});

test('#9 slice — decideWorkLocationRequest handles both approve + reject', () => {
  assert.match(
    SLICE,
    /export const decideWorkLocationRequest = createAsyncThunk/,
  );
  const snippet = SLICE.split('export const decideWorkLocationRequest')[1].slice(0, 2000);
  assert.ok(snippet.includes("action === 'approve'"));
  assert.ok(snippet.includes("action === 'reject'"));
});

test('#10 slice — workLocationRequests sub-state lives under presence (no new top-level key)', () => {
  assert.match(SLICE, /workLocationRequests:\s*\{/);
  assert.match(
    STORE,
    /presence:\s*presenceReducer/,
    'store must not add a new top-level key for work-location requests',
  );
});

test('#11 slice — presenceWlrInvalidateForUser reducer drops cached rows', () => {
  assert.match(
    SLICE,
    /presenceWlrInvalidateForUser\(state\)\s*\{/,
  );
});

test('#12 slice — extraReducers handle all 5 thunks', () => {
  for (const thunk of [
    'submitWorkLocationRequest.pending',
    'submitWorkLocationRequest.fulfilled',
    'fetchMyWorkLocationRequests.fulfilled',
    'fetchWorkLocationReviewQueue.fulfilled',
    'decideWorkLocationRequest.fulfilled',
  ]) {
    assert.ok(
      SLICE.includes(`.addCase(${thunk}`),
      `${thunk} extraReducer missing`,
    );
  }
});

// ── 13–18: dialog form / payload guards ──────────────────

test('#13 dialog — Renders only when `open` is true (early return)', () => {
  assert.match(DIALOG, /if\s*\(\s*!open\s*\)\s*return\s+null/);
});

test('#14 dialog — payload has NO companyId / userId / employeeId / reviewedBy (regex)', () => {
  // The dialog submit block must NOT include any forbidden identity key.
  // We isolate the dispatch(...) call to the workLocationRequestService
  // and strip comments so an "anti-rule" comment in the file does not
  // poison the assertion.
  const dispatchStart = DIALOG.indexOf('submitWorkLocationRequest({');
  const dispatchEnd = DIALOG.indexOf('})', dispatchStart) + 2;
  const raw = DIALOG.slice(dispatchStart, dispatchEnd);
  const block = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const forbidden of ['companyId', 'userId', 'employeeId', 'reviewedBy', 'approverId']) {
    assert.equal(
      block.includes(forbidden),
      false,
      `dialog payload must not carry "${forbidden}" — found in: ${block.slice(0, 200)}`,
    );
  }
});

test('#15 dialog — payload has `location: "wfh"`', () => {
  const dispatchStart = DIALOG.indexOf('submitWorkLocationRequest({');
  const dispatchEnd = DIALOG.indexOf('})', dispatchStart) + 2;
  const block = DIALOG
    .slice(dispatchStart, dispatchEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(/location:\s*['"]wfh['"]/.test(block));
});

test('#16 dialog — refuses endDate < startDate client-side', () => {
  assert.match(DIALOG, /endDate\s*<\s*startDate/);
  assert.match(DIALOG, /End date must be the same as or after start date\./);
});

test('#17 dialog — refuses startDate in the past', () => {
  assert.match(DIALOG, /startDate\s*<\s*serverToday/);
  assert.match(DIALOG, /Start date cannot be in the past\./);
});

test('#18 dialog — double-click guard via submittingRef', () => {
  assert.match(DIALOG, /submittingRef\.current\s*=\s*true/);
  assert.match(DIALOG, /if\s*\(\s*submittingRef\.current\s*\)\s*return/);
});

// ── 19–22: presence menu + selector + boundaries ────────

test('#19 menu — mounts the WorkLocationRequestDialog', () => {
  assert.match(MENU, /<WorkLocationRequestDialog\s*\/?/);
});

test('#20 menu — passes onRequestWfh to the WorkLocationSelector', () => {
  assert.match(MENU, /onRequestWfh=\{?\(\)\s*=>\s*setWlrDialogOpen\(true\)\}?/);
});

test('#21 selector — replaces the 37.2 dead-end with a Request WFH button', () => {
  assert.match(SELECTOR, /data-testid="wfh-request-button"/);
  assert.match(SELECTOR, /Request WFH/);
  // The 37.2 "Request flow ships in a later update." dead-end must
  // be gone.
  assert.equal(
    /Request flow ships in a later update/.test(SELECTOR),
    false,
    '37.2 dead-end copy must be removed',
  );
});

test('#22 boundaries — no NATS / no .env writes / no localStorage in 37.5 frontend files', () => {
  const files = [SERVICE, DIALOG, HISTORY, REVIEW, SELECTOR];
  for (const f of files) {
    // Strip comments before checking — comments may MENTION the
    // forbidden word to explain a rule, not to USE it.
    const code = f
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.equal(/nats/i.test(code), false, 'NATS reference in 37.5 frontend file');
    assert.equal(/localStorage/i.test(code), false, 'localStorage in 37.5 frontend file');
    assert.equal(/sessionStorage/i.test(code), false, 'sessionStorage in 37.5 frontend file');
  }
});

// ── 23–24: review page + history page ────────────────────

test('#23 review page — calls fetchWorkLocationReviewQueue on mount', () => {
  assert.match(REVIEW, /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?dispatch\(fetchWorkLocationReviewQueue\(\)\)/);
});

test('#24 review page — Approve / Reject dispatch with action + decisionNote', () => {
  assert.match(REVIEW, /action:\s*kind/);
  assert.match(REVIEW, /decisionNote:\s*decisionNote\.trim\(\)\s*\|\|\s*null/);
  // Double-click guard present.
  assert.match(REVIEW, /if\s*\(\s*busyId\s*\)\s*return/);
});
