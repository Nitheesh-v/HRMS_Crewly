// ─────────────────────────────────────────────────────────────────────────────
// Phase 35.4 — BEHAVIOURAL PIN for the permission payload.
//
// Companion to frontendPermissionBootstrap.test.js (source pins, part of
// `test:all`). This file RUNS the real Redux slice and thunk from the frontend
// in Node — the frontend service module is mocked, the store is the real
// Redux Toolkit store — and proves the behaviour the report was really about:
//
//   a CUSTOMER session (HttpOnly cookie, `state.auth.token === null`) must
//   still fetch its permission payload and put it in the state every screen
//   reads; a signed-out user or a platform account must not.
//
// It needs `--experimental-test-module-mocks`, so it runs from its own script
// (`npm run test:permission-bootstrap`) instead of `test:all`.
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let nextResult = null;
let nextError = null;

mock.module('../../Frontend/src/services/permissionService.js', {
  defaultExport: {
    myPermissions: async () => {
      calls.push('myPermissions');
      if (nextError) throw nextError;
      return nextResult;
    },
  },
});

const slice = await import('../../Frontend/src/redux/slices/PermissionSlices.js');

// @reduxjs/toolkit lives in the frontend's node_modules — this pin exercises
// the frontend build, so it is imported from there on purpose.
const { configureStore } = await import(
  '../../Frontend/node_modules/@reduxjs/toolkit/dist/redux-toolkit.modern.mjs'
);

const makeStore = ({ user, token = null }) =>
  configureStore({
    reducer: {
      permissions: slice.default,
      auth: (state = { user, token }) => state,
    },
    preloadedState: { auth: { user, token } },
  });

const run = (state) => slice.fetchMyPermissions()((action) => action, () => state, undefined);

const customerState = () => ({
  auth: { user: { id: 'user-1', role: 'COMPANY_ADMIN' }, token: null },
  permissions: { loaded: false, loading: false, loadedUserId: null },
});

beforeEach(() => {
  calls.length = 0;
  nextError = null;
  nextResult = {
    role: { code: 'COMPANY_ADMIN', name: 'Company Admin' },
    permissions: ['EMPLOYEE_READ', 'SETTINGS_MANAGE'],
    deniedPermissions: [],
  };
});

describe('35.4 · the permission request is made for a cookie session', () => {
  test('token === null still fetches — the bug this unit fixes', async () => {
    const action = await run(customerState());

    assert.equal(action.type, 'permissions/fetchMine/fulfilled');
    assert.deepEqual(action.payload.permissions, ['EMPLOYEE_READ', 'SETTINGS_MANAGE']);
    assert.equal(action.payload.role.code, 'COMPANY_ADMIN');
    assert.equal(calls.length, 1, 'the API must actually be called');
    assert.equal(action.payload.loadedUserId, 'user-1');
  });

  test('a signed-out user makes no request and grants nothing', async () => {
    const action = await run({ auth: { user: null, token: null }, permissions: {} });

    assert.equal(action.payload.permissions.length, 0);
    assert.equal(action.payload.loadedUserId, null);
    assert.equal(calls.length, 0);
  });

  test('a platform account keeps its own RBAC (no tenant permission call)', async () => {
    const action = await run({
      auth: { user: { id: 'sa-1', role: 'SUPER_ADMIN' }, token: 'platform-bearer' },
      permissions: {},
    });

    assert.equal(action.payload.permissions.length, 0);
    assert.equal(action.payload.loadedUserId, 'sa-1');
    assert.equal(calls.length, 0);
  });

  test('a failed load rejects with the reason and grants nothing (fail closed)', async () => {
    nextError = Object.assign(new Error('boom'), {
      response: { data: { message: 'Session expired' } },
    });

    const action = await run(customerState());

    assert.equal(action.type, 'permissions/fetchMine/rejected');
    assert.equal(action.payload, 'Session expired');
    assert.equal(calls.length, 1);
  });
});

describe('35.4 · through a real store, a cookie session ends up with its permissions', () => {
  test('dispatch fills the state every screen reads', async () => {
    const store = makeStore({ user: { id: 'user-1', role: 'COMPANY_ADMIN' }, token: null });

    await store.dispatch(slice.fetchMyPermissions());

    const state = store.getState().permissions;
    assert.deepEqual(state.permissions, ['EMPLOYEE_READ', 'SETTINGS_MANAGE']);
    assert.deepEqual(state.deniedPermissions, []);
    assert.equal(state.role.code, 'COMPANY_ADMIN');
    assert.equal(state.loaded, true);
    assert.equal(state.loading, false);
    assert.equal(state.loadedUserId, 'user-1');
    assert.equal(state.error, '');
  });

  test('the same user is not fetched twice (the condition is user-keyed)', async () => {
    const store = makeStore({ user: { id: 'user-1', role: 'COMPANY_ADMIN' }, token: null });

    await store.dispatch(slice.fetchMyPermissions());
    await store.dispatch(slice.fetchMyPermissions());

    assert.equal(calls.length, 1, 'a repeated dispatch must not re-hit the API');
  });

  test('invalidatePermissions allows exactly one more refresh', async () => {
    const store = makeStore({ user: { id: 'user-1', role: 'COMPANY_ADMIN' }, token: null });

    await store.dispatch(slice.fetchMyPermissions());
    store.dispatch(slice.invalidatePermissions());
    await store.dispatch(slice.fetchMyPermissions());

    assert.equal(calls.length, 2);
  });

  test('a failed refresh keeps the door shut in the state the guard reads', async () => {
    const store = makeStore({ user: { id: 'user-1', role: 'COMPANY_ADMIN' }, token: null });
    nextError = new Error('network down');

    await store.dispatch(slice.fetchMyPermissions());

    const state = store.getState().permissions;
    assert.deepEqual(state.permissions, []);
    assert.equal(state.loaded, true);
    assert.equal(state.loading, false);
    assert.equal(state.error, 'network down', 'the 35.2 guard needs this to say "could not check"');
  });
});
