// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENTS — the employee cabinet's new layout.
//
// What is pinned here:
//   1. the cabinet reads every number from the API payload — there is no
//      storage quota, no "AES-256" and no "sign contracts" claim, because the
//      app has none of those;
//   2. the four tiles, the category tabs and the empty states all derive from
//      the same two lists (documents + requests) that the old page loaded;
//   3. the three actions still hit the same endpoints as before (upload,
//      fulfil a request, gated download) — a redesign must not break them;
//   4. list and grid are the same data, one switch;
//   5. the page uses the app palette, not the indigo/slate it was written in.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const page = fs.readFileSync(path.join(root, 'src/pages/documents/MyDocumentsPage.jsx'), 'utf8');

describe('documents cabinet', () => {
  test('one load, four endpoints — including the employee\'s own asks to HR', () => {
    assert.match(
      page,
      /Promise\.all\(\[\s*getMyDocuments\(\), getMyDocRequests\(\), getDocCategories\(\), getMyHrDocRequests\(\),/,
    );
    assert.match(page, /await uploadMyDocument\(fd\)/);
    assert.match(page, /await fulfillDocRequest\(request\._id, fd\)/);
    assert.match(page, /downloadDocument\(d\._id, \{ skipErrorToast: true \}\)/);
  });

  test('the employee can ask HR for a document (the option that was missing)', () => {
    // Header action, modal, POST and the list of what was asked.
    assert.match(page, />\s*Request from HR\s*</);
    assert.match(page, /await createHrDocRequest\(\{/);
    assert.match(page, /await cancelHrDocRequest\(request\._id\)/);
    assert.match(page, /Request a document from HR/, 'the modal has its own title');
    assert.match(page, /Requested from HR/, 'and the asks are listed back');
    // Withdraw is offered only while it is still pending.
    assert.match(page, /r\.status === 'PENDING' && \(\s*<button type="button" onClick=\{\(\) => withdrawAsk\(r\)\}/);
  });

  test('the header says what the cabinet is, and offers the two real actions', () => {
    assert.match(page, />Document Management</, 'the page is titled for the cabinet, not for a form');
    assert.match(page, /Request history/);
    assert.match(page, />\s*Upload document\s*</, 'the primary action is upload');
  });

  test('nothing on the page invents a capability', () => {
    // Each of these appears in the reference mock; none of them is true here.
    for (const claim of ['5 GB', 'AES-256', 'e-signature', 'sign contracts']) {
      assert.equal(page.includes(claim), false, `"${claim}" is not a feature of this app`);
    }
    // The employee→HR request is a real endpoint now, so it is allowed — but
    // it must go through `createHrDocRequest`, never a fabricated POST.
    assert.equal(page.includes("post('/documents/requests'"), false);
    // The one privacy statement the page may make is the one the API enforces.
    assert.match(page, /authenticated endpoint/);
  });

  test('the four tiles are counted from the payload', () => {
    assert.match(page, /label="Available files"[\s\S]*?value=\{docs\.length\}/);
    assert.match(page, /label="Action required"[\s\S]*?value=\{pending\.length\}/);
    assert.match(page, /label="Storage used"[\s\S]*?value=\{fmtSize\(used\)\}/, 'storage is the bytes on hand');
    assert.match(page, /label="Active folders"[\s\S]*?value=\{folders\}/);
    // `used` is summed, not typed.
    assert.match(page, /const bytes = \(docs\) => docs\.reduce\(\(sum, d\) => sum \+ \(Number\(d\.size\) \|\| 0\), 0\)/);
    assert.match(page, /const used = bytes\(docs\)/);
  });

  test('folders only exist when a document is in them', () => {
    assert.match(page, /\.filter\(\(c\) => c\.count > 0\)/, 'an empty category is not a folder');
    assert.match(page, /value: 'ALL', label: 'All documents', count: docs\.length/);
    assert.match(page, /aria-pressed=\{tab === t\.value\}/);
  });

  test('the selected tab wears the app highlight, not a hue of its own', () => {
    assert.match(page, /bg-crewly-selected font-semibold text-crewly-selected-text/);
    assert.match(page, /btn-primary/);
  });

  test('search, status and sort only narrow the same list', () => {
    assert.match(page, /const shown = docs\s*\n\s*\.filter\(inTab\)/);
    assert.match(page, /\.filter\(matchesStatus\)/);
    assert.match(page, /sort === 'SIZE'/);
    assert.match(page, /Showing \{shown\.length\} of \{docs\.length\} record/);
  });

  test('list and grid are one dataset behind one switch', () => {
    assert.match(page, /aria-pressed=\{view === 'list'\}/);
    assert.match(page, /aria-pressed=\{view === 'grid'\}/);
    assert.equal((page.match(/shown\.map\(/g) || []).length, 2, 'both views render `shown`');
  });

  test('an empty cabinet and an empty filter are different sentences', () => {
    assert.match(page, /title="No documents yet"/);
    assert.match(page, /title="No documents match"/);
  });

  test('the upload panel can be dismissed, and cannot be dismissed into nowhere', () => {
    assert.match(page, /setUploadOpen\(false\)/);
    assert.match(page, /setUploadOpen\(true\)/);
    assert.match(page, /disabled=\{busy \|\| !file\}/, 'no file, no upload');
  });

  test('it is painted in the app palette', () => {
    for (const cold of ['bg-indigo', 'bg-blue-', 'bg-purple-', 'text-slate-', 'bg-slate-', 'text-indigo']) {
      assert.equal(page.includes(cold), false, `${cold} belongs to the old palette`);
    }
    assert.match(page, /bg-crewly-card|card /, 'panels are the themed card surface');
  });
});
