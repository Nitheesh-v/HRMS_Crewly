// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.7 — FRONTEND CLOSEOUT TESTS
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

const PAGE = read('src/pages/settings/presence/PresenceSettingsPage.jsx');
const ROUTES = read('src/routes/AppRoutes.jsx');
const NAV = read('src/layout/SidebarNav.jsx');
const LAYOUT = read('src/layout/AppLayout.jsx');
const SLICE = read('src/redux/slices/presenceSlice.js');
const SERVICE = read('src/services/presenceService.js');

test('settings #1 — admin page file exists and is discoverable', () => {
  const exists = fs.existsSync(
    path.join(ROOT, 'src/pages/settings/presence/PresenceSettingsPage.jsx'),
  );
  assert.equal(exists, true);
});

test('settings #2 — admin route is registered with COMPANY_ADMIN guard', () => {
  const r = stripComments(ROUTES);
  assert.match(r, /settings\/presence/);
  // Find the second occurrence (the route definition, not the import).
  const first = r.indexOf('settings/presence');
  const second = r.indexOf('settings/presence', first + 1);
  const idx = second > 0 ? second : first;
  const block = r.slice(idx, idx + 600);
  assert.match(block, /RequireRole/);
  assert.match(block, /roles=\{COMPANY_ADMIN\}/);
});

test('settings #3 — admin page is registered in the COMPANY_ADMIN menu', () => {
  const l = stripComments(LAYOUT);
  assert.match(l, /settings\/presence/);
  assert.match(l, /Presence Settings/);
});

test('settings #4 — admin page is in the sidebar "Administration" group', () => {
  const n = stripComments(NAV);
  const idx = n.indexOf('"Administration"');
  assert.ok(idx > 0, 'Administration group must exist');
  const group = n.slice(idx, idx + 800);
  assert.match(group, /settings\/presence/);
});

test('settings #5 — admin page never sends companyId / userId / employeeId', () => {
  const p = stripComments(PAGE);
  for (const forbidden of ['companyId', 'userId', 'employeeId', 'tenantId']) {
    const re = new RegExp(`(body|formData|JSON\\.stringify|patch|update).*\\b${forbidden}\\b`, 'i');
    assert.equal(re.test(p), false, `page must not put ${forbidden} in body`);
  }
});

test('settings #6 — admin page never writes localStorage / sessionStorage', () => {
  const p = stripComments(PAGE);
  assert.equal(/localStorage\s*\.\s*setItem/.test(p), false);
  assert.equal(/sessionStorage\s*\.\s*setItem/.test(p), false);
});

test('settings #7 — admin page does not show fake NATS controls', () => {
  const p = stripComments(PAGE);
  assert.doesNotMatch(p, /NATS/i);
  assert.doesNotMatch(p, /nats[-_]?url/i);
  assert.doesNotMatch(p, /VITE_NATS_URL/i);
});

test('settings #8 — admin page does not show fake Redis controls', () => {
  const p = stripComments(PAGE);
  assert.doesNotMatch(p, /REDIS_URL/i);
  assert.doesNotMatch(p, /redis[-_]?host/i);
  assert.doesNotMatch(p, /VITE_REDIS_URL/i);
});

