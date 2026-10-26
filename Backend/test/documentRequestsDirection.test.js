// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENT REQUESTS — both directions.
//
// HR asking an employee for a file and an employee asking HR to issue one are
// the same collection, told apart by `direction`. The thing that must never
// happen is the two inboxes bleeding into each other: an employee opening
// "requested by HR" and seeing their own ask would be told they have work to do
// that they are actually waiting on someone else for.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('src/models/DocumentRequest.js');
const controller = read('src/controllers/employeeDocsController.js');
const routes = read('src/routes/selfServiceRoutes.js');

describe('the request model', () => {
  test('direction is an enum that defaults to the original meaning', () => {
    assert.match(model, /DOC_REQUEST_DIRECTIONS = \['TO_EMPLOYEE', 'TO_HR'\]/);
    assert.match(model, /direction: \{ type: String, enum: DOC_REQUEST_DIRECTIONS, default: 'TO_EMPLOYEE' \}/);
  });

  test('the direction is indexed with status, so the inbox is a cheap query', () => {
    assert.match(model, /documentRequestSchema\.index\(\{ companyId: 1, direction: 1, status: 1 \}\)/);
  });
});

describe('the two inboxes stay apart', () => {
  test('the employee inbox excludes their own asks', () => {
    const start = controller.indexOf('export const myDocRequests');
    const body = controller.slice(start, start + 900);
    assert.match(body, /direction: \{ \$ne: 'TO_HR' \}/, '$ne keeps pre-existing rows in the old meaning');
  });

  test("HR's outbox excludes them too", () => {
    const start = controller.indexOf('export const listDocRequests');
    const body = controller.slice(start, start + 900);
    assert.match(body, /direction: \{ \$ne: 'TO_HR' \}/);
  });

  test('the cabinet returns both, and the UI is the splitter', () => {
    // One cabinet call stays one call: the row already carries `direction`.
    const start = controller.indexOf('export const employeeDocuments');
    const body = controller.slice(start, start + 1200);
    assert.match(body, /DocumentRequest\.find\(\{ companyId: req\.companyId, user: req\.params\.userId \}\)/);
  });
});

describe('employee asks HR', () => {
  test('creating one sets the direction, the requester and the HR notification', () => {
    const start = controller.indexOf('export const createHrDocRequest');
    const body = controller.slice(start, start + 1600);
    assert.match(body, /direction: 'TO_HR'/);
    assert.match(body, /requestedBy: req\.user\._id/);
    assert.match(body, /role: \{ \$in: HR_ROLES \}/, 'every HR user is told, not one of them');
  });

  test('only HR can list or fulfil', () => {
    for (const name of ['listHrDocRequests', 'fulfilHrDocRequest']) {
      const start = controller.indexOf(`export const ${name}`);
      const body = controller.slice(start, start + 700);
      assert.match(body, /if \(!isHR\(req\)\)/, `${name} is gated on HR`);
    }
  });

  test('fulfilling files the document against the employee who asked', () => {
    const start = controller.indexOf('export const fulfilHrDocRequest');
    const body = controller.slice(start, start + 1800);
    assert.match(body, /user: request\.user/, 'the document lands in the requester\'s cabinet');
    assert.match(body, /uploadedBy: req\.user\._id/, 'HR is recorded as the uploader');
    assert.match(body, /direction: 'TO_HR'/, 'a TO_EMPLOYEE row can never be fulfilled from this side');
    assert.match(body, /request\.status = 'FULFILLED'/);
  });

  test('either side can close it, and the other side is told', () => {
    const start = controller.indexOf('export const cancelHrDocRequest');
    const body = controller.slice(start, start + 1600);
    assert.match(body, /const mine = String\(request\.user\) === String\(req\.user\._id\)/);
    assert.match(body, /if \(!mine && !isHR\(req\)\)/);
    assert.match(body, /notifyDoc\(request\.user/, 'an employee hears about a decline');
  });
});

describe('the routes', () => {
  const route = (method, path) => {
    const at = routes.indexOf(`'${path}'`);
    assert.ok(at > -1, `${path} is routed`);
    const before = routes.slice(Math.max(0, at - 400), at);
    const after = routes.slice(at, at + 900);
    return { before, after, verb: before.match(/router\.(\w+)\(/g)?.pop() };
  };

  test('the five endpoints exist with the right gates', () => {
    assert.match(route('POST', '/documents/requests/hr').after, /createHrDocRequest/);
    assert.match(route('GET', '/documents/requests/hr/my').after, /myHrDocRequests/);
    assert.match(route('GET', '/documents/requests/hr').after, /listHrDocRequests/);
    assert.match(route('POST', '/documents/requests/hr/:id/fulfil').after, /fulfilHrDocRequest/);
    assert.match(route('PATCH', '/documents/requests/hr/:id/cancel').after, /cancelHrDocRequest/);
  });

  test('fulfilling goes through the same upload bounds as every other document', () => {
    const { after } = route('POST', '/documents/requests/hr/:id/fulfil');
    assert.match(after, /requirePermission\(\s*'DOCUMENT_CREATE'/, 'only a document creator can attach a file');
    assert.match(after, /checkUsageLimit\(\s*'fileUploadsMonthly'/);
    assert.match(after, /anyDocUpload/);
  });

  test('an employee can raise one without holding a create permission', () => {
    const { after } = route('POST', '/documents/requests/hr');
    assert.match(after, /requireAnyPermission\(\[\s*'DOCUMENT_READ_SELF',\s*'DOCUMENT_READ',/);
  });

  test('the older, HR→employee routes are untouched', () => {
    for (const call of [
      'createDocRequest', 'myDocRequests', 'listDocRequests', 'fulfillDocRequest', 'cancelDocRequest',
    ]) {
      assert.ok(routes.includes(call), `${call} still routed`);
    }
  });
});
