// Phase 30.2 — BGV SERVICE CATALOGUE & PRICING (hermetic suite).
//
// No MongoDB/Redis needed: the service accepts injected collaborators and the
// rules are pure. Platform-gate middleware is exercised with fake req/res so
// the tenant-rejection boundary is proven without a database.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BGV_CATALOGUE_TYPES,
  BGV_CATALOGUE_CURRENCY,
  formatMinorUnits,
  parsePriceToMinorUnits,
  validateCataloguePayload,
} from '../src/services/bgv/bgvCatalogueRules.js';
import {
  configureBgvService,
  getCatalogueView,
  resolveActivePrice,
} from '../src/services/bgv/bgvCatalogueService.js';
import BgvServiceCatalogue from '../src/models/BgvServiceCatalogue.js';
import {
  PLATFORM_PERMISSIONS,
  permit,
  superAdminSession,
} from '../src/middlewares/superAdminAuth.js';

const ACTOR = 'eee555555555555555555555';

// ── fakes ────────────────────────────────────────────────────────
const makeStore = (initial = []) => {
  const records = initial.map((record) => ({ ...record }));
  const calls = { audits: [], upserts: 0 };
  const deps = {
    findAll: async () => records.map((record) => ({ ...record })),
    upsert: async ({ type, set, actorId }) => {
      calls.upserts += 1;
      let record = records.find((candidate) => candidate.type === type);
      if (!record) {
        record = { _id: `id-${type}`, type, createdAt: new Date() };
        records.push(record);
      }
      Object.assign(record, set, {
        updatedBy: actorId ?? null,
        updatedAt: new Date(),
        version: (record.version || 0) + 1,
      });
      return { ...record };
    },
    audit: async (entry) => {
      calls.audits.push(entry);
      return entry;
    },
  };
  return { records, calls, deps };
};

