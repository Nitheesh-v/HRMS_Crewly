// ============================================================
//  PHASE 33.12 — CLOSE-OUT INTEGRITY (HERMETIC, READ-ONLY).
//
//  No Redis, no Mongo, no HTTP, no network. This suite reads the repository as
//  text and pins the things a close-out unit is FOR:
//
//    · the verification matrix in docs/PHASE_33_CHAT_HUB.md §22.8 points at
//      tests that ACTUALLY EXIST — a matrix that drifts into fiction is worse
//      than no matrix, because it is trusted;
//    · every matrix row has both a hermetic proof and a live check;
//    · the close-out sections the phase promised are present;
//    · the unit map never again claims a shipped unit is "NOT STARTED";
//    · every runbook keeps its six-part structure (DETECT / IMPACT / DO /
//      DO NOT / VERIFY / ESCALATE) — an incident doc missing VERIFY is a trap;
//    · the phase docs carry no credential-shaped strings;
//    · the chat UI never injects HTML, never prints to the console, and renders
//      an explicit unavailable state instead of pretending;
//    · no test file is orphaned: every chat test file runs under `test:chat`,
//      and everything in `test:chat` also runs in `test:all` (a suite nobody
//      runs is not coverage).
//
//  These are integrity pins, not behaviour pins: they fail when the repository
//  becomes internally inconsistent with itself.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_closeout';
process.env.REDIS_ENABLED ||= 'false';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const HUB = 'docs/PHASE_33_CHAT_HUB.md';
const RUNBOOKS = 'docs/PHASE_33_CHAT_RUNBOOKS.md';

const hub = read(HUB);
const runbooks = read(RUNBOOKS);

// ── §22.8 — the verification matrix ──────────────────────────────────────

const matrixSection = () => {
  const start = hub.indexOf('## 22.8 Verification matrix');
  assert.ok(start > -1, 'the hub must carry the §22.8 verification matrix');

  const end = hub.indexOf('## 22.9', start);

  return hub.slice(start, end > -1 ? end : hub.length);
};

const matrixRows = () =>
  matrixSection()
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .filter((line) => !/^\|\s*(#|:?-{2,})/.test(line));

const matrixReferences = () => {
  const found = [];

  for (const line of matrixRows()) {
    for (const match of line.matchAll(/`([^`]+\.test\.js) › ([^`]+)`/g)) {
      found.push({ file: match[1], name: match[2] });
    }
  }

  return found;
};

test('every matrix row points at a test that exists', () => {
  const references = matrixReferences();

  assert.ok(
    references.length >= 40,
    `the matrix must stay substantial — found ${references.length} test references`,
  );

  const missingFiles = new Set();
  const missingTests = [];
  const seen = new Set();

  for (const { file, name } of references) {
    const key = `${file} › ${name}`;

    if (seen.has(key)) continue;
    seen.add(key);

    const full = path.join(here, file);

    if (!fs.existsSync(full)) {
      missingFiles.add(file);

      continue;
    }

    const source = fs.readFileSync(full, 'utf8');

    // The name must exist as a quoted test title in that file. Matching on the
    // quoted title (not a line prefix) tolerates nested describes/indentation.
    if (!source.includes(`'${name}'`)) missingTests.push(key);
  }

  assert.deepEqual([...missingFiles], [], 'the matrix references a test FILE that does not exist');

  assert.deepEqual(missingTests, [], 'the matrix references test NAMES that do not exist');
});

test('the matrix covers all 14 risk rows and each row keeps a live check', () => {
  const rows = matrixRows();

  assert.equal(rows.length, 14, 'the close-out matrix is 14 rows (12 backend + frontend + docs)');

  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());

    // | # | risk | proof | live check |
    const [, number, risk, proof, live] = cells;

    assert.ok(/^\d+$/.test(number), `row without a number: ${row.slice(0, 40)}`);
    assert.ok(risk.length > 10, `row ${number} has no risk statement`);
    assert.ok(proof.includes('`'), `row ${number} has no hermetic proof`);
    assert.ok(live.length > 10, `row ${number} has no live check — the hermetic column cannot own everything`);
  }

  assert.deepEqual(
    rows.map((row) => row.split('|')[1].trim()),
    Array.from({ length: 14 }, (_, index) => String(index + 1)),
    'matrix rows are numbered 1..14 in order',
  );
});

