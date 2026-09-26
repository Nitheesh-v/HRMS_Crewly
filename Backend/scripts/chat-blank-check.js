#!/usr/bin/env node
// ============================================================
// Phase 33.10-fix2 — Blank-message auditor (developer command)
//
//   npm run chat:blank-check
//
// WHAT THIS IS
//   A read-only scan for rows that CANNOT RENDER: no visible body and
//   no attachment reference. Those rows are how the blank chat bubble
//   of 2026-09-26 happened — a body made of zero-width characters
//   (\u200B and friends) passes trim(), so it was stored and every
//   member saw an empty bubble with only a timestamp.
//
//   The rule is the product's own (src/utils/chatTextRules.js), so the
//   scan cannot disagree with what the API now refuses on write.
//
// WHAT THIS IS NOT
//   · it never writes, never deletes, never tombstones. Cleanup is a
//     product decision through the normal delete path (audited, keeps
//     seq) — see docs/PHASE_33_CHAT_HUB.md §18.5
//   · it prints no message bodies. An invisible body is reported as a
//     bounded code-point summary, which is the diagnosis an operator
//     actually needs.
//
// EXIT CODES
//   0  no blank rows found
//   1  blank rows found (or the scan could not run)
// ============================================================

import '../src/config/loadEnv.js'; // FIRST — before env-snapshotting imports

import mongoose from 'mongoose';

import ChatMessage from '../src/models/ChatMessage.js';
import { hasVisibleText } from '../src/utils/chatTextRules.js';

const EXAMPLE_LIMIT = 20;
const CODE_POINT_LIMIT = 8;

const codePoints = (value) => {
  const points = [...String(value ?? '')]
    .slice(0, CODE_POINT_LIMIT)
    .map((character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ');

  return points || '(empty)';
};

const isBlank = (row) =>
  !hasVisibleText(row?.text) &&
  (!Array.isArray(row?.attachments) || row.attachments.length === 0);

const main = async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — nothing to scan. See Backend/.env.example.');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  let scanned = 0;
  let blank = 0;

  const cursor = ChatMessage.find({})
    .select('type text attachments conversationId seq createdAt deletedAt')
    .lean()
    .cursor();

  for await (const row of cursor) {
    scanned += 1;

    // A tombstone is SUPPOSED to carry no body: deletedAt is its render.
    if (row.deletedAt) continue;

    if (!isBlank(row)) continue;

    blank += 1;

    if (blank <= EXAMPLE_LIMIT) {
      console.log(
        [
          `- _id=${row._id}`,
          `conversationId=${row.conversationId}`,
          `type=${row.type}`,
          `seq=${row.seq}`,
          `createdAt=${row.createdAt?.toISOString?.() ?? row.createdAt}`,
          `body=[${codePoints(row.text)}]`,
          `attachments=${Array.isArray(row.attachments) ? row.attachments.length : 0}`,
        ].join(' '),
      );
    }
  }

  console.log('');
  console.log(`scanned ${scanned} message(s); ${blank} cannot render.`);

  if (blank > EXAMPLE_LIMIT) {
    console.log(`(first ${EXAMPLE_LIMIT} listed)`);
  }

  if (blank > 0) {
    console.log('');
    console.log('These rows are legacy data: the API now refuses to write one.');
    console.log('They render as "This message could not be displayed" — delete them');
    console.log('through the product (sender or moderator delete), never with a');
    console.log('script, so the tombstone and audit trail stay intact.');
    process.exitCode = 1;
  }
};

main()
  .catch((error) => {
    console.error(`blank-message scan failed: ${error?.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
