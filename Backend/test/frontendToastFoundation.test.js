// ============================================================
//  PHASE 35.1 — APP-WIDE FEEDBACK (TOASTS). HERMETIC.
//
//  No browser, no bundle, no network: these are SOURCE PINS over the shipped
//  frontend, the same technique the 34.x suites use for frontend contracts.
//
//  WHY PINS AND NOT A COMPONENT TEST
//    The contract of this unit is not "does sonner render a div" — that is
//    sonner's job and its own tests. The contract that can silently rot in
//    THIS repo is:
//      · there is exactly ONE feedback channel, and it is reachable from
//        React, from an axios interceptor and from a socket callback;
//      · a failed request cannot fail silently, and cannot report itself
//        twice;
//      · the blocking browser dialogs are gone and cannot come back;
//      · nobody re-invents a private banner channel beside the toast stack;
//      · the retry affordances that ARE structural (a page that could not
//        load its data) were not swept away with the message banners;
//      · the surfaces the sweep touched keep their safety rails (no emoji in
//        the new UI, the session-expiry card, the login arrival notice).
//
//  PINNED BEHAVIOUR
//    · sonner is the only toast dependency and only utils/notify.js imports it.
//    · notify.js is React-free (a file with hooks cannot be called from an
//      axios interceptor) and exposes the documented surface.
//    · Identical errors coalesce: one error card per burst, last writer wins.
//    · The failure reporter skips exactly four things: cancelled requests,
//      requests opted out with `skipErrorToast`, the refresh plumbing, and a
//      session that just ended (a public auth 401 is still reported).
//    · One latch per endpoint: a dead poll raises one card, and the same
//      endpoint answering again re-arms it.
//    · Both axios clients are covered: the shared customer client in
//      services/api.js and the default client used by the seven services that
//      keep their own instance.
//    · window.alert is extinct, and no page keeps a private banner channel.
//    · The six attendance retry banners survive, and the login arrival notice
//      still reaches the person.
//    · No emoji in the toast layer (the new-UI rule, 34.x line).
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const frontend = path.join(root, 'Frontend');

const read = (...parts) => fs.readFileSync(path.join(frontend, ...parts), 'utf8');

const exists = (...parts) => fs.existsSync(path.join(frontend, ...parts));

const walk = (dir) => {
  const out = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.jsx?$/.test(entry.name)) {
      out.push(full);
    }
  }

  return out;
};

const PAGES = path.join(frontend, 'src', 'pages');
const SRC = path.join(frontend, 'src');

const pageFiles = walk(PAGES);
const srcFiles = walk(SRC);

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F2FF}]/u;

const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('sonner is the only toast dependency, and only notify.js imports it', () => {
  const pkg = JSON.parse(read('package.json'));

  assert.ok(pkg.dependencies?.sonner, 'sonner is a declared dependency');
  assert.equal(pkg.dependencies['react-hot-toast'], undefined);
  assert.equal(pkg.dependencies['react-toastify'], undefined);

  const importers = srcFiles.filter((file) => /from 'sonner'/.test(fs.readFileSync(file, 'utf8')));

  const allowed = new Set([
    path.join(SRC, 'utils', 'notify.js'),
    path.join(SRC, 'components', 'AppToaster.jsx'),
  ]);

  const unexpected = importers.filter((file) => !allowed.has(file));

  assert.deepEqual(
    unexpected.map((file) => path.relative(frontend, file)),
    [],
    'only notify.js and its host may import sonner directly',
  );
});