test('the matrix is honest about what it does NOT prove', () => {
  assert.match(
    matrixSection(),
    /What this matrix does NOT claim\.\*\*[\s\S]{0,400}capacity/i,
    'no capacity claims may ride along with correctness proof',
  );
});

// ── §22 — the close-out sections the phase promised ──────────────────────

test('the hub carries every close-out section 33.12 promised', () => {
  const required = [
    '## 22.1 Purpose and scope',
    '## 22.2 Architecture (one picture)',
    '## 22.3 Data model',
    '## 22.4 REST surface (final, with its limits)',
    '## 22.5 Socket protocol (final, with its limits)',
    '## 22.6 Security posture (Phase 33 as a whole)',
    '## 22.7 Degraded modes (truthful, never silent)',
    '## 22.8 Verification matrix',
    '## 22.9 Deferred / not built (honest list)',
    '## 22.10 Operator entry points',
  ];

  const missing = required.filter((heading) => !hub.includes(heading));

  assert.deepEqual(missing, [], `the close-out summary lost sections: ${missing.join(', ')}`);

  // The architecture must be a picture, not a promise of one.
  assert.match(hub, /## 22\.2[\s\S]{0,900}```/, '§22.2 must carry the topology diagram');
});

test('the unit map never again claims a shipped unit is unstarted', () => {
  assert.ok(
    !/NOT STARTED/.test(hub),
    'every unit 33.1..33.12 is shipped — a stale "NOT STARTED" row is doc rot',
  );

  assert.ok(
    !/NOT BUILT YET/.test(hub),
    'the header must not claim the product features are unbuilt',
  );

  for (const unit of ['33.9', '33.10', '33.11', '33.12']) {
    assert.match(
      hub,
      new RegExp(`\\*\\*${unit}\\*\\*[^\\n]*IMPLEMENTED`),
      `${unit} must be marked IMPLEMENTED · TESTED in the unit map`,
    );
  }
});

// ── runbooks: structure ──────────────────────────────────────────────────

test('every runbook keeps its six-part structure', () => {
  const blocks = runbooks.split(/^## §/m).slice(1);

  assert.ok(blocks.length >= 7, `expected the incident runbooks plus the close-out one, found ${blocks.length}`);

  const required = ['### DETECT', '### IMPACT', '### DO\n', '### DO NOT', '### VERIFY', '### ESCALATE'];

  for (const block of blocks) {
    const title = block.split('\n')[0].trim();

    for (const heading of required) {
      assert.ok(
        block.includes(heading.trim()),
        `runbook "${title}" is missing ${heading.trim()}`,
      );
    }
  }
});

test('the runbooks cover the failure modes this phase promised', () => {
  const expected = [
    'REDIS DOWN',
    'WEBSOCKET BLOCKED',
    'RATE LIMIT SPIKE',
    'MESSAGE SEND FAILURES',
    'ATTACHMENT',
    'MULTI-INSTANCE MISMATCH',
    'LIVE VERIFICATION',
  ];

  for (const topic of expected) {
    assert.ok(
      runbooks.toUpperCase().includes(topic),
      `no runbook covers ${topic}`,
    );
  }

  // The opt-in live procedure must stay opt-in and non-destructive.
  const closeOut = runbooks.split('## §7')[1] || '';

  assert.match(closeOut, /\$env:PORT=/, 'the two-instance procedure must show the PowerShell port switch');
  assert.match(closeOut, /Remove-Item Env:PORT/, 'and how to unset it (a beginner mistake is a stuck env var)');
  // Judge the COMMANDS, not the prose about them: the section explicitly says
  // "no FLUSHALL" in words, and a naive text scan would flag its own warning.
  const commands = [...closeOut.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]).join('\n');

  assert.ok(commands.length > 50, 'the close-out procedure must show real commands');
  assert.ok(!/FLUSHALL|FLUSHDB|KEYS\s+\*/i.test(commands), 'no destructive Redis command may appear in the procedure');
});

// ── secrets: docs and this suite ─────────────────────────────────────────

test('the phase docs carry no credential-shaped strings', () => {
  const samples = [
    { doc: HUB, text: hub },
    { doc: RUNBOOKS, text: runbooks },
  ];

  const patterns = [
    /rediss?:\/\/[^\s`"'<>|]*:[^\s`"'<>|@]*@/i, // redis URL carrying credentials
    /mongodb(\+srv)?:\/\/[^\s`"'<>|]*:[^\s`"'<>|@]*@/i, // mongo URI carrying credentials
    /(JWT_SECRET|FIELD_ENCRYPTION_KEY|CLOUDINARY_API_SECRET|RAZORPAY_KEY_SECRET|SMTP_PASS)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}/i,
    /sk_(live|test)_[A-Za-z0-9]{10,}/, // vendor secret keys
    /AKIA[0-9A-Z]{16}/, // AWS access key id shape
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];

  for (const { doc, text } of samples) {
    for (const pattern of patterns) {
      const match = text.match(pattern);

      assert.equal(
        match,
        null,
        `${doc} appears to contain a credential (${pattern}): ${match?.[0]?.slice(0, 24)}…`,
      );
    }
  }
});

// ── frontend contract ────────────────────────────────────────────────────

test('the chat UI never injects HTML, never prints a token, and renders an explicit unavailable state', () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) return walk(full);

      return /\.(jsx?|tsx?)$/.test(entry.name) ? [full] : [];
    });

  const frontendSrc = path.join(repoRoot, 'Frontend', 'src');
  const files = walk(frontendSrc);

  assert.ok(files.length > 50, `expected a real frontend tree, found ${files.length} files`);

  const injected = files.filter((file) => fs.readFileSync(file, 'utf8').includes('dangerouslySetInnerHTML'));

  assert.deepEqual(injected.map((file) => path.relative(repoRoot, file)), [], 'React escaping is the law — no raw HTML injection anywhere');

  const chatFiles = files.filter((file) => /[\\/](chat)[\\/]/.test(file));

  assert.ok(chatFiles.length >= 10, `expected the chat surface, found ${chatFiles.length} files`);

  const noisy = chatFiles.filter((file) => /console\.(log|info|debug|warn|error)/.test(fs.readFileSync(file, 'utf8')));

  assert.deepEqual(noisy.map((file) => path.relative(repoRoot, file)), [], 'the chat surface must not write to the console (a token could ride along)');

  const chatPage = read('Frontend/src/pages/chat/ChatPage.jsx');

  assert.match(
    chatPage,
    /realtimeStatus === 'unavailable'/,
    'the page must branch on the unavailable state',
  );

  assert.match(
    chatPage,
    /Chat realtime unavailable\. History still loads/,
    'and say it in words the user can act on',
  );
});

