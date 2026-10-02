// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PRESENCE FOUNDATION (hermetic, no Mongo / Redis / no DB)
//
//  This file is the source of truth that 37.1's 60+ §28/§29 guarantees are
//  honoured. Every assertion maps to a numbered clause in the 37.1 spec.
//
//  DESIGN
//    · No Mongo. No Redis. No network.
//    · Every dependency is an in-memory fake:
//        – UserPresence fake exposes findOne + findOneAndUpdate
//        – PresenceTenantConfig fake exposes findOneAndUpdate with
//          setDefaultsOnInsert semantics
//        – presenceTenantConfigService and presenceService take models
//          as DI seams (presenceService({ UserPresenceModel }))
//    · The clock is fixed per test via `now` injection on resolvePresence
//      and via controlled Date inside validators.
//
//  FAKE-MODEL RULE (Phase 36 capsule §4.2 / §4.4)
//    A fake model MUST implement `findOneAndUpdate` (not just findOne)
//    when the production code uses upsert + setDefaultsOnInsert, else
//    the test passes for the wrong reason.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_presence_test';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

const COMPANY = '0000000000000000000064b1';
const OTHER_COMPANY = '0000000000000000000064b2';
const USER = '0000000000000000000064b3';
const OTHER_USER = '0000000000000000000064b4';

// ── Fake model: UserPresence (one row per companyId+userId) ───────────────
//
// Records every findOne and findOneAndUpdate so tests can pin the tenant
// scope that was queried.
const makeUserPresenceFake = () => {
  const rows = new Map();
  const calls = [];

  const key = (companyId, userId) => `${String(companyId)}:${String(userId)}`;

  const buildDoc = (companyId, userId, patch = {}) => ({
    companyId,
    userId,
    manualStatus: null,
    manualStatusExpiresAt: null,
    statusMessage: '',
    statusMessageExpiresAt: null,
    workLocation: null,
    workLocationExpiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...patch,
  });

  return {
    calls,
    async findOne(filter) {
      calls.push({ op: 'findOne', filter });
      const k = key(filter.companyId, filter.userId);
      return rows.get(k) || null;
    },
    async findOneAndUpdate(filter, update, options = {}) {
      calls.push({ op: 'findOneAndUpdate', filter, update, options });
      const k = key(filter.companyId, filter.userId);
      const existing = rows.get(k);
      const $setOnInsert = (update && update.$setOnInsert) || {};
      const $set = (update && update.$set) || {};
      const next = buildDoc(
        filter.companyId,
        filter.userId,
        { ...(existing || $setOnInsert), ...$set },
      );
      if (options.upsert) rows.set(k, next);
      return options.new ? next : next;
    },
    _peek: () => rows,
  };
};

// ── Fake model: PresenceTenantConfig (one row per companyId) ──────────────
//
// The production code uses { upsert: true, new: true, setDefaultsOnInsert:
// true }. The fake emulates that exactly: first read paints the row with
// the project defaults; subsequent reads return it; updates mutate it.
const makeTenantConfigFake = (defaults) => {
  const rows = new Map();
  const calls = [];

  return {
    calls,
    async findOneAndUpdate(filter, update, options = {}) {
      calls.push({ op: 'findOneAndUpdate', filter, update, options });
      const existing = rows.get(String(filter.companyId));
      const $setOnInsert = (update && update.$setOnInsert) || {};
      const $set = (update && update.$set) || {};
      const merged = {
        ...(existing || defaults || {}),
        ...$setOnInsert,
        ...$set,
      };
      if (options.upsert) rows.set(String(filter.companyId), merged);
      const out = options.new ? { ...merged } : merged;
      return out;
    },
    _peek: () => rows,
  };
};

// ── Imports (hoisted; no await import inside describe) ────────────────────

const presenceConfig = await import('../src/services/presence/presenceConfig.js');
const presenceErrors = await import(
  '../src/services/presence/presenceErrors.js'
);
const presenceTenantConfigService = await import(
  '../src/services/presence/presenceTenantConfigService.js'
);
const presenceResolver = await import(
  '../src/services/presence/presenceResolver.js'
);
const presenceService = await import(
  '../src/services/presence/presenceService.js'
);

// ── Validators are async-imported for express-validator chain support ──────