const fakeRes = () => {
  const res = { code: 0, body: null };
  res.status = (code) => {
    res.code = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

// ── 1/2 fixed five products only ─────────────────────────────────
test('catalogue exposes exactly the five allowlisted products', async () => {
  assert.deepEqual(BGV_CATALOGUE_TYPES, [
    'IDENTITY',
    'ADDRESS',
    'EDUCATION',
    'EMPLOYMENT',
    'REFERENCE',
  ]);
  const store = makeStore();
  const view = await getCatalogueView(store.deps);
  assert.equal(view.services.length, 5);
  assert.deepEqual(
    view.services.map((service) => service.type),
    BGV_CATALOGUE_TYPES
  );
  assert.equal(view.configuredCount, 0);
  for (const service of view.services) {
    assert.equal(service.configured, false, 'nothing is seeded');
    assert.equal(service.active, false, 'unconfigured is not purchasable');
  }
});

test('unknown sixth type is rejected by validation and service', async () => {
  const validation = validateCataloguePayload({ type: 'CRIMINAL', price: '500' });
  assert.equal(validation.ok, false);

  const store = makeStore();
  await assert.rejects(
    configureBgvService({ type: 'CRIMINAL', payload: { price: '500' }, actorId: ACTOR, deps: store.deps }),
    (error) => error.statusCode === 400
  );
  assert.equal(store.records.length, 0);
});

// ── money rules ──────────────────────────────────────────────────
test('money parsing is integer-exact and rejects malformed values', () => {
  assert.deepEqual(parsePriceToMinorUnits('499'), { ok: true, minor: 49900 });
  assert.deepEqual(parsePriceToMinorUnits('499.5'), { ok: true, minor: 49950 });
  assert.deepEqual(parsePriceToMinorUnits('0.05'), { ok: true, minor: 5 });
  assert.equal(parsePriceToMinorUnits(500).minor, 50000);
  assert.equal(parsePriceToMinorUnits('0').ok, true, 'zero is an explicit supported rule');

  for (const bad of ['-5', '-0.01', 'abc', '1.234', '12,34', '', '1e3', 'NaN', 'Infinity']) {
    assert.equal(parsePriceToMinorUnits(bad).ok, false, `${bad} must be rejected`);
  }
  assert.equal(parsePriceToMinorUnits(Number.NaN).ok, false);
  assert.equal(parsePriceToMinorUnits(Number.POSITIVE_INFINITY).ok, false);
  assert.equal(parsePriceToMinorUnits('999999999999').ok, false, 'cap enforced');
  assert.equal(formatMinorUnits(49950), '₹499.50');
  assert.equal(formatMinorUnits(10000000), '₹1,00,000.00');
});

test('unsupported currency is rejected', () => {
  const validation = validateCataloguePayload({
    type: 'IDENTITY',
    price: '500',
    currency: 'USD',
  });
  assert.equal(validation.ok, false);
  assert.equal(BGV_CATALOGUE_CURRENCY, 'INR');
});

// ── 3-5 configuration lifecycle ──────────────────────────────────
test('first-time configuration requires a price; updates may omit it', async () => {
  const store = makeStore();
  await assert.rejects(
    configureBgvService({ type: 'IDENTITY', payload: { active: true }, actorId: ACTOR, deps: store.deps }),
    (error) => error.statusCode === 400
  );
  assert.equal(store.records.length, 0);
});

test('first-time configuration creates exactly one row per product', async () => {
  const store = makeStore();
  const result = await configureBgvService({
    type: 'IDENTITY',
    payload: { price: '500' },
    actorId: ACTOR,
    deps: store.deps,
  });
  assert.equal(result.configured, true);
  assert.equal(result.priceMinorUnits, 50000);
  assert.equal(result.version, 1);
  assert.equal(result.action, 'BGV_CATALOGUE_CONFIGURED');
  assert.equal(store.records.filter((record) => record.type === 'IDENTITY').length, 1);

  // Duplicate configure is an update of the same row, never a second row.
  await configureBgvService({
    type: 'IDENTITY',
    payload: { price: '550' },
    actorId: ACTOR,
    deps: store.deps,
  });
  assert.equal(store.records.filter((record) => record.type === 'IDENTITY').length, 1);
});

test('valid price update persists integer minor units and bumps version', async () => {
  const store = makeStore();
  await configureBgvService({ type: 'ADDRESS', payload: { price: '600' }, actorId: ACTOR, deps: store.deps });
  const updated = await configureBgvService({
    type: 'ADDRESS',
    payload: { price: '649.99' },
    actorId: ACTOR,
    deps: store.deps,
  });
  assert.equal(updated.priceMinorUnits, 64999);
  assert.equal(updated.version, 2);
  assert.equal(updated.priceDisplay, '₹649.99');
});

test('negative and malformed prices are rejected by the service', async () => {
  const store = makeStore();
  for (const price of ['-1', 'abc', '1.234']) {
    await assert.rejects(
      configureBgvService({ type: 'EDUCATION', payload: { price }, actorId: ACTOR, deps: store.deps }),
      (error) => error.statusCode === 400
    );
  }
  assert.equal(store.records.length, 0);
});

// ── 8-10 activation / deactivation ───────────────────────────────
test('deactivation keeps the record and reactivation restores it', async () => {
  const store = makeStore();
  await configureBgvService({ type: 'REFERENCE', payload: { price: '400' }, actorId: ACTOR, deps: store.deps });

  const off = await configureBgvService({
    type: 'REFERENCE',
    payload: { active: false },
    actorId: ACTOR,
    deps: store.deps,
  });
  assert.equal(off.active, false);
  assert.equal(off.action, 'BGV_CATALOGUE_DEACTIVATED');
  // Historical/config data survives deactivation.
  const stored = store.records.find((record) => record.type === 'REFERENCE');
  assert.equal(stored.priceMinorUnits, 40000);
  assert.equal(stored.version, 2);

  const on = await configureBgvService({
    type: 'REFERENCE',
    payload: { active: true },
    actorId: ACTOR,
    deps: store.deps,
  });
  assert.equal(on.active, true);
  assert.equal(on.action, 'BGV_CATALOGUE_ACTIVATED');
});

// ── 17 authoritative resolver for future 30.3 ────────────────────
test('resolveActivePrice is server-authoritative and ignores client money', async () => {
  const store = makeStore();
  await configureBgvService({ type: 'EMPLOYMENT', payload: { price: '800' }, actorId: ACTOR, deps: store.deps });

  const price = await resolveActivePrice('EMPLOYMENT', store.deps);
  assert.deepEqual(price, {
    type: 'EMPLOYMENT',
    priceMinorUnits: 80000,
    currency: 'INR',
    version: 1,
  });

  assert.equal(await resolveActivePrice('CRIMINAL', store.deps), null);
  assert.equal(await resolveActivePrice('IDENTITY', store.deps), null, 'unconfigured not purchasable');

  await configureBgvService({ type: 'EMPLOYMENT', payload: { active: false }, actorId: ACTOR, deps: store.deps });
  assert.equal(await resolveActivePrice('EMPLOYMENT', store.deps), null, 'deactivated not purchasable');
});

// ── 15/16 audit + response safety ────────────────────────────────
test('mutations are audited with safe old/new commercial metadata', async () => {
  const store = makeStore();
  await configureBgvService({ type: 'IDENTITY', payload: { price: '500' }, actorId: ACTOR, deps: store.deps });
  await configureBgvService({ type: 'IDENTITY', payload: { price: '520' }, actorId: ACTOR, deps: store.deps });

  assert.equal(store.calls.audits.length, 2);
  const [first, second] = store.calls.audits;
  assert.equal(first.type, 'BGV_CATALOGUE_UPDATED');
  assert.equal(first.metadata.action, 'BGV_CATALOGUE_CONFIGURED');
  assert.equal(first.metadata.previous, null);
  assert.equal(second.metadata.previous.priceMinorUnits, 50000);
  assert.equal(second.metadata.next.priceMinorUnits, 52000);
  assert.equal(second.metadata.actorId, ACTOR);
  const serialized = JSON.stringify(store.calls.audits);
  assert.doesNotMatch(serialized, /SECRET|PASSWORD|token/i);
});

test('catalogue view exposes no internal or sensitive fields', async () => {
  const store = makeStore([
    {
      _id: 'id-IDENTITY',
      type: 'IDENTITY',
      priceMinorUnits: 50000,
      currency: 'INR',
      active: true,
      version: 1,
      updatedBy: ACTOR,
      updatedAt: new Date(),
      createdAt: new Date(),
      description: '',
      displayName: '',
    },
  ]);
  const view = await getCatalogueView(store.deps);
  const identity = view.services.find((service) => service.type === 'IDENTITY');
  for (const key of Object.keys(identity)) {
    assert.ok(
      [
        'id', 'type', 'name', 'description', 'configured', 'active',
        'priceMinorUnits', 'priceDisplay', 'currency', 'version',
        'updatedBy', 'updatedAt', 'createdAt',
      ].includes(key),
      `unexpected field ${key}`
    );
  }
});

// ── 18 duplicate protection at schema level ──────────────────────
test('schema enforces a unique index on the product type', () => {
  const uniqueTypeIndex = BgvServiceCatalogue.schema.indexes().some(
    ([fields, options]) => options?.unique === true && 'type' in fields
  );
  assert.equal(uniqueTypeIndex, true);
});

// ── 11-14 platform authorization boundary ────────────────────────
test('platform permission map grants catalogue rights only to billing/super', () => {
  assert.ok(PLATFORM_PERMISSIONS.BILLING_ADMIN.includes('bgv-catalog:read'));
  assert.ok(PLATFORM_PERMISSIONS.BILLING_ADMIN.includes('bgv-catalog:manage'));
  assert.ok(PLATFORM_PERMISSIONS.SUPER_ADMIN.includes('*'));
  assert.equal(PLATFORM_PERMISSIONS.SUPPORT_ADMIN.includes('bgv-catalog:manage'), false);
  assert.equal(PLATFORM_PERMISSIONS.PLATFORM_ADMIN.includes('bgv-catalog:manage'), false);
});

test('permit: manage permission passes, other platform roles denied', () => {
  const allowed = fakeRes();
  let nexted = false;
  permit('bgv-catalog:manage')(
    { platformPermissions: ['bgv-catalog:manage'] },
    allowed,
    () => {
      nexted = true;
    }
  );
  assert.equal(nexted, true);

  const star = fakeRes();
  let starred = false;
  permit('bgv-catalog:manage')({ platformPermissions: ['*'] }, star, () => {
    starred = true;
  });
  assert.equal(starred, true);

  const denied = fakeRes();
  let deniedNext = false;
  permit('bgv-catalog:manage')(
    { platformPermissions: ['dashboard:read', 'support:manage'] },
    denied,
    () => {
      deniedNext = true;
    }
  );
  assert.equal(denied.code, 403);
  assert.equal(deniedNext, false);
});

test('tenant token is rejected at the platform gate before any DB access', async () => {
  const req = {
    user: { role: 'HR_MANAGER', _id: 'aaa111111111111111111111' },
    headers: {},
  };
  const res = fakeRes();
  let nexted = false;
  await superAdminSession(req, res, () => {
    nexted = true;
  });
  assert.equal(res.code, 403);
  assert.match(res.body.message, /Platform administrator access required/);
  assert.equal(nexted, false);
});
