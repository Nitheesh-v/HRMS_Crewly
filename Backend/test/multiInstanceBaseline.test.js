// ============================================================
//  PHASE 32.1 — MULTI-INSTANCE BASELINE (HERMETIC SUITE).
//
//  Proves the foundational multi-instance correctness properties
//  established by the 32.1 audit:
//
//    1. The API-process subscription lifecycle scheduler can run
//       CONCURRENTLY in several API instances with exactly ONE
//       winner per status transition — no duplicate history rows,
//       no duplicate admin notifications, no duplicate SystemEvents
//       (atomic Mongo CAS claims; reminders stay eventKey-deduped).
//    2. Repeated (sequential) lifecycle runs are idempotent.
//    3. Entry-point separation pins: API server / express app /
//       worker stay independently deployable processes.
//    4. Customer auth holds NO process-memory session/business
//       state (stateless JWT + shared Mongo SecuritySession).
//
//  No MongoDB, no Redis, no network. The REAL shipped lifecycle
//  logic runs against an in-memory Subscription collection that
//  emulates findOneAndUpdate compare-and-set semantics — including
//  the mid-race re-check that makes a losing concurrent claim
//  return null exactly like the database does.
// ============================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const lifecycle = await import('../src/utils/subscriptionLifecycle.js');

const DAY = 24 * 60 * 60 * 1000;

const newId = (prefix, seq) => `${prefix}${String(seq).padStart(20, '0')}`;

// ─────────────────────────────────────────────────────────────
//  In-memory Subscription collection with CAS findOneAndUpdate.
//  A claim re-checks its filter AFTER a microtask yield — two
//  concurrent claims both pass the initial match, then serialize
//  and the loser returns null, mirroring the database row lock.
// ─────────────────────────────────────────────────────────────
class FakeSubscriptionCollection {
  constructor() {
    this.docs = [];
    this.seq = 0;
  }

  add(initial) {
    this.seq += 1;
    const doc = {
      _id: newId('sub', this.seq),
      company: newId('comp', this.seq),
      plan: 'PRO',
      status: 'ACTIVE',
      paymentStatus: 'PAID',
      readOnly: false,
      ...initial,
    };
    this.docs.push(doc);
    return doc;
  }

  matchesFilter(doc, filter) {
    for (const [key, condition] of Object.entries(filter)) {
      if (key === '_id') {
        if (String(doc._id) !== String(condition)) return false;
        continue;
      }

      if (condition && typeof condition === 'object') {
        if (condition.$ne !== undefined && doc[key] === condition.$ne) {
          return false;
        }
        if (
          condition.$nin &&
          condition.$nin.some((banned) => banned === doc[key])
        ) {
          return false;
        }
        continue;
      }

      if (doc[key] !== condition) return false;
    }

    return true;
  }

  find(filter = {}) {
    const matched = this.docs.filter((doc) => this.matchesFilter(doc, filter));

    return {
      // Plain-object copies: a run reads possibly-stale snapshots,
      // exactly like concurrent real reads outside the write lock.
      then: (resolve) => resolve(matched.map((doc) => ({ ...doc }))),
      catch: (onReject) => Promise.resolve(matched.map((d) => ({ ...d }))).catch(onReject),
    };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const match = () =>
      this.docs.find((doc) => this.matchesFilter(doc, filter));

    if (!match()) return null;

    // Yield so a concurrent identical claim can interleave — the
    // post-yield re-check is what makes the losing claim return null.
    await Promise.resolve();

    const winner = match();

    if (!winner) return null;

    Object.assign(winner, update.$set || {});

    return options.new ? { ...winner } : { ...winner, ...update.$set };
  }
}

// ─────────────────────────────────────────────────────────────
//  Collaborator fakes + world builder.
// ─────────────────────────────────────────────────────────────
const freshWorld = ({ settings = null } = {}) => {
  const SubscriptionModel = new FakeSubscriptionCollection();

  const historyRows = [];
  const notifications = [];
  const systemEvents = [];
  const counters = { gateInvalidations: 0 };

  const recordHistoryFn = async ({ subscription, event, eventKey, reason }) => {
    if (eventKey) {
      // Unique sparse SubscriptionHistory.eventKey contract: the
      // duplicate loser receives a duplicate-key failure the real
      // recordHistory translates to `null`.
      if (historyRows.some((row) => row.eventKey === eventKey)) {
        return null;
      }
    }

    const row = {
      subscription: subscription._id || subscription.company,
      event,
      eventKey: eventKey || null,
      reason: reason || '',
    };

    historyRows.push(row);

    return row;
  };

  const SystemEventModel = {
    create: async (doc) => {
      systemEvents.push(doc);

      return doc;
    },
  };

  const UserModel = {
    find: () => ({
      select: () => ({
        lean: async () => [{ _id: newId('admin', 1) }],
      }),
    }),
  };

  const PlatformSettingsModel = {
    // Mongoose findOne returns a Query synchronously; .lean() executes it.
    findOne: () => ({
      lean: async () => settings,
    }),
  };

  const notifyFn = async (userId, payload) => {
    notifications.push({ userId, payload });
  };

  const invalidateGateCacheFn = () => {
    counters.gateInvalidations += 1;
  };

  const collaborators = {
    SubscriptionModel,
    PlatformSettingsModel,
    SystemEventModel,
    UserModel,
    recordHistoryFn,
    notifyFn,
    invalidateGateCacheFn,
  };

  return {
    SubscriptionModel,
    historyRows,
    notifications,
    systemEvents,
    counters,
    collaborators,
    run: (nowMs) =>
      lifecycle.runSubscriptionLifecycle({ ...collaborators, nowMs }),
    runConcurrent: (nowMs) =>
      Promise.all(
        Array.from({ length: 2 }, () =>
          lifecycle.runSubscriptionLifecycle({ ...collaborators, nowMs }),
        ),
      ),
  };
};

