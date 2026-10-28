// ═══════════════════════════════════════════════════════════════════════════
//  BINARY DOWNLOADS — the BSON Binary regression.
//
//  Reported: downloading a payslip bulk archive returned
//
//      500 - TypeError: The "string" argument must be of type string or an
//      instance of Buffer or ArrayBuffer. Received an instance of Binary
//
//  A `Buffer` field read with `.lean()` comes back as a BSON `Binary`, and
//  `Buffer.byteLength()` refuses it. Every download route now normalises what
//  it sends through `asBuffer`, so the response writer can never meet a raw
//  Binary again. These pins hold the helper and the call sites.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import asBuffer, { isEmptyBinary } from '../src/utils/asBuffer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// The shape the driver hands back for a stored Buffer under `.lean()`.
const bsonBinary = (bytes) => ({
  _bsontype: 'Binary',
  buffer: Uint8Array.from(bytes),
  position: bytes.length,
  sub_type: 0,
});

describe('asBuffer — one normaliser for stored bytes', () => {
  test('a Node Buffer passes straight through', () => {
    const source = Buffer.from('PK\u0003\u0004');
    assert.equal(asBuffer(source), source);
  });

  test('a Uint8Array becomes a Buffer', () => {
    const out = asBuffer(Uint8Array.from([80, 75, 3, 4]));
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.toString('latin1'), 'PK\u0003\u0004');
  });

  test('a BSON Binary becomes a Buffer of the written bytes only', () => {
    const out = asBuffer(bsonBinary([1, 2, 3]));
    assert.ok(Buffer.isBuffer(out));
    assert.deepEqual([...out], [1, 2, 3]);

    // A Binary whose backing Uint8Array is larger than what was written keeps
    // only `position` bytes — otherwise the ZIP carries trailing zeroes.
    const padded = { _bsontype: 'Binary', buffer: Uint8Array.from([9, 8, 7, 6, 5]), position: 2 };
    assert.deepEqual([...asBuffer(padded)], [9, 8]);
  });

  test('the reported crash is gone: a Binary can be measured', () => {
    const out = asBuffer(bsonBinary([80, 75, 3, 4]));
    assert.doesNotThrow(() => Buffer.byteLength(out));
    assert.equal(Buffer.byteLength(out), 4);
  });

  test('an older bson Binary that exposes value() still works', () => {
    const legacy = { _bsontype: 'Binary', value: () => Uint8Array.from([4, 3, 2, 1]) };
    assert.deepEqual([...asBuffer(legacy)], [4, 3, 2, 1]);
  });

  test('nothing becomes an empty buffer, never a throw', () => {
    for (const value of [null, undefined, {}, { nope: true }, () => Buffer.from('x')]) {
      const out = asBuffer(value);
      assert.ok(Buffer.isBuffer(out), 'must always answer with a Buffer');
      assert.equal(out.length, 0);
      assert.equal(isEmptyBinary(value), true);
    }
  });

  test('a string is encoded as UTF-8, so Content-Length stays byte-accurate', () => {
    const out = asBuffer('₹1,00,000');
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.length, Buffer.byteLength('₹1,00,000', 'utf8'));
    assert.notEqual(out.length, '₹1,00,000'.length);
  });
});

describe('every download route normalises before it measures', () => {
  const writers = [
    'src/controllers/payroll/payslipController.js',
    'src/controllers/payroll/fnfController.js',
    'src/controllers/payroll/statutoryController.js',
    'src/controllers/attendance/attendanceAnalyticsController.js',
    'src/controllers/attendance/attendanceTimesheetController.js',
  ];

  test('no response writer measures raw content', () => {
    for (const file of writers) {
      const source = read(file);
      assert.ok(source.includes('asBuffer'), `${file} must normalise the body with asBuffer`);
      assert.ok(
        !source.includes('Buffer.byteLength(content'),
        `${file} must not call Buffer.byteLength on un-normalised content`,
      );
    }
  });

  test('the payslip bulk archive and PDF are normalised at the service boundary', () => {
    const service = read('src/services/payroll/payslipService.js');
    assert.ok(
      service.includes('content: asBuffer(withBinary?.binary)'),
      'the bulk archive must be normalised where it is read',
    );
    assert.ok(
      service.includes('asBuffer(withPdf?.pdf)'),
      'a single payslip PDF must be normalised where it is read',
    );
  });

  test('the other stored-file services use the same helper', () => {
    for (const rel of [
      'src/services/payroll/fnfService.js',
      'src/services/payroll/statutoryService.js',
      'src/services/payroll/analyticsService.js',
    ]) {
      const source = read(rel);
      assert.ok(source.includes('asBuffer'), `${rel} must normalise stored binaries`);
      assert.ok(
        !source.includes('withBinary?.binary || Buffer.alloc(0)'),
        `${rel} must not hand a raw Binary to a response writer`,
      );
    }
  });
});