test('notify.js is React-free and exposes the documented surface', () => {
  const source = readSrc('utils/notify.js');

  assert.ok(!/from 'react'/.test(source), 'a hook-based module cannot be called from an interceptor');

  for (const member of ['success(', 'info(', 'warning(', 'error(', 'successFrom(', 'run(', 'dismiss(', 'clear(', 'resetDedupe(']) {
    assert.ok(source.includes(member), `notify.${member.replace('(', '')} is part of the API`);
  }

  assert.match(source, /const DURATION = \{/, 'durations live in one place');
  assert.match(source, /const ERROR_COALESCE_MS = \d+/, 'the one-card-per-burst window is explicit');
  assert.match(source, /toast\.dismiss\(lastErrorCard\.id\)/, 'a second error replaces the card on screen');

  for (const kind of ['success', 'info', 'warning', 'error']) {
    assert.match(source, new RegExp(`${kind}: \\d+`), `${kind} has an explicit duration`);
  }
});

test('the toast host is mounted once, in the dark theme, and owns the session card', () => {
  const app = readSrc('App.jsx');
  const host = readSrc('components/AppToaster.jsx');

  assert.equal((app.match(/<AppToaster \/>/g) || []).length, 1, 'exactly one host, above the routes');
  assert.ok(host.includes("from 'sonner'"), 'the host renders sonner');
  assert.equal((host.match(/<Toaster/g) || []).length, 1);
  assert.ok(host.includes('theme="dark"'), "the cards sit on Crewly's dark shell");
  assert.ok(host.includes('crewly:auth-expired'), 'the auth-expiry event has one listener');
  assert.ok(host.includes('Session expired'), 'the person is told why they landed on the login screen');
});

test('the failure reporter skips exactly four things and never rewrites the error', () => {
  const source = readSrc('services/failureReporter.js');

  assert.match(source, /axios\.isCancel\(error\)/, 'a cancelled request is not a failure to report');
  assert.match(source, /config\.skipErrorToast === true/, 'a call site may own its message');
  assert.match(source, /QUIET_PATHS = \['\/auth\/refresh'\]/, 'the refresh plumbing is not a message');
  assert.match(source, /PUBLIC_AUTH_PATHS/, 'a login 401 IS an answer (bad password) and is reported');
  assert.match(source, /status === 401 && !matchesAny\(url, PUBLIC_AUTH_PATHS\)/, 'session death is the session card');

  assert.match(source, /const openFailures = new Map\(\)/, 'one latch per endpoint');
  assert.match(source, /openFailures\.delete\(requestKeyOf\(config\)\)/, 'a healthy endpoint re-arms the latch');
  assert.match(source, /return Promise\.reject\(error\)/, 'the reporter observes; it never rewrites the error');
  assert.ok(!source.includes('normalizeError'), 'normalisation stays in api.js — one job per module');
});

test('both axios clients are covered', () => {
  const api = readSrc('services/api.js');
  const main = readSrc('main.jsx');

  assert.ok(api.includes('attachFailureReporter(api)'), 'the shared customer client is covered');
  assert.match(
    main,
    /attachFailureReporter\(axios\)/,
    'the seven services that keep their own axios instance are covered too',
  );

  const ownClient = fs
    .readdirSync(path.join(SRC, 'services'))
    .filter((name) => /\.js$/.test(name))
    .filter((name) => /^import axios from 'axios';/m.test(fs.readFileSync(path.join(SRC, 'services', name), 'utf8')));

  assert.ok(
    ownClient.length >= 5,
    `the raw-axios services still exist (${ownClient.length} found) — the default-client attach is what covers them`,
  );
});

test('the blocking browser dialogs are extinct', () => {
  const offenders = db =>
    db
      .filter((file) => /(^|[^.\w])alert\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(frontend, file));

  assert.deepEqual(offenders(srcFiles), [], 'no window.alert survives anywhere in the app');
});

test('the private flash() helpers now feed the toast layer, not a banner', () => {
  const offenders = [];
  let helpers = 0;

  for (const file of srcFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(frontend, file);
    const at = source.indexOf('const flash =');

    if (at !== -1) {
      helpers += 1;

      const body = source.slice(at, source.indexOf('};', at) + 2);

      if (!/notify\./.test(body)) {
        offenders.push(`${rel}: flash() no longer reports`);
      }

      if (/setBanner|setToast/.test(body)) {
        offenders.push(`${rel}: flash() still parks a banner in the page flow`);
      }
    }

    if (/setBanner\(\{\s*(type|ok)\s*:/.test(source)) {
      offenders.push(`${rel}: builds its own banner object`);
    }
  }

  assert.ok(helpers >= 20, `the converted helpers are still in place (${helpers} found)`);
  assert.deepEqual(offenders, [], 'every flash() reports through notify() and nothing else');

  /*
   * ONE INTENTIONAL SURVIVOR, PINNED SO IT IS NOT MISTAKEN FOR LEFTOVER:
   * the payroll analytics pages share `Banner` from analyticsShared.jsx, which
   * renders an export-queue notice with a Dismiss button (a queued job, not a
   * message echo). It stays inline; ExportMenu raises the toast for the same
   * action.
   */
  const analytics = fs.readFileSync(
    path.join(PAGES, 'payroll', 'analytics', 'analyticsShared.jsx'),
    'utf8',
  );

  assert.match(analytics, /export const Banner = /, 'the shared export notice still exists');
  assert.match(
    analytics,
    /notify\.success\(result\?\.message/,
    'and the export itself reports through the toast layer',
  );
});

test('structural retry affordances were kept, not swept away with the message banners', () => {
  const RETRY_PAGES = [
    'attendance/AttendancePage.jsx',
    'attendance/AttendanceTeamPage.jsx',
    'attendance/AttendanceAnalyticsPage.jsx',
    'attendance/AttendanceOperationsPage.jsx',
    'attendance/AttendanceTimesheetPage.jsx',
    'attendance/AttendanceTeamTimesheetsPage.jsx',
  ];

  for (const rel of RETRY_PAGES) {
    const source = fs.readFileSync(path.join(PAGES, rel), 'utf8');

    assert.ok(
      /\{error && \(/.test(source),
      `${rel} keeps its error state: the banner there is the retry affordance, not a duplicated message`,
    );

    const banner = source.slice(source.indexOf('{error && ('), source.indexOf('{error && (') + 600);

    assert.match(
      banner,
      /<button/,
      `${rel} still offers the person an action on the banner (retry or dismiss)`,
    );
  }
});

test('the surfaces that had a reason to speak still do', () => {
  const login = fs.readFileSync(path.join(PAGES, 'login', 'LoginPage.jsx'), 'utf8');

  assert.match(login, /noticeFor\(searchParams\)/, 'the reset / account-setup arrival notice survives');
  assert.match(login, /notify\.info\(notice/, 'and it reaches the person as a toast');

  const roles = fs.readFileSync(path.join(PAGES, 'settings', 'RolesPermissionsPage.jsx'), 'utf8');

  assert.match(roles, /notify\.success\(/, 'a saved role answers on screen');
  assert.match(roles, /Still held by/, 'a refusal keeps the server sentence that explains it');
});

test('the toast layer carries no emoji', () => {
  for (const rel of ['utils/notify.js', 'components/AppToaster.jsx']) {
    assert.ok(!EMOJI.test(readSrc(rel)), `${rel} stays glyph-free (icons come from lucide)`);
  }
});

test('the unit is documented', () => {
  const doc = path.join(root, 'docs', 'PHASE_35_FEEDBACK_TOASTS.md');

  assert.ok(fs.existsSync(doc), 'docs/PHASE_35_FEEDBACK_TOASTS.md ships with the unit');

  const text = fs.readFileSync(doc, 'utf8');

  assert.match(text, /35\.1/, 'the document names the unit');
  assert.match(text, /awaiting localhost acceptance/, 'and states where acceptance stands');
});
