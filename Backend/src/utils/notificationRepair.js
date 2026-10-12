// ─────────────────────────────────────────────────────────────
// PHASE 39 — the decision rules behind scripts/notifications-repair.js
//
// Split out of the script on purpose: the script talks to a live
// database (owner-run, opt-in), but WHAT COUNTS AS A REPAIR is a
// pure function, and a pure function can be pinned by tests. Nobody
// should have to run a write tool to find out what it would do.
// ─────────────────────────────────────────────────────────────

/**
 * Split notification rows (each already paired with its recipient's company)
 * into the three groups the repair cares about.
 *
 * A row is `mismatched` when the recipient exists and the row's `companyId`
 * is not the recipient's. A row is `orphaned` when the recipient document is
 * gone — those are reported and never touched, because there is no tenant to
 * repair them TO.
 *
 * @param {Array<{_id:*, companyId:*, eventKey?:*, recipientCompanyId:*}>} rows
 * @returns {{ correct: number, mismatched: Array, orphans: Array, inheritedKeys: number }}
 */
export const classifyNotificationRows = (rows = []) => {
  const mismatched = [];
  const orphans = [];
  let correct = 0;

  for (const row of rows || []) {
    if (!row?.recipientCompanyId) {
      orphans.push(row);
      continue;
    }

    if (String(row.companyId) === String(row.recipientCompanyId)) {
      correct += 1;
      continue;
    }

    mismatched.push(row);
  }

  return {
    correct,
    mismatched,
    orphans,
    // Counted for the report: these rows also carry another logical event's
    // key, which is the part that can collide with a UNIQUE index.
    inheritedKeys: mismatched.filter((row) => Boolean(row.eventKey)).length,
  };
};

/**
 * The update a repair writes for ONE mismatched row.
 *
 * `eventKey` is cleared rather than kept: before Phase 39 an inherited key was
 * copied from an unrelated event, so it is wrong regardless of the tenant — and
 * leaving it risks a duplicate-key rejection on `{ companyId, eventKey }` as
 * soon as two rows land in the same tenant.
 */
export const buildRepairUpdate = (row) => ({
  $set: {
    companyId: row.recipientCompanyId,
    eventKey: null,
  },
});
