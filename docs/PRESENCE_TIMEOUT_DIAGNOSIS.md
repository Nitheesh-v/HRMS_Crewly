# Diagnose the 25s timeout on the presence save endpoint

If the user is seeing `timeout of 25000ms exceeded` when they click
"Save status" in the topbar, the backend `/api/presence/me/status` is
taking longer than 25s. The frontend axios default is 25s.

## Most likely causes (in order)

1. **Mongo is on a remote host with high latency** — every save is 4
   round-trips (config read, upsert, config read, findOne). On a 200ms
   ping, that's ~800ms. On a 1s+ ping, that's 4s+. 25s is more than
   that, but the per-op timeout might add up.
2. **Missing Mongo index** — the unique compound index on
   `{ companyId, userId }` is defined in the model, but if Mongo
   didn't apply it (e.g. older collection), each save is a full
   collection scan.
3. **A stuck Mongo connection** — restart Mongo.
4. **The 37.4 realtime bus is hanging** — the controller publishes
   after the save; if Redis is unreachable, the publish could block.

## Quick diagnosis — run these in the backend dir

```bash
# 1. Confirm Mongo is reachable
node -e "
  const m = require('mongoose');
  m.connect(process.env.MONGO_URI).then(async () => {
    const t = Date.now();
    await m.connection.db.admin().ping();
    console.log('ping took', Date.now() - t, 'ms');
    process.exit(0);
  });
"
# Expected: <50ms on a healthy Mongo.

# 2. Confirm the compound index exists on userpresences
node -e "
  const m = require('mongoose');
  m.connect(process.env.MONGO_URI).then(async () => {
    const idx = await m.connection.collection('userpresences').indexes();
    console.log(JSON.stringify(idx, null, 2));
    process.exit(0);
  });
"
# Expected: a compound index { companyId: 1, userId: 1 } with unique:true.

# 3. Time a single findOne on userpresences
node -e "
  const m = require('mongoose');
  m.connect(process.env.MONGO_URI).then(async () => {
    const t = Date.now();
    const doc = await m.connection.collection('userpresences')
      .findOne({ companyId: 'PASTE_COMPANY_OBJECTID', userId: 'PASTE_USER_OBJECTID' });
    console.log('query took', Date.now() - t, 'ms; found:', !!doc);
    process.exit(0);
  });
"
# Expected: <20ms with the index; >500ms means Mongo is doing a full scan.

# 4. Time a single findOneAndUpdate on presencetenantconfigs
node -e "
  const m = require('mongoose');
  m.connect(process.env.MONGO_URI).then(async () => {
    const t = Date.now();
    const doc = await m.connection.collection('presencetenantconfigs')
      .findOneAndUpdate(
        { companyId: 'PASTE_COMPANY_OBJECTID' },
        { \$setOnInsert: { companyId: 'PASTE_COMPANY_OBJECTID' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    console.log('query took', Date.now() - t, 'ms');
    process.exit(0);
  });
"
# Expected: <20ms with the index; >500ms means the index is missing.
```

## If the queries are slow — add the index manually

```js
// In a one-off script (run ONCE, not in the app code):
db.userpresences.createIndex(
  { companyId: 1, userId: 1 },
  { unique: true, name: 'company_user_unique' }
);
db.presencetenantconfigs.createIndex(
  { companyId: 1 },
  { unique: true, name: 'company_unique' }
);
```

## If Mongo is fine but the API still times out

The 37.4 realtime publish is the next suspect. Temporarily disable it
by setting `REALTIME_ENABLED=false` in your backend `.env` and retry
the save. If the save is fast, the publish is the culprit — check
Redis is up and `REDIS_URL` is correct.

## The endpoint pipeline

`PUT /api/presence/me/status` runs in this order:

1. `protect` (JWT verify, no I/O) — <5ms
2. `tenantContext` (extract companyId, no I/O) — <1ms
3. `presenceStatusValidator` (body shape, no I/O) — <1ms
4. `presenceController.putStatus`:
   - `service.setMyStatus`:
     - `tenantConfigReader` (1 Mongo read) — should be <20ms
     - `upsertUserPresence` (1 Mongo write) — should be <20ms
     - `getMyPresence`:
       - `tenantConfigReader` (1 Mongo read) — <20ms
       - `readUserPresence` (1 Mongo read) — <20ms
       - `liveStore.readLive` (1 Redis read) — <5ms
   - `safePublishIfChanged` (1 Redis publish) — <5ms
5. Response — <1ms

Total expected: <100ms. Anything >1s is wrong; 25s is very wrong.

## How to share findings

Run the four commands above, paste the output. I can pinpoint the
slow step from the timings.
