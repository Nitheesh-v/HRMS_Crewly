// ═══════════════════════════════════════════════════════════════════════════
// ATTENDANCE CAPTURE SURFACES — Import · Validation · Kiosk Stations · QR
//
// The four v3 capture screens were re-cut against the Stitch exports in
// /stitch-attendance/v3. Those mocks describe a product with device
// heartbeats, firmware versions, MDM posture, a live scan feed, a per-scan
// audit log, a parser-engine version and a per-row "ignore row" action.
// None of that exists in the API, so the pages keep the mock's blocks and
// replace its numbers with the operators' own truth:
//
//   · every figure is a value the response returned, or the word "—";
//   · a block with no endpoint names the endpoint it would need;
//   · the only telemetry claims made are the ones the API really makes;
//   · a rejected import row is stated as "not written", never "queued";
//   · a station secret / QR token is shown once and never re-exposed.
//
// The pins below hold those rules in place. They are cheap greps, but each
// one stands for a sentence a reviewer would otherwise have to trust.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const importPage = read('src/pages/attendance/AttendanceImportPage.jsx');
const validationPage = read('src/pages/attendance/AttendanceImportValidationPage.jsx');
const kioskPage = read('src/pages/attendance/KioskStationsPage.jsx');
const qrPage = read('src/pages/attendance/QrChallengesPage.jsx');
const captureService = read('src/services/attendanceCaptureService.js');
const routes = read('src/routes/AppRoutes.jsx');

const pages = [
  ['attendance import', importPage],
  ['import validation', validationPage],
  ['kiosk stations', kioskPage],
  ['qr challenges', qrPage],
];

const has = (source, needle, why) =>
  assert.ok(source.includes(needle), `${why} — expected to find: ${needle}`);
const hasNot = (source, needle, why) =>
  assert.ok(!source.includes(needle), `${why} — must not contain: ${needle}`);