test('settings #9 — presenceService exposes getTenantConfig and updateTenantConfig', () => {
  const s = stripComments(SERVICE);
  assert.match(s, /getTenantConfig\s*=\s*\(/);
  assert.match(s, /updateTenantConfig\s*=\s*\(/);
});

test('settings #10 — redux slice registers loadPresenceConfig and savePresenceConfig', () => {
  const s = stripComments(SLICE);
  assert.match(s, /loadPresenceConfig/);
  assert.match(s, /savePresenceConfig/);
});

test('settings #11 — redux slice config sub-state shape', () => {
  const s = stripComments(SLICE);
  const matches = [...s.matchAll(/config:\s*\{/g)];
  const lastConfig = matches[matches.length - 1];
  const idx = lastConfig.index;
  const block = s.slice(idx, idx + 500);
  assert.match(block, /data/);
  assert.match(block, /loading/);
  assert.match(block, /saving/);
  assert.match(block, /error/);
});

test('settings #12 — redux slice handles all 3 lifecycle states for load + save', () => {
  const s = stripComments(SLICE);
  for (const verb of ['loadPresenceConfig', 'savePresenceConfig']) {
    for (const phase of ['pending', 'fulfilled', 'rejected']) {
      assert.match(
        s,
        new RegExp(`addCase\\(${verb}\\.${phase}`),
        `${verb}.${phase} must have an extraReducer`,
      );
    }
  }
});

test('settings #13 — page prevents last allowed location from being unchecked', () => {
  const p = stripComments(PAGE);
  assert.match(p, /wouldBeLast/);
  assert.match(p, /checked\s*&&\s*wouldBeLast/);
});

test('settings #14 — page has client-side invariant for Offline > Away', () => {
  const p = stripComments(PAGE);
  assert.match(p, /offlineAfterMinutes\s*<=\s*draft\.awayAfterMinutes/);
  assert.match(p, /validationError/);
});

test('settings #15 — page has client-side guard for empty allowed list when WL is enabled', () => {
  const p = stripComments(PAGE);
  assert.match(p, /workLocationEnabled\s*&&/);
  assert.match(p, /length\s*===\s*0/);
});

test('settings #16 — page has client-side WFH=disabled vs allowed=WFH guard', () => {
  const p = stripComments(PAGE);
  assert.match(p, /wfhMode\s*===\s*['"]disabled['"]/);
});

test('settings #17 — page has a sticky bottom Save bar (not top)', () => {
  const p = stripComments(PAGE);
  assert.match(p, /sticky\s+bottom-0/);
  assert.doesNotMatch(p, /sticky\s+top-0/);
});

test('settings #18 — page sends ONLY the per-field diff (Phase 36 §4.4 pay-for)', () => {
  const p = stripComments(PAGE);
  assert.match(p, /updateTenantConfig\(dirtyMap\)/);
});

test('settings #19 — page has a discard action that resets draft to snapshot', () => {
  const p = stripComments(PAGE);
  assert.match(p, /onDiscard/);
  assert.match(p, /setDraft\(\{\s*\.\.\.FORM_DEFAULTS,\s*\.\.\.snapshot\s*\}\)/);
});

test('settings #20 — page does NOT use useBlocker (BrowserRouter incompatibility)', () => {
  const p = stripComments(PAGE);
  assert.doesNotMatch(p, /useBlocker/);
  assert.match(p, /beforeunload/);
});

test('settings #21 — page has the deterministic loading-then-finally path', () => {
  const p = stripComments(PAGE);
  assert.match(p, /try\s*{[^}]*await\s+read\(/s);
  assert.match(p, /finally\s*{\s*setLoading\(false\)/);
});

test('settings #22 — page renders an error state on a failed load (not permissive defaults)', () => {
  const p = stripComments(PAGE);
  assert.match(p, /error\s*&&\s*!snapshot/);
  assert.match(p, /Retry/);
});

test('settings #23 — page mirrors the saved snapshot to redux (so other surfaces see it)', () => {
  const p = stripComments(PAGE);
  assert.match(p, /dispatch\(loadPresenceConfig\(\)\)/);
});

test('settings #24 — page does not include emoji in the new UI strings', () => {
  const p = PAGE;
  for (const label of [
    'Presence settings',
    'Save changes',
    'Discard',
    'Away after (minutes)',
    'Offline after (minutes)',
  ]) {
    assert.ok(p.includes(label), `page must contain label "${label}"`);
  }
});

test('settings #25 — package.json does not include NATS', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.assign(
    {},
    pkg.dependencies || {},
    pkg.devDependencies || {},
  );
  for (const name of Object.keys(deps)) {
    assert.equal(/^nats/i.test(name), false, `no NATS dep: ${name}`);
  }
  assert.ok(
    Object.prototype.hasOwnProperty.call(deps, 'socket.io-client'),
    'socket.io-client (legacy) still in deps',
  );
});
