// ============================================================
//  PHASE 30.1 — BGV PERMISSION MIGRATION (existing tenants)
//
//  New: BGV_CHECK_READ / READ_ALL / ASSIGN / VERIFY / REOPEN and
//  BGV_EVIDENCE_MANAGE.
//
//  Rules honored (capsule §52):
//   - SYSTEM_PERMISSION_VERSION is bumped in permissionService
//     (26 → 27) — never lowered. ensureCompanyRoles handles
//     COMPANY_ADMIN through the all-company default.
//   - This script covers what a default matrix deliberately
//     may NOT do: grant the six permissions to TENANT roles that
//     already held the 27.15 BGV admin rights (COMPANY_ADMIN,
//     HR_MANAGER and any custom role with
//     BACKGROUND_VERIFICATION_MANAGE) and BGV_CHECK_READ only to
//     legacy read-only viewers.
//   - Atomic $addToSet only — no role.save() loops, existing
//     custom permissions preserved, idempotent.
//
//  PowerShell (from Backend/):
//    npm run migrate:bgv30          # apply
//    npm run migrate:bgv30 -- --dry-run
// ============================================================

import '../src/config/loadEnv.js'; // FIRST — before env-snapshotting imports
import mongoose from 'mongoose';
import Permission from '../src/models/Permission.js';
import CompanyRole from '../src/models/CompanyRole.js';
import { ensurePermissions } from '../src/utils/permissionService.js';

const NEW_PERMISSIONS = [
  'BGV_CHECK_READ',
  'BGV_CHECK_READ_ALL',
  'BGV_CHECK_ASSIGN',
  'BGV_CHECK_VERIFY',
  'BGV_CHECK_REOPEN',
  'BGV_EVIDENCE_MANAGE',
];

const dryRun = process.argv.includes('--dry-run');

const run = async () => {
  // DB Logics - permission catalog first, then tenant roles.
  await ensurePermissions();
  const permissionId = async (name) => {
    const doc = await Permission.findOne({ name, isActive: true }).lean();
    return doc?._id || null;
  };

  const [manageId, readId] = await Promise.all([
    permissionId('BACKGROUND_VERIFICATION_MANAGE'),
    permissionId('BACKGROUND_VERIFICATION_READ'),
  ]);
  const newIds = (await Promise.all(NEW_PERMISSIONS.map(permissionId))).filter(Boolean);
  const readOnlyId = await permissionId('BGV_CHECK_READ');

  if (!manageId || !readId || !newIds.length) {
    console.warn('BGV30 migration: permission catalog incomplete — run the API once (ensurePermissions seeds it), then retry.');
    return;
  }

  const adminFilter = { permissions: manageId, $nor: [{ permissions: newIds[0] }] };
  const readerFilter = { permissions: { $all: [readId], $nin: [manageId] } };

  const adminCount = await CompanyRole.countDocuments(adminFilter);
  const readerCount = await CompanyRole.countDocuments(readerFilter);

  if (dryRun) {
    console.log(
      `BGV30 dry-run: ${adminCount} admin role(s) would gain all 6 permissions, ` +
        `${readerCount} read-only role(s) would gain BGV_CHECK_READ. No writes performed.`
    );
    return;
  }

  // Atomic $addToSet only — idempotent, custom permissions preserved.
  const admins = await CompanyRole.updateMany(adminFilter, { $addToSet: { permissions: { $each: newIds } } });
  const readers = await CompanyRole.updateMany(readerFilter, { $addToSet: { permissions: readOnlyId } });

  console.log(
    `BGV30 migration done: ${admins.modifiedCount} admin role(s) updated, ${readers.modifiedCount} read-only role(s) updated.`
  );
};

try {
  await mongoose.connect(process.env.MONGO_URI);
  await run();
  await mongoose.disconnect();
} catch (error) {
  console.error(`BGV30 migration failed: ${error.message}`);
  await mongoose.connection.close().catch(() => {});
  process.exitCode = 1;
}
