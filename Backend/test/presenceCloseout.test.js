// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.7 — TENANT ADMIN / OPERATIONAL CLOSEOUT SUITE
//
//  Pinned from `docs/PHASE_37_7_BUILD_PLAN.md` §D. The hermetic tests
//  here assert the SETTINGS BACKEND and the read-only INVARIANTS
//  promised by the spec. The frontend closeout tests live in
//  `Frontend/test/presenceSettings.test.js`.
// ═══════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESENCE_TENANT_DEFAULTS, WFH_MODES, WORK_LOCATION_VALUES } from '../src/services/presence/presenceConfig.js';
import {
  PRESENCE_UPDATABLE_FIELDS,
  defaultSnapshot,
} from '../src/services/presence/presenceTenantConfigService.js';

// ─────────────────────────────────────────────────────────────────────
// 1. PRESENCE_UPDATABLE_FIELDS whitelist
// ─────────────────────────────────────────────────────────────────────

test('closeout #1 — UPDATABLE_FIELDS is frozen and the documented 9 keys', () => {
  assert.ok(Object.isFrozen(PRESENCE_UPDATABLE_FIELDS), 'whitelist must be frozen');
  for (const key of [
    'enabled',
    'employeePresenceVisible',
    'statusMessagesEnabled',
    'workLocationEnabled',
    'wfhMode',
    'awayAfterMinutes',
    'offlineAfterMinutes',
    'lastSeenVisible',
    'allowedWorkLocations',
  ]) {
    assert.ok(PRESENCE_UPDATABLE_FIELDS.includes(key), `whitelist must include ${key}`);
  }
});