let WORLD_SEQ = 0;

const daysFromNow = (now, days) => new Date(now + days * DAY);

// ═════════════════════════════════════════════════════════════
//  GRACE_PERIOD transition — concurrent instances converge
// ═════════════════════════════════════════════════════════════

test('two concurrent lifecycle runs produce EXACTLY ONE grace transition with one history row and one notification', async () => {
  const now = Date.now();
  const world = freshWorld();

  const subscription = world.SubscriptionModel.add({
    endDate: daysFromNow(now, -3),
  });

  await world.runConcurrent(now);

  const final = world.SubscriptionModel.docs.find(
    (doc) => doc._id === subscription._id,
  );

  assert.equal(final.status, 'GRACE_PERIOD');
  assert.ok(final.graceEndsAt);
  assert.equal(final.expirationBehavior, 'READ_ONLY');

  const transitionHistory = world.historyRows.filter(
    (row) => row.event === 'SUBSCRIPTION_EXPIRED',
  );

  assert.equal(
    transitionHistory.length,
    1,
    'duplicate concurrent run must NOT duplicate history',
  );
  assert.equal(
    world.notifications.length,
    1,
    'duplicate concurrent run must NOT duplicate admin notifications',
  );
  assert.equal(
    world.counters.gateInvalidations,
    1,
    'gate-cache invalidation fires on the winner only',
  );
  assert.equal(world.systemEvents.length, 0);
});

test('sequential re-runs after the grace transition are fully idempotent', async () => {
  const now = Date.now();
  const world = freshWorld();

  world.SubscriptionModel.add({
    endDate: daysFromNow(now, -3),
  });

  await world.run(now);
  await world.run(now);
  await world.run(now);

  assert.equal(
    world.historyRows.filter((row) => row.event === 'SUBSCRIPTION_EXPIRED')
      .length,
    1,
  );
  assert.equal(world.notifications.length, 1);
});

// ═════════════════════════════════════════════════════════════
//  EXPIRED transition — concurrent instances converge
// ═════════════════════════════════════════════════════════════

test('two concurrent lifecycle runs produce EXACTLY ONE EXPIRED transition (history, notification, SystemEvent)', async () => {
  const now = Date.now();
  const world = freshWorld();

  const subscription = world.SubscriptionModel.add({
    endDate: daysFromNow(now, -30),
  });

  await world.runConcurrent(now);

  const final = world.SubscriptionModel.docs.find(
    (doc) => doc._id === subscription._id,
  );

  assert.equal(final.status, 'EXPIRED');
  assert.equal(final.readOnly, true);

  assert.equal(
    world.historyRows.filter((row) => row.event === 'SUBSCRIPTION_EXPIRED')
      .length,
    1,
  );
  assert.equal(world.notifications.length, 1);
  assert.equal(world.systemEvents.length, 1);
  assert.equal(world.systemEvents[0].type, 'SUBSCRIPTION_EXPIRED');
});

// ═════════════════════════════════════════════════════════════
//  PAST_DUE transition — concurrent instances converge
// ═════════════════════════════════════════════════════════════

test('two concurrent lifecycle runs produce EXACTLY ONE PAST_DUE transition', async () => {
  const now = Date.now();
  const world = freshWorld();

  const subscription = world.SubscriptionModel.add({
    endDate: daysFromNow(now, -1),
    paymentStatus: 'FAILED',
  });

  await world.runConcurrent(now);

  const final = world.SubscriptionModel.docs.find(
    (doc) => doc._id === subscription._id,
  );

  assert.equal(final.status, 'PAST_DUE');
  assert.ok(final.pastDueAt);
  assert.ok(final.pastDueEndsAt);

  assert.equal(
    world.historyRows.filter((row) => row.event === 'SUBSCRIPTION_PAST_DUE')
      .length,
    1,
  );
  assert.equal(world.notifications.length, 1);
});

// ═════════════════════════════════════════════════════════════
//  EXPIRING transition — side-effect-free, claimed once
// ═════════════════════════════════════════════════════════════