describe('attendance capture surfaces — one product, one token set', () => {
  test('all four screens sit in the Warm Organic scope', () => {
    for (const [name, source] of pages) {
      has(source, 'st-surface', `${name} uses the st- surface token`);
      has(source, 'bg-st-lowest', `${name} builds cards from st- tokens`);
      hasNot(source, 'bg-white/', `${name} has no dark-only white wash`);
      hasNot(source, 'border-white/', `${name} has no dark-only white hairline`);
      assert.equal(/crewly-/.test(source), false, `${name} is migrated off crewly- tokens`);
      assert.equal(/className="card\b/.test(source), false, `${name} builds its own surfaces`);
    }
  });

  test('the validation screen is a real, HR-guarded route', () => {
    has(routes, 'attendance/imports/validation', 'the staging review route is registered');
    has(routes, 'AttendanceImportValidationPage', 'and lazily imported');
    has(importPage, '/app/attendance/imports/validation', 'the upload screen hands off to it');
    has(importPage, 'state: { fileName: file.name, fileSize: file.size, file, preview }',
      'router state carries the File itself, because the bytes are never stored server-side');
  });

  test('the stage screen degrades honestly without router state', () => {
    has(validationPage, 'No staged batch in this session', 'a refreshed URL gets a real empty state');
    has(validationPage, 'the raw CSV is never stored on the server', 'and the reason, not a spinner');
    has(validationPage, 'const staged = location.state || null', 'the page reads the router state');
  });
});

describe('attendance import — upload, review, commit', () => {
  test('nothing is claimed about a device the batch is not', () => {
    has(importPage, 'What this screen will not claim', 'the honesty rail is kept');
    has(importPage, 'No device sync trace', 'device telemetry is named as absent');
    has(importPage, 'no terminal heartbeat', 'heartbeat is named as absent');
    has(importPage, 'no terminal heartbeat', 'the reader strip says it too');
  });

  test('the schema rail is the server’s own template, not a hand-copy', () => {
    has(captureService, 'templateText:', 'the template is readable as text');
    has(captureService, '/attendance/imports/template.csv', 'and comes from the CSV endpoint');
    has(importPage, 'templateText()', 'the page renders that text');
    has(importPage, 'employeeCode', 'with the real header column');
    has(importPage, "required: true", 'and marks which columns are mandatory');
  });

  test('the history ledger is the API list, opened through the detail endpoint', () => {
    has(importPage, 'listImports()', 'the ledger rows are the API list');
    has(importPage, 'getImport(', 'the drawer fetches the batch the list omits outcomes for');
    has(importPage, 'Download template CSV', 'the mock’s download action survives');
  });

  test('validation is computed server-side, never re-implemented in the page', () => {
    has(importPage, 'previewImport(file)', 'the preview is a server round trip');
    has(validationPage, 'confirmImport(file)', 'so is the commit');
    has(validationPage, 'MAX_CHUNK_CALLS', 'the commit is chunked and resumable');
    has(validationPage, "data?.done || data?.status !== 'CONFIRMING'", 'and stops on the server’s own signal');
    has(validationPage, 'processedCount', 'progress comes from the response');
  });

  test('a rejected row is never dressed up as queued work', () => {
    has(validationPage, 'will not be written', 'the card says the row is dropped');
    has(validationPage, 'no “route to exception queue” endpoint', 'and that no queue exists');
    hasNot(validationPage, 'Send to exception', 'the mock’s unavailable action is not rendered');
    hasNot(validationPage, 'Ignore row', 'nor the per-row ignore');
    has(validationPage, 'guidanceFor', 'the row instead gets advice, which is not data');
  });

  test('a successful commit is never reported as an error', () => {
    has(validationPage, 'notify.success(', 'the success path toasts success');
    has(validationPage, 'notify.warning(', 'a partial commit warns rather than fails');
    assert.equal(
      /notify\.error\([^)]*Imported \$\{/.test(validationPage),
      false,
      'an import that wrote rows can never be announced as an error',
    );
  });

  test('the commit count excludes rows the ledger already holds', () => {
    has(validationPage, 'const freshCount = validRows.length - alreadyCount', 'skips are not promised as writes');
    has(validationPage, 'const alreadyCount = validRows.filter((row) => row.alreadyRecorded).length', 'from the server flag');
  });
});

describe('kiosk stations — device trust without surveillance', () => {
  test('the station list is the API, and the secret is written once', () => {
    has(kioskPage, 'listStations()', 'the fleet is the API list');
    has(kioskPage, 'createStation(', 'registering is a real call');
    has(kioskPage, 'rotateStationSecret(', 'rotation is a real call');
    has(kioskPage, 'updateStation(', 'activate/deactivate is a real call');
    has(kioskPage, 'shown once', 'the secret is labelled one-time');
    has(kioskPage, 'It is hashed at rest and never shown again', 'and its storage is described truthfully');
  });

  test('no hardware telemetry is invented', () => {
    has(kioskPage, 'No heartbeat or firmware state exists', 'the table footer says what is missing');
    has(kioskPage, 'Punch telemetry', 'the mock’s tile is kept');
    has(kioskPage, 'refuses to invent one', 'and refuses to fill it');
    hasNot(kioskPage, 'latency:', 'no invented latency metric');
    hasNot(kioskPage, 'firmware:', 'no invented firmware field');
  });

  test('permissions degrade to a sentence, not an error toast', () => {
    has(kioskPage, 'ATTENDANCE_CAPTURE_MANAGE', 'the page checks the permission that owns it');
    has(kioskPage, 'don’t have the attendance-capture permission', 'and explains the gate');
  });

  test('deactivation is described as immediate, which is what the backend does', () => {
    has(kioskPage, 'stops working immediately', 'or its session stops at the next call');
    has(kioskPage, 'Every kiosk session on this station stops working immediately', 'rotate is explicit about revocation');
  });
});

describe('qr challenges — issuing, not surveilling', () => {
  test('the challenge is issued through the API and bound to a place', () => {
    has(qrPage, 'createChallenge(', 'issuing is the real endpoint');
    has(qrPage, 'locationId', 'a location binding is offered');
    has(qrPage, 'stationId', 'so is a station binding');
    has(qrPage, 'disabled={issuing || (!locationId && !stationId)}', 'and an unbound challenge cannot be submitted');
  });

  test('the TTL is the server’s five minutes, not a picker', () => {
    has(qrPage, 'const TTL_MINUTES = 5', 'the window is a constant');
    has(qrPage, 'Fixed server-side by the QR rules', 'and says so where a picker would be');
    has(qrPage, 'no 2/10-minute option to pick', 'naming the mock control that does not exist');
  });

  test('telemetry that has no endpoint is shown as a link, not a feed', () => {
    has(qrPage, 'no per-scan feed to subscribe to', 'the missing feed is stated');
    has(qrPage, 'Not exposed', 'the block is labelled');
    has(qrPage, '/app/security/audit-logs', 'the real audit trail is linked');
    has(qrPage, 'ATTENDANCE_QR_CHALLENGE_CREATED', 'by its real action name');
    has(qrPage, 'analyticsOverview', 'the real capture mix is read');
    hasNot(qrPage, 'setInterval(() => push', 'and no fake live feed is simulated');
  });

  test('the token and the secret are both one-way', () => {
    has(qrPage, 'the server keeps its sha-256', 'the token hash story is stated');
    has(qrPage, 'No token is ever logged', 'and the logging rule');
    has(qrPage, 'No HMAC chip', 'the mock’s unbacked chips are refused');
    has(qrPage, 'No Wi-Fi BSSID check', 'including the network one');
  });
});
