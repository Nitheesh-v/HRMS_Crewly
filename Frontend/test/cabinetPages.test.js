// ═══════════════════════════════════════════════════════════════════════════
// CABINET PAGES — Employee Files (HR) and Employee Lifecycle.
//
// Both pages were rebuilt to the layouts the owner sent. What is pinned here is
// the part a redesign usually breaks: the endpoints, the honesty of the numbers,
// and the fact that every control that looks live is live.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const files = read('src/pages/documents/EmployeeFilesPage.jsx');
const lifecycle = read('src/pages/lifecycle/LifecyclePage.jsx');

describe('employee files cabinet', () => {
  test('keeps the five endpoints that do the work', () => {
    for (const call of [
      'getEmployees()',
      'getEmployeeCabinet(emp._id)',
      'hrUploadDocument(empId, fd)',
      'createDocRequest(',
      'cancelDocRequest(req._id)',
      'deleteDocument(doc._id)',
      'downloadDocument(d._id, { skipErrorToast: true })',
    ]) {
      assert.ok(files.includes(call), `missing ${call}`);
    }
  });

  test('the tiles describe the open cabinet, because nothing else is countable', () => {
    // The company list endpoint carries no document counts, so a company-wide
    // total would be invented. Each tile reads the selected cabinet and says
    // "pick an employee" when there is none.
    assert.match(files, /label="Files on file"[\s\S]*?value=\{empId \? docs\.length : '—'\}/);
    assert.match(files, /label="Expiring soon"[\s\S]*?value=\{empId \? expiring : '—'\}/);
    assert.match(files, /label="Pending requests"[\s\S]*?value=\{empId \? pending\.length : '—'\}/);
    assert.match(files, /const bytesOf = \(docs\) => docs\.reduce/);
  });

  test('the checkpoints are a checklist, never a score', () => {
    assert.match(files, /const STANDARD_CHECKS = \['OFFER_LETTER', 'AADHAAR_ID', 'SALARY_DOCUMENT', 'CONTRACT'\]/);
    assert.match(files, /A checklist, not a compliance score/);
    // The claims the reference mock made, which this product cannot back up.
    for (const claim of ['5 GB', 'AES-256', 'Download Zip', 'Edit Record', 'compliance score =']) {
      assert.equal(files.includes(claim), false, `"${claim}" is not something this API can do`);
    }
    // No completion percentage is ever computed.
    assert.equal(/%/.test(files.match(/covered[^\n]*/)?.[0] || ''), false);
  });

  test('tiles and rows stay clickable where they promise to be', () => {
    assert.match(files, /onClick=\{\(\) => openCabinet\(e\)\}/);
    assert.match(files, /aria-pressed=\{dept === 'ALL'\}/);
    // The header actions are disabled until a cabinet is open, rather than
    // failing when clicked.
    assert.match(files, /disabled=\{!empId\}/);
  });

  test('the modals are the shared ones, so they follow the theme', () => {
    assert.equal(files.includes('fixed inset-0 z-50'), false, 'no hand-rolled overlay');
    assert.match(files, /<Modal title=/);
  });
});

describe('employee lifecycle console', () => {
  test('the census reads the overview endpoint, and falls back to the list', () => {
    assert.match(lifecycle, /getOverview\(\)\.then\(setOverview\)/);
    assert.match(lifecycle, /const countOf = \(stage\) => counts\[stage\] \?\? list\.filter\(\(r\) => r\.stage === stage\)\.length/);
    assert.match(lifecycle, /\{ value: countOf\('ONBOARDING'\)|value=\{countOf\('ONBOARDING'\)\}/);
  });

  test('"due soon" is thirty days, the same window the API uses', () => {
    assert.match(lifecycle, /const daysTo = /);
    assert.match(lifecycle, /return d !== null && d <= 30/);
    assert.match(lifecycle, /const probationRadar = overview\?\.probationEnding\?\.length/);
  });

  test('the stage graph shown matches the server, and is not enforced here', () => {
    assert.match(lifecycle, /PRE_JOINING: \['ONBOARDING'\]/);
    assert.match(lifecycle, /CONFIRMED: \['NOTICE_PERIOD', 'EXITED'\]/);
    assert.match(lifecycle, /ALUMNI: \[\]/);
    assert.match(lifecycle, /It is shown, not enforced/);
    assert.match(lifecycle, /This dialog only documents the graph|only documents the graph/);
  });

  test('every action still posts to the lifecycle endpoints', () => {
    for (const call of ['promoteUser(uid', 'transferUser(uid', "setStage(uid, { to: 'CONFIRMED'", "setStage(uid, { to: 'ALUMNI'"]) {
      assert.ok(lifecycle.includes(call), `missing ${call}`);
    }
  });

  test('export is a real CSV of what is on screen', () => {
    assert.match(lifecycle, /const exportMatrix = \(\) => \{/);
    assert.match(lifecycle, /\.\.\.filtered\.map\(\(r\) => \[/);
    assert.match(lifecycle, /text\/csv;charset=utf-8/);
  });

  test('both views exist: the employee keeps a journey, HR keeps the console', () => {
    assert.match(lifecycle, /if \(!isHR\)/);
    assert.match(lifecycle, /My Journey/);
    assert.match(lifecycle, /Employee Lifecycle/);
  });

  test('it is painted in the app palette, not the old indigo/slate', () => {
    for (const cold of ['bg-indigo', 'bg-slate-', 'text-slate-', 'text-indigo', 'bg-sky-']) {
      assert.equal(lifecycle.includes(cold), false, `${cold} belongs to the old palette`);
      assert.equal(files.includes(cold), false, `${cold} belongs to the old palette (employee files)`);
    }
  });
});