test('EXPIRING is claimed exactly once under concurrency and writes no history/notifications', async () => {
  const now = Date.now();
  const world = freshWorld();

  const subscription = world.SubscriptionModel.add({
    endDate: daysFromNow(now, 5),
  });

  await world.runConcurrent(now);

  const final = world.SubscriptionModel.docs.find(
    (doc) => doc._id === subscription._id,
  );

  assert.equal(final.status, 'EXPIRING');
  assert.equal(world.historyRows.length, 0);
  assert.equal(world.notifications.length, 0);
  assert.equal(world.counters.gateInvalidations, 1);
});

// ═════════════════════════════════════════════════════════════
//  Reminders — eventKey dedupe keeps concurrent runs to one send
// ═════════════════════════════════════════════════════════════

test('concurrent reminder runs send the expiry reminder EXACTLY ONCE (eventKey dedupe)', async () => {
  const now = Date.now();
  const world = freshWorld();

  const subscription = world.SubscriptionModel.add({
    endDate: daysFromNow(now, 7),
    status: 'TRIAL',
  });

  await world.runConcurrent(now);

  const final = world.SubscriptionModel.docs.find(
    (doc) => doc._id === subscription._id,
  );

  // TRIAL is intentionally never flipped to EXPIRING.
  assert.equal(final.status, 'TRIAL');

  assert.equal(
    world.historyRows.filter((row) => row.event === 'REMINDER_SENT').length,
    1,
  );
  assert.equal(world.notifications.length, 1);
  assert.equal(world.systemEvents.length, 1);
});

// ═════════════════════════════════════════════════════════════
//  Untouched subscriptions + platform-settings configuration
// ═════════════════════════════════════════════════════════════

test('a subscription far from expiry is left completely untouched', async () => {
  const now = Date.now();
  const world = freshWorld();

  const subscription = world.SubscriptionModel.add({
    endDate: daysFromNow(now, 90),
  });

  await world.run(now);

  const final = world.SubscriptionModel.docs.find(
    (doc) => doc._id === subscription._id,
  );

  assert.equal(final.status, 'ACTIVE');
  assert.equal(final.readOnly, false);
  assert.equal(world.historyRows.length, 0);
  assert.equal(world.notifications.length, 0);
  assert.equal(world.systemEvents.length, 0);
});

test('platform settings drive grace period and reminder days (grace 0 → straight to EXPIRED)', async () => {
  const now = Date.now();
  const world = freshWorld({
    settings: {
      subscription: {
        gracePeriodDays: 0,
        reminderDays: [10],
      },
    },
  });

  const subscription = world.SubscriptionModel.add({
    endDate: daysFromNow(now, -2),
  });

  await world.run(now);

  const final = world.SubscriptionModel.docs.find(
    (doc) => doc._id === subscription._id,
  );

  assert.equal(final.status, 'EXPIRED');
  assert.equal(
    world.historyRows.filter(
      (row) => row.reason === 'Grace period ended',
    ).length,
    1,
  );
  // daysLeft 2 is not in the configured [10] reminder list.
  assert.equal(
    world.historyRows.filter((row) => row.event === 'REMINDER_SENT').length,
    0,
  );
});

// ═════════════════════════════════════════════════════════════
//  Architecture pins — entry-point separation & no memory truth
// ═════════════════════════════════════════════════════════════

test('API server, express app and worker remain separate deployable processes (import pins)', async () => {
  const serverSource = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const workerSource = await readFile(new URL('../src/workers/index.js', import.meta.url), 'utf8');

  // The HTTP entry point never imports worker modules…
  assert.doesNotMatch(serverSource, /from ['"].*workers\//);

  // …the worker entry point never imports the express app…
  assert.doesNotMatch(workerSource, /from ['"].*\/app\.js/);

  // …and the express app never binds a port (listening stays in server.js,
  // so tests and additional instances can create/use it independently).
  assert.doesNotMatch(appSource, /app\.listen\s*\(/);

  // The lifecycle scheduler keeps its process-local double-start guard.
  assert.match(serverSource, /startSubscriptionLifecycle/);
});

test('customer auth holds NO process-memory session or business state', async () => {
  const authSource = await readFile(
    new URL('../src/middlewares/authMiddleware.js', import.meta.url),
    'utf8',
  );
  const tokenSource = await readFile(
    new URL('../src/utils/tokenService.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    authSource,
    /new Map\(/,
    'auth middleware must not keep session state in process memory',
  );
  assert.doesNotMatch(
    tokenSource,
    /new Map\(/,
    'session/token service must not keep session state in process memory',
  );

  // Auth validates the JWT against the SHARED Mongo SecuritySession.
  assert.match(authSource, /SecuritySession\.findOne/);
  assert.match(tokenSource, /SecuritySession/);
});

test('lifecycle transitions are atomic CAS claims guarded against double-start', async () => {
  const lifecycleSource = await readFile(
    new URL('../src/utils/subscriptionLifecycle.js', import.meta.url),
    'utf8',
  );

  assert.match(lifecycleSource, /findOneAndUpdate/);
  assert.match(lifecycleSource, /claimTransition/);
  assert.match(lifecycleSource, /__crewlyPhase20Lifecycle/);
});