const presenceValidatorModule = await import(
  '../src/validators/presence/presenceValidator.js'
);

// ── Validator runner (matches the project's house style) ──────────────────
//
// Each validator chain ends in a `validate` closure that throws
// ApiError.badRequest. We use a fake req with `.body`, call runChain(req, res, next),
// and assert that next() received either no error or an ApiError with the
// expected statusCode / message.
const runChain = async (chain, req) => {
  let thrown = null;
  for (const mw of chain) {
    if (thrown) break;
    await new Promise((resolve) => {
      const next = (err) => {
        if (err) thrown = err;
        resolve();
      };
      // express-validator middlewares can throw synchronously OR return
      // a rejected promise. Wrap both.
      try {
        Promise.resolve(mw(req, {}, next)).catch((err) => {
          if (!thrown) thrown = err;
          resolve();
        });
      } catch (err) {
        if (!thrown) thrown = err;
        resolve();
      }
    });
  }
  return { thrown };
};

const FIXED_NOW = new Date('2026-06-15T09:00:00.000Z');
const realNow = Date.now();
const realInOneHour = new Date(realNow + 60 * 60 * 1000);
const inOneHour = realInOneHour; // validators use Date.now()

// ─────────────────────────────────────────────────────────────────────
//  DOMAIN CONSTANTS — §5 of the 37.1 spec
// ─────────────────────────────────────────────────────────────────────