// ── no orphaned tests ────────────────────────────────────────────────────

test('every chat test file runs under test:chat, and test:chat runs inside test:all', () => {
  const packageJson = JSON.parse(read('Backend/package.json'));
  const scripts = packageJson.scripts || {};

  const testChat = scripts['test:chat'];
  const testAll = scripts['test:all'];

  assert.ok(testChat, 'test:chat must exist so the phase can be run as one thing');
  assert.ok(testAll, 'test:all is the repo baseline');

  const onDisk = fs
    .readdirSync(here)
    .filter((name) => /^chat.*\.test\.js$/.test(name))
    .concat(['realtimeFoundation.test.js', 'observabilityFoundation.test.js', 'phase33Closeout.test.js']);

  assert.ok(onDisk.length >= 16, `expected the phase's suites on disk, found ${onDisk.length}`);

  const missingFromChat = onDisk.filter((name) => !testChat.includes(name));

  assert.deepEqual(missingFromChat, [], 'a chat test file that test:chat does not run is not coverage');

  // And nothing may hide: everything test:chat runs must run in test:all too.
  const chatFiles = testChat.match(/test\/[A-Za-z0-9._-]+\.test\.js/g) || [];

  assert.ok(chatFiles.length >= 16, 'test:chat must list its files explicitly (no globs that silently match nothing)');

  const hidden = chatFiles.filter((file) => !testAll.includes(file));

  assert.deepEqual(hidden, [], 'test:chat must not hide a suite from test:all');
});

test('the owner documents the phase entry points it ships', () => {
  for (const command of ['npm run config:check', 'npm run chat:blank-check', 'npm run test:chat']) {
    assert.ok(hub.includes(command), `${command} must be documented in the phase hub`);
  }
});
