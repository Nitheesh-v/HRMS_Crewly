// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE BUS TESTS (hermetic)
//
//  The presence bus emits only strict envelopes through the
//  authenticated /presence Socket.IO namespace. We fake the namespace and assert:
//    · payload minimization (no status message text, no email/phone/token)
//    · schemaVersion presence and authenticated user-room targeting
//    · failure does not throw up; resolver still resolves correctly
// ═══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV ||= 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_presence_bus_test';

const { buildPresenceChangedEnvelope, parsePresenceChangedEnvelope, PRESENCE_GATEWAY_EVENT_TYPE, PRESENCE_ENVELOPE_KEYS } = await import(
  '../src/services/presence/presenceEvents.js'
);
const {
  publishPresenceChanged,
  publishPresenceInvalidated,
  presenceBusAvailable,
} = await import('../src/services/presence/presenceBus.js');
const {
  __setPresenceSocketNamespaceForTests,
  __resetPresenceSocketNamespaceForTests,
} = await import('../src/services/presence/presenceSocketPublisher.js');

const COMPANY = '1111111111111111111111aa';
const USER = '2222222222222222222222bb';

const fakeNamespace = (overrides = {}) => {
  const emissions = [];
  return {
    emissions,
    to: (room) => ({
      emit: (event, envelope) => {
        if (overrides.emitError) throw overrides.emitError;
        emissions.push({ room, event, envelope });
      },
    }),
  };
};

test('envelope: buildPresenceChangedEnvelope produces a frozen, valid envelope', () => {
  const { envelope } = buildPresenceChangedEnvelope({
    companyId: COMPANY,
    userId: USER,
    presence: 'available',
    presenceSource: 'automatic',
    occurredAt: '2026-10-03T10:00:00.000Z',
    source: 'activity',
  });
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.companyId, COMPANY);
  assert.equal(envelope.userId, USER);
  assert.equal(envelope.presence, 'available');
  assert.equal(envelope.presenceSource, 'automatic');
  assert.equal(envelope.occurredAt, '2026-10-03T10:00:00.000Z');
  assert.equal(envelope.source, 'activity');
  // Frozen
  assert.throws(() => { envelope.presence = 'busy'; });
});

test('envelope: buildPresenceChangedEnvelope rejects forbidden keys (drift guard)', () => {
  // The build helper itself does not accept extra keys (the input
  // is destructured into a fixed set). But the shape assertion
  // throws if a future schema change adds an extra key by accident.
  // The test asserts the strict shape: every produced envelope has
  // EXACTLY the 7 expected keys.
  const { envelope } = buildPresenceChangedEnvelope({
    companyId: COMPANY,
    userId: USER,
    presence: 'available',
    presenceSource: 'automatic',
    occurredAt: '2026-10-03T10:00:00.000Z',
    source: 'activity',
  });
  assert.deepEqual(Object.keys(envelope).sort(), [...PRESENCE_ENVELOPE_KEYS].sort());
});

test('#29 envelope does NOT contain status-message text', async () => {
  // Pinned: the build helper does not accept `statusMessage`; the
  // envelope keys list does not include it.
  assert.equal(PRESENCE_ENVELOPE_KEYS.includes('statusMessage'), false);
  assert.equal(PRESENCE_ENVELOPE_KEYS.includes('message'), false);
  // Source-pin: the bus file does not import or carry status messages.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, '..', 'src', 'services', 'presence', 'presenceBus.js'),
    'utf8',
  );
  assert.equal(/statusMessage/i.test(src), false);
});

test('#30 envelope does NOT contain email', () => {
  assert.equal(PRESENCE_ENVELOPE_KEYS.includes('email'), false);
});

test('#31 envelope does NOT contain phone', () => {
  assert.equal(PRESENCE_ENVELOPE_KEYS.includes('phone'), false);
});

test('#32 envelope does NOT contain token', () => {
  assert.equal(PRESENCE_ENVELOPE_KEYS.includes('token'), false);
  assert.equal(PRESENCE_ENVELOPE_KEYS.includes('accessToken'), false);
  assert.equal(PRESENCE_ENVELOPE_KEYS.includes('refreshToken'), false);
});

test('#33 event includes schema version', () => {
  const { envelope } = buildPresenceChangedEnvelope({
    companyId: COMPANY,
    userId: USER,
    presence: 'available',
    presenceSource: 'automatic',
    occurredAt: '2026-10-03T10:00:00.000Z',
    source: 'activity',
  });
  assert.equal(envelope.schemaVersion, 1);
});

test('envelope: parser drops frames with an unknown schemaVersion (forward-safe)', () => {
  const future = JSON.stringify({
    schemaVersion: 999,
    companyId: COMPANY,
    userId: USER,
    presence: 'available',
    presenceSource: 'automatic',
    occurredAt: '2026-10-03T10:00:00.000Z',
    source: 'activity',
  });
  assert.equal(parsePresenceChangedEnvelope(future), null);
});