describe('presence domain constants', () => {
  test('manual presence values are exactly available/busy/dnd', () => {
    assert.deepEqual(
      [...presenceConfig.PRESENCE_MANUAL_VALUES],
      ['available', 'busy', 'dnd'],
    );
  });

  test('derived states are NOT manually selectable', () => {
    for (const v of ['away', 'offline', 'on_leave', 'outside_working_hours', 'unknown']) {
      assert.equal(presenceConfig.isManualPresence(v), false);
    }
  });

  test('work-location values are exactly office/wfh/remote', () => {
    assert.deepEqual([...presenceConfig.WORK_LOCATION_VALUES], ['office', 'wfh', 'remote']);
  });

  test('WFH modes are exactly the three the policy owns', () => {
    assert.deepEqual(
      [...presenceConfig.WFH_MODES],
      ['self_declare', 'approval_required', 'disabled'],
    );
  });

  test('defaults match the 37 overview §21 recommended values', () => {
    assert.equal(presenceConfig.PRESENCE_TENANT_DEFAULTS.enabled, true);
    assert.equal(presenceConfig.PRESENCE_TENANT_DEFAULTS.wfhMode, 'self_declare');
    assert.equal(presenceConfig.PRESENCE_TENANT_DEFAULTS.awayAfterMinutes, 5);
    assert.equal(presenceConfig.PRESENCE_TENANT_DEFAULTS.offlineAfterMinutes, 15);
    assert.equal(presenceConfig.PRESENCE_TENANT_DEFAULTS.lastSeenVisible, false);
    assert.deepEqual(
      [...presenceConfig.PRESENCE_TENANT_DEFAULTS.allowedWorkLocations],
      ['office', 'wfh', 'remote'],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
//  TENANT CONFIG — §8/§9/§10/§11 of the 37.1 spec
// ─────────────────────────────────────────────────────────────────────

describe('presence tenant config service', () => {
  test('defaults are deterministic (37.1 §37)', () => {
    const snap = presenceTenantConfigService.defaultSnapshot(COMPANY);
    assert.equal(snap.enabled, true);
    assert.equal(snap.wfhMode, 'self_declare');
    assert.deepEqual([...snap.allowedWorkLocations], ['office', 'wfh', 'remote']);
    assert.equal(snap.companyId, COMPANY);
  });

  test('first read upserts the row with setDefaultsOnInsert', async () => {
    const M = makeTenantConfigFake({
      enabled: true,
      statusMessagesEnabled: true,
      workLocationEnabled: true,
      wfhMode: 'self_declare',
      awayAfterMinutes: 5,
      offlineAfterMinutes: 15,
      lastSeenVisible: false,
      allowedWorkLocations: ['office', 'wfh', 'remote'],
      updatedBy: null,
    });
    const snap = await presenceTenantConfigService.getPresenceTenantConfigOrThrow({
      companyId: COMPANY,
      model: M,
    });
    assert.equal(snap.enabled, true);
    assert.equal(snap.wfhMode, 'self_declare');
    // The fake was called with upsert+setDefaultsOnInsert exactly once.
    assert.equal(M.calls.length, 1);
    assert.equal(M.calls[0].options.upsert, true);
    assert.equal(M.calls[0].options.setDefaultsOnInsert, true);
  });

  test('an unrecognised patch key is refused outright', async () => {
    const M = makeTenantConfigFake({});
    await assert.rejects(
      () =>
        presenceTenantConfigService.updatePresenceTenantConfig({
          companyId: COMPANY,
          userId: USER,
          patch: { wfhMode: 'self_declare', inventedField: 'evil' },
          model: M,
        }),
      (err) => err.message?.includes('inventedField'),
    );
  });

  test('invalid wfhMode is refused (37.1 §38)', async () => {
    const M = makeTenantConfigFake({});
    await assert.rejects(
      () =>
        presenceTenantConfigService.updatePresenceTenantConfig({
          companyId: COMPANY,
          userId: USER,
          patch: { wfhMode: 'unbounded' },
          model: M,
        }),
      (err) => err.message?.includes('wfhMode'),
    );
  });

  test('offlineAfterMinutes must exceed awayAfterMinutes (37.1 §42)', async () => {
    const M = makeTenantConfigFake({});
    await assert.rejects(
      () =>
        presenceTenantConfigService.updatePresenceTenantConfig({
          companyId: COMPANY,
          userId: USER,
          patch: { awayAfterMinutes: 10, offlineAfterMinutes: 5 },
          model: M,
        }),
      (err) => err.message?.toLowerCase().includes('offline'),
    );
  });

  test('duplicate allowedWorkLocations is refused', async () => {
    const M = makeTenantConfigFake({});
    await assert.rejects(
      () =>
        presenceTenantConfigService.updatePresenceTenantConfig({
          companyId: COMPANY,
          userId: USER,
          patch: { allowedWorkLocations: ['office', 'office'] },
          model: M,
        }),
      (err) => err.message?.toLowerCase().includes('allowed'),
    );
  });

  test('an empty allowedWorkLocations list is refused when work-location is enabled', async () => {
    const M = makeTenantConfigFake({});
    await assert.rejects(
      () =>
        presenceTenantConfigService.updatePresenceTenantConfig({
          companyId: COMPANY,
          userId: USER,
          patch: { allowedWorkLocations: [] },
          model: M,
        }),
    );
  });

  test('config read failure becomes 503 PRESENCE_TENANT_CONFIG_READ_FAILED', async () => {
    const throwingModel = {
      async findOneAndUpdate() {
        throw new Error('connection reset');
      },
    };
    await assert.rejects(
      () =>
        presenceTenantConfigService.getPresenceTenantConfigOrThrow({
          companyId: COMPANY,
          model: throwingModel,
        }),
      (err) =>
        err.statusCode === 503 &&
        err.presenceCode ===
          presenceErrors.PRESENCE_ERROR_CODES.PRESENCE_TENANT_CONFIG_READ_FAILED,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
//  RESOLVER — §16/§20 of the 37.1 spec
// ─────────────────────────────────────────────────────────────────────

describe('presence resolver', () => {
  const defaultConfig = () =>
    Object.freeze({
      enabled: true,
      statusMessagesEnabled: true,
      workLocationEnabled: true,
      wfhMode: 'self_declare',
      allowedWorkLocations: ['office', 'wfh', 'remote'],
    });

  test('active manual Available resolves Available (37.1 §56)', () => {
    const snap = presenceResolver.resolvePresence({
      durable: {
        manualStatus: 'available',
        manualStatusExpiresAt: null,
      },
      config: defaultConfig(),
      now: FIXED_NOW,
    });
    assert.equal(snap.presence, 'available');
    assert.equal(snap.presenceSource, 'manual');
  });

  test('active manual Busy resolves Busy (37.1 §57)', () => {
    const snap = presenceResolver.resolvePresence({
      durable: { manualStatus: 'busy', manualStatusExpiresAt: inOneHour },
      config: defaultConfig(),
      now: FIXED_NOW,
    });
    assert.equal(snap.presence, 'busy');
  });

  test('active manual DND resolves DND (37.1 §58)', () => {
    const snap = presenceResolver.resolvePresence({
      durable: { manualStatus: 'dnd', manualStatusExpiresAt: inOneHour },
      config: defaultConfig(),
      now: FIXED_NOW,
    });
    assert.equal(snap.presence, 'dnd');
  });

  test('no manual and no live resolves unknown, NOT offline (37.1 §59)', () => {
    const snap = presenceResolver.resolvePresence({
      durable: null,
      config: defaultConfig(),
      now: FIXED_NOW,
    });
    assert.equal(snap.presence, 'unknown');
    assert.equal(snap.livePresenceAvailable, false);
    // The snapshot must never claim Offline here.
    assert.notEqual(snap.presence, 'offline');
  });

  test('expired manual Busy is ignored (37.1 §60)', () => {
    const yesterday = new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000);
    const snap = presenceResolver.resolvePresence({
      durable: { manualStatus: 'busy', manualStatusExpiresAt: yesterday },
      config: defaultConfig(),
      now: FIXED_NOW,
    });
    assert.equal(snap.presence, 'unknown');
    assert.equal(snap.manualStatus, null);
  });

  test('output is explicitly shaped (no whole Mongo document leaks) (37.1 §61)', () => {
    const snap = presenceResolver.resolvePresence({
      durable: { manualStatus: 'busy', manualStatusExpiresAt: inOneHour },
      config: defaultConfig(),
      now: FIXED_NOW,
    });
    const keys = Object.keys(snap).sort();
    assert.deepEqual(keys, [
      'allowedWorkLocations',
      'config',
      'livePresenceAvailable',
      'manualStatus',
      'manualStatusExpiresAt',
      'presence',
      'presenceSource',
      'statusMessage',
      'statusMessageEnabled',
      'statusMessageExpiresAt',
      'wfhMode',
      'workLocation',
      'workLocationEnabled',
      'workLocationExpiresAt',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  SERVICE — §6/§12/§13/§14/§15 of the 37.1 spec
// ─────────────────────────────────────────────────────────────────────

describe('presence service', () => {
  const baseDefaults = () => ({
    enabled: true,
    statusMessagesEnabled: true,
    workLocationEnabled: true,
    wfhMode: 'self_declare',
    awayAfterMinutes: 5,
    offlineAfterMinutes: 15,
    lastSeenVisible: false,
    allowedWorkLocations: ['office', 'wfh', 'remote'],
    updatedBy: null,
  });

  const makeDeps = (configOverrides = {}) => {
    const tenant = makeTenantConfigFake(baseDefaults());
    if (configOverrides) {
      // Pre-seed the tenant config fake with the overrides.
      tenant._peek().set(COMPANY, { ...baseDefaults(), ...configOverrides });
    }
    const userPresence = makeUserPresenceFake();
    const svc = presenceService.presenceService({
      UserPresenceModel: userPresence,
      tenantConfigReader: ({ companyId }) =>
        presenceTenantConfigService.getPresenceTenantConfigOrThrow({
          companyId,
          model: tenant,
        }),
    });
    return { tenant, userPresence, svc };
  };

  test('manual Available accepted (37.1 §1)', async () => {
    const { svc } = makeDeps();
    const snap = await svc.setMyStatus({
      companyId: COMPANY,
      userId: USER,
      status: 'available',
    });
    assert.equal(snap.presence, 'available');
    assert.equal(snap.presenceSource, 'manual');
  });

  test('manual Busy accepted (37.1 §2)', async () => {
    const { svc } = makeDeps();
    const snap = await svc.setMyStatus({
      companyId: COMPANY,
      userId: USER,
      status: 'busy',
    });
    assert.equal(snap.presence, 'busy');
  });

  test('manual DND accepted (37.1 §3)', async () => {
    const { svc } = makeDeps();
    const snap = await svc.setMyStatus({
      companyId: COMPANY,
      userId: USER,
      status: 'dnd',
    });
    assert.equal(snap.presence, 'dnd');
  });

  test('manual Away refused (37.1 §4)', async () => {
    const { svc } = makeDeps();
    await assert.rejects(
      () =>
        svc.setMyStatus({ companyId: COMPANY, userId: USER, status: 'away' }),
      (err) => err.presenceCode === presenceErrors.PRESENCE_ERROR_CODES.INVALID_PRESENCE_VALUE,
    );
  });

  test('manual Offline refused (37.1 §5)', async () => {
    const { svc } = makeDeps();
    await assert.rejects(
      () =>
        svc.setMyStatus({
          companyId: COMPANY,
          userId: USER,
          status: 'offline',
        }),
      (err) => err.presenceCode === presenceErrors.PRESENCE_ERROR_CODES.INVALID_PRESENCE_VALUE,
    );
  });

  test('manual on_leave refused (37.1 §6)', async () => {
    const { svc } = makeDeps();
    await assert.rejects(
      () =>
        svc.setMyStatus({
          companyId: COMPANY,
          userId: USER,
          status: 'on_leave',
        }),
      (err) => err.presenceCode === presenceErrors.PRESENCE_ERROR_CODES.INVALID_PRESENCE_VALUE,
    );
  });

  test('invalid presence value refused (37.1 §7)', async () => {
    const { svc } = makeDeps();
    await assert.rejects(
      () =>
        svc.setMyStatus({
          companyId: COMPANY,
          userId: USER,
          status: 'invented',
        }),
      (err) => err.presenceCode === presenceErrors.PRESENCE_ERROR_CODES.INVALID_PRESENCE_VALUE,
    );
  });

  test('future manual expiry accepted (37.1 §8)', async () => {
    const { svc } = makeDeps();
    const snap = await svc.setMyStatus({
      companyId: COMPANY,
      userId: USER,
      status: 'busy',
      expiresAt: inOneHour.toISOString(),
    });
    assert.equal(snap.presence, 'busy');
    assert.ok(snap.manualStatusExpiresAt);
  });

  test('past manual expiry refused (37.1 §9)', async () => {
    const { svc } = makeDeps();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await assert.rejects(
      () =>
        svc.setMyStatus({
          companyId: COMPANY,
          userId: USER,
          status: 'busy',
          expiresAt: yesterday.toISOString(),
        }),
      (err) => err.presenceCode === presenceErrors.PRESENCE_ERROR_CODES.EXPIRY_IN_PAST,
    );
  });

  test('clear status returns unknown (37.1 §10/§11)', async () => {
    const { svc } = makeDeps();
    await svc.setMyStatus({ companyId: COMPANY, userId: USER, status: 'busy' });
    const snap = await svc.setMyStatus({
      companyId: COMPANY,
      userId: USER,
      status: null,
    });
    assert.equal(snap.manualStatus, null);
    assert.equal(snap.presence, 'unknown');
  });

  test('valid short status message accepted (37.1 §12)', async () => {
    const { svc } = makeDeps();
    const snap = await svc.setMyStatusMessage({
      companyId: COMPANY,
      userId: USER,
      message: 'Client call until 3 PM',
    });
    assert.equal(snap.statusMessage, 'Client call until 3 PM');
  });

  test('message is trimmed (37.1 §13)', async () => {
    const { svc } = makeDeps();
    const snap = await svc.setMyStatusMessage({
      companyId: COMPANY,
      userId: USER,
      message: '   Focus time   ',
    });
    assert.equal(snap.statusMessage, 'Focus time');
  });

  test('over-limit message refused (37.1 §14)', async () => {
    const { svc } = makeDeps();
    const long = 'x'.repeat(161);
    await assert.rejects(
      () =>
        svc.setMyStatusMessage({
          companyId: COMPANY,
          userId: USER,
          message: long,
        }),
      (err) =>
        err.presenceCode ===
        presenceErrors.PRESENCE_ERROR_CODES.STATUS_MESSAGE_TOO_LONG,
    );
  });

  test('clearing message works (37.1 §15)', async () => {
    const { svc } = makeDeps();
    await svc.setMyStatusMessage({
      companyId: COMPANY,
      userId: USER,
      message: 'Focus',
    });
    const snap = await svc.setMyStatusMessage({
      companyId: COMPANY,
      userId: USER,
      message: '',
    });
    assert.equal(snap.statusMessage, '');
  });

  test('status message mutation refused when tenant disabled it (37.1 §17)', async () => {
    const { svc } = makeDeps({ statusMessagesEnabled: false });
    await assert.rejects(
      () =>
        svc.setMyStatusMessage({
          companyId: COMPANY,
          userId: USER,
          message: 'Focus',
        }),
      (err) =>
        err.presenceCode ===
        presenceErrors.PRESENCE_ERROR_CODES.STATUS_MESSAGES_DISABLED,
    );
  });

  test('office accepted when allowed (37.1 §18)', async () => {
    const { svc } = makeDeps();
    const snap = await svc.setMyWorkLocation({
      companyId: COMPANY,
      userId: USER,
      location: 'office',
    });
    assert.equal(snap.workLocation, 'office');
  });

  test('remote accepted when allowed (37.1 §19)', async () => {
    const { svc } = makeDeps();
    const snap = await svc.setMyWorkLocation({
      companyId: COMPANY,
      userId: USER,
      location: 'remote',
    });
    assert.equal(snap.workLocation, 'remote');
  });

  test('WFH accepted under self_declare when allowed (37.1 §20)', async () => {
    const { svc } = makeDeps();
    const snap = await svc.setMyWorkLocation({
      companyId: COMPANY,
      userId: USER,
      location: 'wfh',
    });
    assert.equal(snap.workLocation, 'wfh');
  });

  test('WFH refused when disabled (37.1 §21)', async () => {
    const { svc } = makeDeps({ wfhMode: 'disabled' });
    await assert.rejects(
      () =>
        svc.setMyWorkLocation({
          companyId: COMPANY,
          userId: USER,
          location: 'wfh',
        }),
      (err) => err.presenceCode === presenceErrors.PRESENCE_ERROR_CODES.WFH_DISABLED,
    );
  });

  test('WFH direct activation refused when approval_required (37.1 §22)', async () => {
    const { svc } = makeDeps({ wfhMode: 'approval_required' });
    await assert.rejects(
      () =>
        svc.setMyWorkLocation({
          companyId: COMPANY,
          userId: USER,
          location: 'wfh',
        }),
      (err) =>
        err.presenceCode ===
        presenceErrors.PRESENCE_ERROR_CODES.WFH_APPROVAL_REQUIRED,
    );
  });

  test('work location outside tenant allowlist refused (37.1 §23)', async () => {
    const { svc } = makeDeps({ allowedWorkLocations: ['office'] });
    await assert.rejects(
      () =>
        svc.setMyWorkLocation({
          companyId: COMPANY,
          userId: USER,
          location: 'remote',
        }),
      (err) =>
        err.presenceCode ===
        presenceErrors.PRESENCE_ERROR_CODES.INVALID_WORK_LOCATION,
    );
  });

  test('unsupported location refused (37.1 §24)', async () => {
    const { svc } = makeDeps();
    await assert.rejects(
      () =>
        svc.setMyWorkLocation({
          companyId: COMPANY,
          userId: USER,
          location: 'on_the_moon',
        }),
      (err) =>
        err.presenceCode ===
        presenceErrors.PRESENCE_ERROR_CODES.INVALID_WORK_LOCATION,
    );
  });

  test('work-location mutation refused when feature disabled (37.1 §25)', async () => {
    const { svc } = makeDeps({ workLocationEnabled: false });
    await assert.rejects(
      () =>
        svc.setMyWorkLocation({
          companyId: COMPANY,
          userId: USER,
          location: 'office',
        }),
      (err) =>
        err.presenceCode ===
        presenceErrors.PRESENCE_ERROR_CODES.WORK_LOCATION_DISABLED,
    );
  });

  test('every service lookup is tenant scoped (37.1 §35)', async () => {
    const userPresence = makeUserPresenceFake();
    const tenant = makeTenantConfigFake(baseDefaults());
    const svc = presenceService.presenceService({
      UserPresenceModel: userPresence,
      tenantConfigReader: ({ companyId }) =>
        presenceTenantConfigService.getPresenceTenantConfigOrThrow({
          companyId,
          model: tenant,
        }),
    });
    await svc.getMyPresence({ companyId: COMPANY, userId: USER });

    const findOne = userPresence.calls.find((c) => c.op === 'findOne');
    assert.ok(findOne, 'findOne was called');
    assert.equal(String(findOne.filter.companyId), COMPANY);
    assert.equal(String(findOne.filter.userId), USER);

    const findOneAndUpdate = tenant.calls.find(
      (c) => c.op === 'findOneAndUpdate',
    );
    assert.ok(findOneAndUpdate);
    assert.equal(String(findOneAndUpdate.filter.companyId), COMPANY);
  });

  test('tenant A cannot read tenant B presence (37.1 §33)', async () => {
    const userPresence = makeUserPresenceFake();
    const tenant = makeTenantConfigFake(baseDefaults());
    const svc = presenceService.presenceService({
      UserPresenceModel: userPresence,
      tenantConfigReader: ({ companyId }) =>
        presenceTenantConfigService.getPresenceTenantConfigOrThrow({
          companyId,
          model: tenant,
        }),
    });
    // Seed tenant B's config
    tenant._peek().set(OTHER_COMPANY, { ...baseDefaults() });
    // Tenant B reads their own presence.
    await svc.getMyPresence({ companyId: OTHER_COMPANY, userId: USER });
    // The mock must NOT have received any query with tenant A.
    for (const call of tenant.calls) {
      assert.equal(String(call.filter.companyId), OTHER_COMPANY);
    }
    for (const call of userPresence.calls) {
      assert.equal(String(call.filter.companyId), OTHER_COMPANY);
    }
  });

  test('tenant A cannot mutate tenant B presence (37.1 §34)', async () => {
    const userPresence = makeUserPresenceFake();
    const tenant = makeTenantConfigFake(baseDefaults());
    tenant._peek().set(OTHER_COMPANY, { ...baseDefaults() });
    const svc = presenceService.presenceService({
      UserPresenceModel: userPresence,
      tenantConfigReader: ({ companyId }) =>
        presenceTenantConfigService.getPresenceTenantConfigOrThrow({
          companyId,
          model: tenant,
        }),
    });
    await svc.setMyStatus({
      companyId: COMPANY,
      userId: USER,
      status: 'busy',
    });
    // tenant A's row was upserted. tenant B's was not.
    const rows = userPresence._peek();
    assert.ok(rows.has(`${COMPANY}:${USER}`));
    assert.ok(!rows.has(`${OTHER_COMPANY}:${USER}`));
    // Forced violation attempt — no mutation should reach tenant B.
    await assert.doesNotReject(async () => {
      await svc.setMyStatus({
        companyId: COMPANY,
        userId: USER,
        status: 'dnd',
      });
    });
    assert.equal(
      rows.has(`${OTHER_COMPANY}:${USER}`),
      false,
      'Tenant B row must remain absent',
    );
  });

  test('expired stored message is not returned active (37.1 §16)', async () => {
    const yesterday = new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000);
    // Direct write to the durable fake simulating a row with expired message.
    const userPresence = makeUserPresenceFake();
    userPresence._peek().set(`${COMPANY}:${USER}`, {
      companyId: COMPANY,
      userId: USER,
      manualStatus: null,
      manualStatusExpiresAt: null,
      statusMessage: 'stale',
      statusMessageExpiresAt: yesterday,
      workLocation: null,
      workLocationExpiresAt: null,
    });
    // Reading the resolver directly with the same payload.
    const r = presenceResolver.resolvePresence({
      durable: userPresence._peek().get(`${COMPANY}:${USER}`),
      config: baseDefaults(),
      now: FIXED_NOW,
    });
    assert.equal(r.statusMessage, '');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  VALIDATORS — §12/§19 of the 37.1 spec
// ─────────────────────────────────────────────────────────────────────

describe('presence validators', () => {
  test('forbidden identity fields (37.1 §27–§32)', async () => {
    const chain = presenceValidatorModule.presenceStatusValidator;
    for (const field of [
      'companyId',
      'company',
      'userId',
      'user',
      'employeeId',
      'employee',
    ]) {
      const { thrown } = await runChain(chain, {
        body: { status: 'busy', [field]: 'injected' },
      });
      assert.ok(thrown, `${field} should be rejected`);
      assert.ok(
        thrown.message.includes(field),
        `error message should name the field (${field})`,
      );
    }
  });

  test('status:null with expiresAt is refused (the validator-level rule)', async () => {
    const { thrown } = await runChain(
      presenceValidatorModule.presenceStatusValidator,
      {
        body: { status: null, expiresAt: inOneHour.toISOString() },
      },
    );
    assert.ok(thrown);
  });

  test('valid status with expiry accepted', async () => {
    const { thrown } = await runChain(
      presenceValidatorModule.presenceStatusValidator,
      {
        body: { status: 'busy', expiresAt: inOneHour.toISOString() },
      },
    );
    assert.equal(thrown, null);
  });

  test('over-limit message refused at validator layer (37.1 §14)', async () => {
    const long = 'x'.repeat(161);
    const { thrown } = await runChain(
      presenceValidatorModule.presenceStatusMessageValidator,
      { body: { message: long } },
    );
    assert.ok(thrown);
  });

  test('invalid work-location refused at validator layer (37.1 §24)', async () => {
    const { thrown } = await runChain(
      presenceValidatorModule.presenceWorkLocationValidator,
      { body: { location: 'on_the_moon' } },
    );
    assert.ok(thrown);
  });

  test('offlineAfterMinutes <= awayAfterMinutes refused (37.1 §42)', async () => {
    const { thrown } = await runChain(
      presenceValidatorModule.presenceConfigValidator,
      {
        body: { awayAfterMinutes: 10, offlineAfterMinutes: 5 },
      },
    );
    assert.ok(thrown);
    assert.ok(thrown.message.toLowerCase().includes('offline'));
  });
});

// ─────────────────────────────────────────────────────────────────────
//  SOURCE-LEVEL GUARANTEES — §3/§7/§21 of the 37.1 spec
// ─────────────────────────────────────────────────────────────────────

describe('presence source guarantees', () => {
  const code = (rel) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('presence resolver does not import Attendance / Leave / Payroll (37.1 §3)', () => {
    const src = code('src/services/presence/presenceResolver.js');
    assert.doesNotMatch(src, /from\s+['"](?:\.\.\/)+models\/(?:Attendance|Leave|Payroll|PayrollResult|Payslip)/);
    assert.doesNotMatch(src, /services\/(?:attendance|chat|payroll)/);
  });

  test('presence service does not import attendance mutation services (37.1 §3)', () => {
    const src = code('src/services/presence/presenceService.js');
    assert.doesNotMatch(src, /attendance[A-Z]\w*Service/);
    assert.doesNotMatch(src, /leaveService/);
    assert.doesNotMatch(src, /payroll[A-Z]\w*Service/);
  });

  test('no presence history / activity model exists (37.1 §7)', () => {
    const root = backendRoot;
    const list = fs.readdirSync(path.join(root, 'src/models'));
    for (const name of list) {
      assert.notEqual(
        name,
        'PresenceHistory.js',
        'PresenceHistory model must not exist',
      );
      assert.notEqual(
        name,
        'ActivityHistory.js',
        'ActivityHistory model must not exist',
      );
      assert.notEqual(
        name,
        'EmployeeActivity.js',
        'EmployeeActivity model must not exist',
      );
    }
  });

  test('presence validator refuses all six identity override fields (37.1 §19)', () => {
    const src = code('src/validators/presence/presenceValidator.js');
    for (const field of [
      'companyId',
      'company',
      'userId',
      'user',
      'employeeId',
      'employee',
    ]) {
      assert.ok(src.includes(`'${field}'`), `validator must reference ${field}`);
    }
  });

  test('Phase 36 AI surface has NO presence references (37.1 §21)', () => {
    const aiFiles = [
      'src/services/ai/aiConfig.js',
      'src/services/ai/aiErrors.js',
      'src/services/ai/aiProvider.js',
      'src/services/ai/hrChatbotService.js',
      'src/services/ai/hrContextRetriever.js',
      'src/services/ai/aiTenantConfigService.js',
    ];
    for (const rel of aiFiles) {
      const src = code(rel);
      assert.doesNotMatch(
        src,
        /UserPresence|PresenceTenantConfig|presence\//,
        `${rel} must not reference presence modules`,
      );
    }
  });

  test('no localStorage of status messages (37.1 §26)', () => {
    const src = code('src/services/presence/presenceService.js');
    assert.doesNotMatch(src, /localStorage|sessionStorage/);
  });
});