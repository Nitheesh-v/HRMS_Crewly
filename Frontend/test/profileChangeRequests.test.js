// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 38 — PROFILE CHANGE REQUESTS (frontend source pins)
//
//  The browser half of the workflow is wiring, and wiring is what silently
//  rots: a page keeps rendering while pointing at an endpoint that moved, or
//  an "editable" input quietly survives next to a field that now needs
//  approval. These pins read the real source files and fail when the shape
//  below stops being true.
//
//  Pinned guarantees:
//    1. profileService speaks to /profile/change-requests (and its six verbs);
//    2. bank details have NO direct-edit path left in MyProfilePage, and the
//       direct save payload does not carry them;
//    3. the reviewer page is guarded by the PROFILE_CHANGE_REVIEW permission,
//       not by a role name;
//    4. the sidebar entry exists only for a holder of that permission;
//    5. the queue page exists and is lazily loaded.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(frontendRoot, rel), 'utf8');

const PROFILE_PAGE = 'src/pages/profile/MyProfilePage.jsx';
const SERVICE = 'src/services/profileService.js';
const ROUTES = 'src/routes/AppRoutes.jsx';
const LAYOUT = 'src/layout/AppLayout.jsx';
const SIDEBAR = 'src/layout/SidebarNav.jsx';
const QUEUE_PAGE = 'src/pages/profile/ProfileChangeRequestsPage.jsx';

test('38 frontend: profileService wraps the change-request endpoints', () => {
  const src = read(SERVICE);

  assert.match(src, /submitChangeRequest:\s*\(payload\)\s*=>\s*api\.post\('\/profile\/change-requests',\s*payload\)/);
  assert.match(src, /myChangeRequests:\s*\(\)\s*=>\s*api\.get\('\/profile\/change-requests\/me'\)/);
  assert.match(src, /cancelChangeRequest:\s*\(id\)\s*=>\s*api\.post\(`\/profile\/change-requests\/\$\{id\}\/cancel`\)/);
  assert.match(src, /pendingChangeRequests:\s*\(\)\s*=>\s*api\.get\('\/profile\/change-requests\/pending'\)/);
  assert.match(src, /changeRequestHistory:/);
  assert.match(src, /decideChangeRequest:\s*\(id,\s*action,\s*decisionNote\s*=\s*''\)/);
});

test('38 frontend: bank details can no longer be edited directly', () => {
  const page = read(PROFILE_PAGE);

  // The dotted-path setter is the only writer in this page: it must never
  // target a field that requires approval.
  for (const field of ['bankAccount', 'ifsc', 'name', 'designation', 'employeeCode', 'dateOfJoining']) {
    assert.equal(
      page.includes(`setField('${field}'`),
      false,
      `${field} must travel through the approval workflow, not through setField()`,
    );
  }

  // The direct save payload carries the self-service fields only.
  const savePayload = page.slice(
    page.indexOf('const payload = {'),
    page.indexOf('const payload = {') + 400,
  );
  assert.ok(savePayload.includes('phone:'), 'the payload still saves phone');
  assert.equal(savePayload.includes('bankAccount'), false, 'bank changes are approved, not saved');
  assert.equal(savePayload.includes('ifsc'), false, 'IFSC changes are approved, not saved');

  // …and the request lane is wired for both payment fields.
  assert.match(page, /openRequest\('bankAccount'\)/);
  assert.match(page, /openRequest\('ifsc'\)/);
});

test('38 frontend: the reviewer route is guarded by the permission, not a role', () => {
  const routes = read(ROUTES);

  assert.match(routes, /path="profile\/change-requests"/);
  const start = routes.indexOf('path="profile/change-requests"');
  // Slice to the NEXT route, so the assertions below can only ever describe
  // this route's own guard.
  const nextRoute = routes.indexOf('path="', start + 10);
  const guard = routes.slice(start, nextRoute === -1 ? start + 400 : nextRoute);
  assert.match(guard, /RequirePermission/);
  assert.match(guard, /PROFILE_CHANGE_REVIEW/);
  assert.equal(/RequireRole/.test(guard), false, 'a role name would break custom reviewer roles');
  assert.match(read(ROUTES), /ProfileChangeRequestsPage/);
});

test('38 frontend: the queue page calls the reviewer endpoints', () => {
  const page = read(QUEUE_PAGE);

  assert.match(page, /profileService\.pendingChangeRequests\(\)/);
  assert.match(page, /profileService\.changeRequestHistory\('approved'\)/);
  assert.match(page, /profileService\.changeRequestHistory\('rejected'\)/);
  assert.match(page, /profileService\.decideChangeRequest\(/);
  // A rejection without a reason is blocked in the UI as well as the API.
  assert.match(page, /note\.trim\(\)\.length === 0/);
});

test('38 frontend: the sidebar entry appears only with PROFILE_CHANGE_REVIEW', () => {
  const layout = read(LAYOUT);
  const gate = layout.slice(
    layout.indexOf('const profileChangeMenu'),
    layout.indexOf('const profileChangeMenu') + 320,
  );

  assert.match(gate, /hasPermission\('PROFILE_CHANGE_REVIEW'\)/);
  assert.match(gate, /'\/app\/profile\/change-requests'/);
  assert.match(layout, /\.\.\.profileChangeMenu,/);

  // The path has an icon + a home in the nav groups, so it cannot render as
  // an orphaned item if the grouping changes.
  assert.match(read(SIDEBAR), /"\/app\/profile\/change-requests": ShieldCheck/);
});

test('38 frontend: no direct-write path to a bank field anywhere in src/', () => {
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(jsx?|ts|tsx)$/.test(entry.name)) continue;
      const rel = path.relative(frontendRoot, full).replace(/\\/g, '/');
      if (rel.startsWith('test/')) continue;
      const src = fs.readFileSync(full, 'utf8');
      // A PUT to the profile endpoint that carries a bank value directly.
      if (/updateMe\(/.test(src) && /bankAccount\s*:/.test(src)) {
        offenders.push(rel);
      }
    }
  };

  walk(path.join(frontendRoot, 'src'));
  assert.deepEqual(offenders, [], `these files still write bank details directly: ${offenders.join(', ')}`);
});