test('envelope: parser drops malformed JSON, missing fields, and bad sources', () => {
  assert.equal(parsePresenceChangedEnvelope(null), null);
  assert.equal(parsePresenceChangedEnvelope(''), null);
  assert.equal(parsePresenceChangedEnvelope('{'), null);
  assert.equal(parsePresenceChangedEnvelope('{"schemaVersion":1}'), null);
  assert.equal(
    parsePresenceChangedEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        companyId: COMPANY,
        userId: USER,
        presence: 'available',
        occurredAt: 'not-a-date',
        source: 'activity',
      }),
    ),
    null,
  );
  assert.equal(
    parsePresenceChangedEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        companyId: COMPANY,
        userId: USER,
        presence: 'available',
        occurredAt: '2026-10-03T10:00:00.000Z',
        source: 'BOGUS_SOURCE',
      }),
    ),
    null,
  );
});

test('envelope: parse round-trips a valid envelope', () => {
  const { envelope, serialized } = buildPresenceChangedEnvelope({
    companyId: COMPANY,
    userId: USER,
    presence: 'away',
    presenceSource: 'automatic',
    occurredAt: '2026-10-03T10:00:00.000Z',
    source: 'activity',
  });
  const parsed = parsePresenceChangedEnvelope(serialized);
  assert.deepEqual(parsed, envelope);
});

test('envelope: serialized form is under PRESENCE_MAX_LIVE_ENVELOPE_BYTES', () => {
  const { serialized } = buildPresenceChangedEnvelope({
    companyId: COMPANY,
    userId: USER,
    presence: 'available',
    presenceSource: 'automatic',
    occurredAt: '2026-10-03T10:00:00.000Z',
    source: 'activity',
  });
  assert.ok(
    serialized.length <= 512,
    `envelope must be under 512 bytes (got ${serialized.length})`,
  );
});

test('bus: publishPresenceChanged emits the strict envelope to the authenticated user room', async () => {
  const namespace = fakeNamespace();
  __setPresenceSocketNamespaceForTests(namespace);
  try {
    const result = await publishPresenceChanged({
      companyId: COMPANY,
      userId: USER,
      presence: 'available',
      presenceSource: 'automatic',
      source: 'activity',
    });
    assert.equal(result.ok, true);
    assert.equal(result.delivered, 'socket.io');
    assert.equal(namespace.emissions.length, 1);
    const call = namespace.emissions[0];
    assert.equal(call.room, `presence:user:${COMPANY}:${USER}`);
    assert.equal(call.event, PRESENCE_GATEWAY_EVENT_TYPE);
    assert.equal(call.envelope.companyId, COMPANY);
    assert.equal(call.envelope.userId, USER);
    assert.equal(call.envelope.schemaVersion, 1);
    assert.equal(call.envelope.presence, 'available');
    assert.equal(call.envelope.presenceSource, 'automatic');
    assert.equal(call.envelope.source, 'activity');
    assert.ok(call.envelope.occurredAt);
    assert.equal(call.envelope.statusMessage, undefined);
    assert.equal(call.envelope.email, undefined);
    assert.equal(call.envelope.phone, undefined);
  } finally {
    __resetPresenceSocketNamespaceForTests();
  }
});

test("bus: publishPresenceInvalidated targets the affected user's room with a minimal shape", async () => {
  const namespace = fakeNamespace();
  __setPresenceSocketNamespaceForTests(namespace);
  try {
    const result = await publishPresenceInvalidated({
      companyId: COMPANY,
      userId: USER,
      source: 'approve',
      occurredAt: '2026-10-03T10:00:00.000Z',
    });
    assert.equal(result.ok, true);
    assert.equal(namespace.emissions[0].room, `presence:user:${COMPANY}:${USER}`);
    assert.equal(namespace.emissions[0].event, 'presence:invalidated');
    assert.deepEqual(Object.keys(namespace.emissions[0].envelope).sort(), [
      'companyId', 'occurredAt', 'schemaVersion', 'source', 'userId',
    ]);
  } finally {
    __resetPresenceSocketNamespaceForTests();
  }
});

test('bus: publish failure does not throw; disabled namespace remains unavailable', async () => {
  const namespace = fakeNamespace({ emitError: new Error('SOCKET_DOWN') });
  __setPresenceSocketNamespaceForTests(namespace);
  try {
    const result = await publishPresenceChanged({
      companyId: COMPANY,
      userId: USER,
      presence: 'available',
      presenceSource: 'automatic',
      source: 'activity',
    });
    assert.equal(result.ok, false);
    assert.equal(result.delivered, 'none');
    assert.ok(result.error);
    assert.equal(presenceBusAvailable(), true);
  } finally {
    __resetPresenceSocketNamespaceForTests();
  }
  assert.equal(presenceBusAvailable(), false);
});

test('bus: build failure (forbidden source) is reported, not raised', async () => {
  const result = await publishPresenceChanged({
    companyId: COMPANY,
    userId: USER,
    presence: 'available',
    presenceSource: 'automatic',
    source: 'BOGUS',
  });
  assert.equal(result.ok, false);
  assert.equal(result.delivered, 'none');
  assert.ok(result.error);
});
