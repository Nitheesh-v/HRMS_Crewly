// ============================================================
// PHASE 39 — notification tenancy repair (owner-run, opt-in)
//
//   npm run notifications:repair            → DRY RUN (writes nothing)
//   npm run notifications:repair -- --apply → rewrites the mismatched rows
//
// WHY THIS EXISTS
//   Before Phase 39, the in-app write path cloned the newest
//   Notification row in the whole database and overwrote only
//   user/title/message/link. Every notification written that way
//   therefore carries:
//     · another tenant's `companyId`
//     · another category's `type`
//     · another logical event's `eventKey`
//   The bell still shows them (it reads by `user` alone), so this is
//   not urgent — but the tenant id is wrong on disk, and an inherited
//   `eventKey` can make a FUTURE legitimate notification fail the
//   unique `{ companyId, eventKey }` index and silently vanish.
//
// WHAT IT DOES
//   For every notification whose `companyId` differs from its
//   recipient's own companyId:
//     · companyId := the recipient's company
//     · eventKey  := null   (it belonged to a different logical event,
//                            so keeping it is both wrong and a
//                            duplicate-key hazard once rows share a
//                            tenant)
//
// WHAT IT DELIBERATELY DOES NOT DO
//   · never deletes anything
//   · never touches a row that is already correct
//   · never touches rows whose recipient no longer exists (reported only)
//   · never prints titles, names, emails or message bodies — counts and
//     document ids only
//
// EXIT CODES
//   0 — nothing to repair, or the repair was applied
//   1 — dry run found rows to repair (so a checklist can gate on it)
//   2 — the script could not run (no MONGO_URI / connection failure)
//
// Idempotent: running it twice is the same as running it once.
// ============================================================

import '../src/config/loadEnv.js'; // FIRST — before env-snapshotting imports

import mongoose from 'mongoose';
import {
  classifyNotificationRows,
  buildRepairUpdate,
} from '../src/utils/notificationRepair.js';

const APPLY = process.argv.includes('--apply');
const SAMPLE_LIMIT = 10;

const short = (value) => String(value ?? '').slice(0, 8);

const main = async () => {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error('✖ MONGO_URI is not set (see Backend/.env.example). Nothing was read or written.');
    process.exit(2);
  }

  // Fail fast when the database is not reachable: the default 30s server
  // selection would leave the operator staring at a blank terminal.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log('✔ connected');

  const notifications = mongoose.connection.collection('notifications');
  const users = mongoose.connection.collection('users');

  const total = await notifications.countDocuments({});

  // One aggregation pairs every notification with its recipient. `$lookup`
  // then `$unwind` with preserveNullAndEmptyArrays so a deleted recipient
  // shows up as an orphan instead of disappearing from the report.
  const rows = await notifications
    .aggregate([
      {
        $lookup: {
          from: users.collectionName,
          localField: 'user',
          foreignField: '_id',
          as: 'recipient',
        },
      },
      { $unwind: { path: '$recipient', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          companyId: 1,
          eventKey: 1,
          recipientCompanyId: '$recipient.companyId',
        },
      },
    ])
    .toArray();

  // The rules live in src/utils/notificationRepair.js so they can be tested
  // without a database. This script only reads, reports and (on --apply) writes.
  const { correct, mismatched, orphans, inheritedKeys } = classifyNotificationRows(rows);

  console.log(`\nscanned      ${total} notification(s)`);
  console.log(`correct      ${correct}`);
  console.log(`mismatched   ${mismatched.length}   (recipient belongs to a different tenant than the row)`);
  console.log(`  └ of those with an inherited eventKey: ${inheritedKeys}`);
  console.log(`orphaned     ${orphans.length}   (recipient no longer exists — reported, never touched)`);

  if (mismatched.length) {
    console.log('\nsample (ids only):');
    mismatched.slice(0, SAMPLE_LIMIT).forEach((row) => {
      console.log(
        `  ${short(row._id)}…  companyId ${short(row.companyId)}… → ${short(row.recipientCompanyId)}…`,
      );
    });
    if (mismatched.length > SAMPLE_LIMIT) {
      console.log(`  … and ${mismatched.length - SAMPLE_LIMIT} more`);
    }
  }

  if (!mismatched.length) {
    console.log('\n✔ nothing to repair');
    await mongoose.disconnect();
    return 0;
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written.');
    console.log('Re-run with:  npm run notifications:repair -- --apply');
    await mongoose.disconnect();
    return 1;
  }

  let updated = 0;
  let failed = 0;

  for (const row of mismatched) {
    try {
      await notifications.updateOne({ _id: row._id }, buildRepairUpdate(row));
      updated += 1;
    } catch (error) {
      failed += 1;
      console.error(`  ✖ ${short(row._id)}… ${error.message}`);
    }
  }

  console.log(`\n✔ applied: ${updated} updated, ${failed} failed, ${orphans.length} orphaned left alone`);
  await mongoose.disconnect();
  return failed ? 2 : 0;
};

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error(`✖ repair did not complete: ${error.message}`);
    try {
      await mongoose.disconnect();
    } catch {
      /* already gone */
    }
    process.exit(2);
  });