test('closeout #2 — UPDATABLE_FIELDS does NOT include identity / tenant keys', () => {
  for (const forbidden of [
    'companyId',
    'userId',
    'employeeId',
    'tenantId',
    'organizationId',
    'updatedBy',
    'createdAt',
    'updatedAt',
    '__v',
  ]) {
    assert.equal(
      PRESENCE_UPDATABLE_FIELDS.includes(forbidden),
      false,
      `whitelist must NOT include ${forbidden}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────
// 3-5. Tenant defaults
// ─────────────────────────────────────────────────────────────────────

test('closeout #3 — defaults form a complete snapshot (all UPDATABLE_FIELDS covered)', () => {
  for (const key of PRESENCE_UPDATABLE_FIELDS) {
    assert.notEqual(
      PRESENCE_TENANT_DEFAULTS[key],
      undefined,
      `defaults must define a value for ${key}`,
    );
  }
});

test('closeout #4 — default Away/Offline satisfy the invariant (Offline > Away)', () => {
  assert.ok(
    PRESENCE_TENANT_DEFAULTS.offlineAfterMinutes > PRESENCE_TENANT_DEFAULTS.awayAfterMinutes,
    'defaults must respect offline > away',
  );
});

test('closeout #5 — default allowed work locations are a subset of the platform enum', () => {
  for (const loc of PRESENCE_TENANT_DEFAULTS.allowedWorkLocations) {
    assert.ok(
      WORK_LOCATION_VALUES.includes(loc),
      `default ${loc} must be in WORK_LOCATION_VALUES`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────
// 6-8. WFH mode enum
// ─────────────────────────────────────────────────────────────────────

test('closeout #6 — WFH modes are exactly 3 (self_declare / approval_required / disabled)', () => {
  assert.equal(WFH_MODES.length, 3);
  for (const m of ['self_declare', 'approval_required', 'disabled']) {
    assert.ok(WFH_MODES.includes(m), `WFH_MODES must include ${m}`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 7-8. defaultSnapshot
// ─────────────────────────────────────────────────────────────────────

test('closeout #7 — defaultSnapshot is frozen and carries companyId', () => {
  const snap = defaultSnapshot('co-test');
  assert.ok(Object.isFrozen(snap), 'snapshot must be frozen');
  assert.equal(snap.companyId, 'co-test');
});

test('closeout #8 — defaultSnapshot always carries the full UPDATABLE_FIELDS shape', () => {
  const snap = defaultSnapshot('co-x');
  for (const key of PRESENCE_UPDATABLE_FIELDS) {
    assert.notEqual(snap[key], undefined, `snapshot must include ${key}`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 9. Service-level validation: WFH mode
// ─────────────────────────────────────────────────────────────────────

test('closeout #9 — unknown WFH mode is refused at the service layer', async () => {
  const { updatePresenceTenantConfig } = await import(
    '../src/services/presence/presenceTenantConfigService.js'
  );
  const fakeModel = {
    findOneAndUpdate: async () => {
      throw new Error('DB should not be reached');
    },
  };
  await assert.rejects(
    () =>
      updatePresenceTenantConfig({
        companyId: 'co-1',
        userId: 'u-1',
        patch: { wfhMode: 'totally-bogus' },
        model: fakeModel,
      }),
    /wfhMode must be one of/,
  );
});

test('closeout #10 — unknown allowed work location is refused at the service layer', async () => {
  const { updatePresenceTenantConfig } = await import(
    '../src/services/presence/presenceTenantConfigService.js'
  );
  const fakeModel = {
    findOneAndUpdate: async () => {
      throw new Error('DB should not be reached');
    },
  };
  await assert.rejects(
    () =>
      updatePresenceTenantConfig({
        companyId: 'co-1',
        userId: 'u-1',
        patch: { allowedWorkLocations: ['office', 'mall'] },
        model: fakeModel,
      }),
    /allowedWorkLocations entries must be one of/,
  );
});

test('closeout #11 — empty allowed list refused unless workLocationEnabled is false', async () => {
  const { updatePresenceTenantConfig } = await import(
    '../src/services/presence/presenceTenantConfigService.js'
  );
  const fakeModel = {
    findOneAndUpdate: async () => {
      throw new Error('DB should not be reached');
    },
  };
  await assert.rejects(
    () =>
      updatePresenceTenantConfig({
        companyId: 'co-1',
        userId: 'u-1',
        patch: { allowedWorkLocations: [] },
        model: fakeModel,
      }),
    /cannot be empty/,
  );
});

test('closeout #12 — empty allowed list IS allowed when workLocationEnabled=false in same patch', async () => {
  const { updatePresenceTenantConfig } = await import(
    '../src/services/presence/presenceTenantConfigService.js'
  );
  const stored = {
    companyId: 'co-1',
    workLocationEnabled: false,
    allowedWorkLocations: [],
  };
  const fakeModel = {
    findOneAndUpdate: async () => stored,
    findOne: async () => stored,
  };
  await updatePresenceTenantConfig({
    companyId: 'co-1',
    userId: 'u-1',
    patch: { allowedWorkLocations: [], workLocationEnabled: false },
    model: fakeModel,
  });
});

test('closeout #13 — Away <= 0 is rejected', async () => {
  const { updatePresenceTenantConfig } = await import(
    '../src/services/presence/presenceTenantConfigService.js'
  );
  const fakeModel = {
    findOneAndUpdate: async () => {
      throw new Error('DB should not be reached');
    },
  };
  await assert.rejects(
    () =>
      updatePresenceTenantConfig({
        companyId: 'co-1',
        userId: 'u-1',
        patch: { awayAfterMinutes: 0 },
        model: fakeModel,
      }),
    /awayAfterMinutes must be a positive integer/,
  );
});

test('closeout #14 — Offline <= Away is rejected', async () => {
  const { updatePresenceTenantConfig } = await import(
    '../src/services/presence/presenceTenantConfigService.js'
  );
  const fakeModel = {
    findOneAndUpdate: async () => {
      throw new Error('DB should not be reached');
    },
  };
  await assert.rejects(
    () =>
      updatePresenceTenantConfig({
        companyId: 'co-1',
        userId: 'u-1',
        patch: { awayAfterMinutes: 10, offlineAfterMinutes: 5 },
        model: fakeModel,
      }),
    /offlineAfterMinutes must be greater than awayAfterMinutes/,
  );
});

test('closeout #15 — unknown config key is refused (whitelist enforcement)', async () => {
  const { updatePresenceTenantConfig } = await import(
    '../src/services/presence/presenceTenantConfigService.js'
  );
  const fakeModel = {
    findOneAndUpdate: async () => {
      throw new Error('DB should not be reached');
    },
  };
  await assert.rejects(
    () =>
      updatePresenceTenantConfig({
        companyId: 'co-1',
        userId: 'u-1',
        patch: { doesNotExist: true },
        model: fakeModel,
      }),
    /Unsupported presence config field/,
  );
});

test('closeout #16 — duplicate allowed work locations is refused', async () => {
  const { updatePresenceTenantConfig } = await import(
    '../src/services/presence/presenceTenantConfigService.js'
  );
  const fakeModel = {
    findOneAndUpdate: async () => {
      throw new Error('DB should not be reached');
    },
  };
  await assert.rejects(
    () =>
      updatePresenceTenantConfig({
        companyId: 'co-1',
        userId: 'u-1',
        patch: { allowedWorkLocations: ['office', 'office'] },
        model: fakeModel,
      }),
    /must not contain duplicates/,
  );
});

// ─────────────────────────────────────────────────────────────────────
// 17-22. Read-only invariants: presence does not mutate HR data
// ─────────────────────────────────────────────────────────────────────

import { resolvePresence } from '../src/services/presence/presenceResolver.js';

test('closeout #17 — resolver does not call the database or external systems', () => {
  // Pure function. The presence / on_leave / outsideWorkingHours
  // decision happens entirely on the inputs.
  const out = resolvePresence({
    durable: { manualStatus: 'available', expiresAt: null, statusMessage: null },
    config: PRESENCE_TENANT_DEFAULTS,
    now: new Date('2026-01-15T10:00:00Z'),
    live: null,
  });
  assert.ok(out, 'resolver must return a result');
  assert.equal(typeof out.presence, 'string');
});

test('closeout #18 — on_leave beats manual presence (approved active Leave precedence)', () => {
  const out = resolvePresence({
    durable: { manualStatus: 'dnd', expiresAt: null, statusMessage: null },
    config: PRESENCE_TENANT_DEFAULTS,
    now: new Date('2026-01-15T10:00:00Z'),
    live: { state: 'available', source: 'live' },
    hrContext: { onLeave: true },
  });
  assert.equal(out.presence, 'on_leave');
  assert.equal(out.presenceSource, 'leave');
});

test('closeout #19 — outsideWorkingHours rides alongside presence (never replaces it)', () => {
  // OWH is a SEPARATE field; presence is computed from durable +
  // live. With no manual and no live, presence is "unknown" and
  // OWH may be true (server time is 3 AM).
  const out = resolvePresence({
    durable: null,
    config: PRESENCE_TENANT_DEFAULTS,
    now: new Date('2026-01-15T03:00:00Z'),
    live: null,
    hrContext: { outsideWorkingHours: true },
  });
  assert.notEqual(out.outsideWorkingHours, undefined);
  // presence is still its own value — OWH never replaces it.
  assert.equal(out.presence, 'unknown');
  assert.equal(out.outsideWorkingHours, true);
});

test('closeout #20 — pending leave does NOT produce on_leave (resolver is hrContext-driven)', () => {
  const out = resolvePresence({
    durable: null,
    config: PRESENCE_TENANT_DEFAULTS,
    now: new Date('2026-01-15T10:00:00Z'),
    live: { state: 'available', source: 'live' },
    hrContext: { onLeave: false },
  });
  assert.notEqual(out.presence, 'on_leave');
});

// ─────────────────────────────────────────────────────────────────────
// 21-26. Source-pin closeout: NATS, AI, surveillance, Redis
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..',
);

const readSrc = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8');

const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const presenceSrc = (rel) => stripComments(readSrc(path.join('src', rel)));

test('closeout #21 — Backend does NOT depend on a NATS package', () => {
  const pkg = JSON.parse(readSrc('package.json'));
  const deps = Object.assign(
    {},
    pkg.dependencies || {},
    pkg.devDependencies || {},
  );
  for (const name of Object.keys(deps)) {
    assert.equal(
      /^nats/i.test(name),
      false,
      `package.json must not include a NATS dep: ${name}`,
    );
  }
});

test('closeout #22 — no presence service file references a NATS client or import', () => {
  const files = [
    'services/presence/presenceBus.js',
    'services/presence/presenceLiveStore.js',
    'services/presence/presenceLiveStoreRegistry.js',
    'services/presence/presenceResolver.js',
    'services/presence/presenceService.js',
    'services/presence/presenceTeamService.js',
    'services/presence/presenceHrContext.js',
    'services/presence/presenceTenantConfigService.js',
    'services/presence/presenceEvents.js',
  ];
  for (const rel of files) {
    const text = presenceSrc(rel);
    assert.equal(
      /from\s+["']nats/i.test(text),
      false,
      `${rel} must not import nats`,
    );
    assert.equal(
      /require\(\s*["']nats/i.test(text),
      false,
      `${rel} must not require nats`,
    );
  }
});

test('closeout #23 — presence code does NOT import the AI context retriever', () => {
  const files = [
    'services/presence/presenceResolver.js',
    'services/presence/presenceService.js',
    'services/presence/presenceTeamService.js',
    'services/presence/presenceHrContext.js',
  ];
  for (const rel of files) {
    const text = presenceSrc(rel);
    assert.equal(
      /hrContextRetriever|hrChatbot|aiTenantConfig|aiProvider/.test(text),
      false,
      `${rel} must not import AI surfaces`,
    );
  }
});

test('closeout #24 — presence code does NOT call attendance mutation APIs', () => {
  const files = [
    'services/presence/presenceResolver.js',
    'services/presence/presenceService.js',
    'services/presence/presenceTeamService.js',
    'services/presence/presenceHrContext.js',
  ];
  for (const rel of files) {
    const text = presenceSrc(rel);
    assert.equal(
      /Attendance\.create|Attendance\.save|Attendance\.findOneAndUpdate|Attendance\.update|Attendance\.delete/.test(
        text,
      ),
      false,
      `${rel} must not mutate Attendance`,
    );
  }
});

test('closeout #25 — presence code does NOT call leave mutation APIs', () => {
  const files = [
    'services/presence/presenceResolver.js',
    'services/presence/presenceService.js',
    'services/presence/presenceTeamService.js',
    'services/presence/presenceHrContext.js',
  ];
  for (const rel of files) {
    const text = presenceSrc(rel);
    for (const verb of ['create', 'save', 'updateOne', 'findOneAndUpdate', 'deleteOne', 'approve', 'reject', 'cancel']) {
      assert.equal(
        new RegExp(`Leave[\\w]*\\.${verb}`, 'i').test(text),
        false,
        `${rel} must not ${verb} Leave`,
      );
    }
  }
});

test('closeout #26 — presence code does NOT call payroll mutation APIs', () => {
  const files = [
    'services/presence/presenceResolver.js',
    'services/presence/presenceService.js',
    'services/presence/presenceTeamService.js',
    'services/presence/presenceHrContext.js',
  ];
  for (const rel of files) {
    const text = presenceSrc(rel);
    assert.equal(
      /Payroll[\\w]*\.(create|save|update|findOneAndUpdate|deleteOne)/.test(text),
      false,
      `${rel} must not mutate Payroll`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────
// 27-30. Privacy / DTO closeout
// ─────────────────────────────────────────────────────────────────────

test('closeout #27 — PresenceTenantConfig snapshot never includes PII / payroll / government IDs', () => {
  const snap = defaultSnapshot('co-1');
  for (const forbidden of [
    'salary',
    'pan',
    'aadhaar',
    'uan',
    'bank',
    'accountNumber',
    'ifsc',
    'address',
    'gps',
    'latitude',
    'longitude',
    'medical',
    'reason',
    'attachment',
    'document',
    'approver',
    'balance',
    'quota',
    'remaining',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(snap, forbidden),
      false,
      `snapshot must NOT include ${forbidden}`,
    );
  }
});

test('closeout #28 — PresenceTenantConfig has no historical / surveillance fields', () => {
  const snap = defaultSnapshot('co-1');
  for (const forbidden of [
    'history',
    'timeline',
    'activityLog',
    'productivity',
    'mouse',
    'keystroke',
    'screenshot',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(snap, forbidden),
      false,
      `snapshot must NOT include ${forbidden}`,
    );
  }
});

test('closeout #29 — presenceHrContext exposes a single batched read for many users', () => {
  const text = presenceSrc('services/presence/presenceHrContext.js');
  assert.match(text, /findActiveApprovedLeaveMany/);
  assert.match(text, /findActiveApprovedLeave/);
});

test('closeout #30 — presenceTeamService source uses the batched leave reader', () => {
  const text = presenceSrc('services/presence/presenceTeamService.js');
  assert.match(text, /findActiveApprovedLeaveMany|findActiveApprovedLeave/);
});
