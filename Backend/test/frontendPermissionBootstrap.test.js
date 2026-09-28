// ─────────────────────────────────────────────────────────────────────────────
// Phase 35.4 — THE PERMISSION PAYLOAD THE APP NEVER ASKED FOR.
//
// The report behind this unit: "227 permissions selected for admin, all are
// selected but not coming inside — and the pages are not opening."
//
// The Roles screen was telling the truth: the Company Admin role really does
// carry the whole permission matrix. The APP, however, was never asking what
// the signed-in person may do:
//
//   `fetchMyPermissions` bailed out with an EMPTY permission set whenever
//   `state.auth.token` was falsy — and since the 33.14 cookie migration a
//   CUSTOMER session has `token === null` BY DESIGN (the HttpOnly cookie is the
//   credential; AuthSlices/useAuth both document that a null token is what
//   stops api.js from attaching a header at all). So for every company user —
//   the Company Admin included — the request was never made, every gated page
//   answered "Your account cannot open this page yet", and the one screen
//   without a guard (Roles & Permissions) rendered the full matrix.
//
// These pins read the frontend sources (this suite owns the frontend pins, the
// same way frontendToastFoundation.test.js does) and tie the three files
// together so the token requirement cannot come back.
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const slice = read('Frontend/src/redux/slices/PermissionSlices.js');
const useAuth = read('Frontend/src/hooks/useAuth.jsx');
const authSlice = read('Frontend/src/redux/slices/AuthSlices.js');
const loginPage = read('Frontend/src/pages/login/LoginPage.jsx');
const api = read('Frontend/src/services/api.js');
const routes = read('Backend/src/routes/rolePermissionRoutes.js');

describe('35.4 · a customer session has no JS-visible token — the payload must still be fetched', () => {
  test('the thunk no longer skips the request when the token is absent', () => {
    assert.doesNotMatch(
      slice,
      /!user\s*\|\|\s*!token/,
      'a cookie session (token === null) must never short-circuit the permission load',
    );
    assert.match(
      slice,
      /const \{ user \} = getState\(\)\.auth;/,
      'the guard reads the user, not the token',
    );
    assert.match(
      slice,
      /if \(!user\) \{[\s\S]{0,120}loadedUserId: null/,
      'only a missing USER skips the call (signed-out state)',
    );
  });

  test('the dedupe condition is keyed on the user, not the token', () => {
    const condition = slice.slice(slice.indexOf('condition: (_, { getState })'));
    assert.doesNotMatch(
      condition.slice(0, 900),
      /\{[^}]*\btoken\b[^}]*\}\s*=\s*state\.auth/,
      'the condition must not read the token out of the auth slice',
    );
    assert.doesNotMatch(condition.slice(0, 900), /!token/);
    assert.match(condition.slice(0, 900), /permissions\.loadedUserId === userId && permissions\.loaded/);
  });

  test('the API call itself is unchanged and reaches the cookie-authenticated endpoint', () => {
    const service = read('Frontend/src/services/permissionService.js');
    assert.match(service, /myPermissions:\s*\(\)\s*=>\s*api\s*\n?\s*\.get\('\/permissions\/me'\)/);
    assert.match(api, /withCredentials: true/, 'the cookie is what authenticates a customer call');
  });

  test('the endpoint that answers it needs no permission of its own (no deadlock)', () => {
    const route = routes.slice(routes.indexOf("'/permissions/me'"));
    const block = route.slice(0, route.indexOf(');') + 2);
    assert.match(block, /\.\.\.secured/, 'protect + tenantContext');
    assert.doesNotMatch(block, /requirePermission/, 'a person with 0 loaded permissions must still be able to load theirs');
  });
});

describe('35.4 · the platform portal keeps its own contract', () => {
  test('platform roles still short-circuit to provider RBAC', () => {
    assert.match(slice, /PLATFORM_ROLES = \[/);
    assert.match(slice, /if \(PLATFORM_ROLES\.includes\(user\.role\)\) \{[\s\S]{0,200}emptyPermissionData/);
  });

  test('a failed load still fails CLOSED (empty set + error, never an open door)', () => {
    assert.match(
      slice,
      /addCase\(fetchMyPermissions\.rejected[\s\S]{0,400}state\.permissions = \[\];[\s\S]{0,200}state\.error =/,
    );
  });

  test('the state keys the rest of the app reads are untouched', () => {
    ['role', 'permissions', 'deniedPermissions', 'loaded', 'loading', 'loadedUserId', 'error'].forEach(
      (key) => assert.match(slice, new RegExp(`state\\.${key}\\b`), `${key} stays part of the slice`),
    );
    assert.match(slice, /export const \{ clearPermissions, invalidatePermissions \} =/);
    assert.match(slice, /clearPermissions[\s\S]{0,200}state\.loadedUserId = null;/);
  });
});

describe('35.4 · why the token gate was wrong (the contract it contradicted)', () => {
  test('a customer login stores the user only — no token is ever sent', () => {
    assert.match(loginPage, /const data = await authService\.login\(form\);/);
    assert.match(loginPage, /login\(data\.user\);/);
    assert.doesNotMatch(loginPage, /login\(\s*data\.user\s*,\s*data\.accessToken/);
  });

  test('useAuth documents that token is platform-only and ignores it for auth', () => {
    assert.match(useAuth, /is only ever set for the PLATFORM portal/);
    assert.match(useAuth, /isAuthenticated:\s*\n?\s*Boolean\(user\)/);
  });

  test('the auth slice keeps a customer token null on purpose', () => {
    assert.match(
      authSlice.replace(/\s*\n\s*\*?\s*/g, ' '),
      /a null token is what keeps api\.js from attaching a header at all/,
    );
    assert.match(authSlice, /user && isPlatformSession\(user\)[\s\S]{0,120}: null,/);
  });

  test('api.js attaches Authorization only for a platform session', () => {
    assert.match(api, /infolexus_platform_token/);
    assert.match(api, /A customer request never[\s\S]{0,200}sends one/);
  });
});
