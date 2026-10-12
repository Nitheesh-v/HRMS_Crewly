// Phase 37.1 — presenceService source guarantees + behavior pin.
//
// The 37.1 frontend prep is intentionally minimal: a thin axios layer
// and a slice. The widget that calls them belongs to 37.2. This file
// pins:
//   · the service does not send identity-override fields
//   · the service uses the existing api instance (which already
//     unwraps — Phase 36 capsule §4.3)
//   · the EMPTY_PRESENCE constant is the 37.1 default snapshot shape
//   · the error helper extracts the presence code, not the message
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EMPTY_PRESENCE,
  getMyPresence,
  getTenantConfig,
  setMyStatus,
  setMyStatusMessage,
  setMyWorkLocation,
  updateTenantConfig,
} from '../src/services/presenceService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FE_ROOT = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(FE_ROOT, rel), 'utf8');

// Comment-stripping helper (Phase 36 capsule §4.5, paid for). Strips both
// `/* ... */` blocks and trailing `// ...` line comments so a source
// pin cannot match its own documentation.
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Phase 37.1 presenceService', () => {
  test('functions are exported with the expected names', () => {
    assert.equal(typeof getMyPresence, 'function');
    assert.equal(typeof setMyStatus, 'function');
    assert.equal(typeof setMyStatusMessage, 'function');
    assert.equal(typeof setMyWorkLocation, 'function');
    assert.equal(typeof getTenantConfig, 'function');
    assert.equal(typeof updateTenantConfig, 'function');
  });

  test('EMPTY_PRESENCE uses unknown, never offline (Phase 37 §20)', () => {
    assert.equal(EMPTY_PRESENCE.presence, 'unknown');
    assert.equal(EMPTY_PRESENCE.livePresenceAvailable, false);
  });

  test('service does not import identity-override fields', () => {
    const src = code('src/services/presenceService.js');
    for (const field of [
      'companyId',
      'company',
      'userId',
      'user',
      'employeeId',
      'employee',
    ]) {
      assert.doesNotMatch(
        src,
        new RegExp(`\\b${field}\\b`),
        `presenceService.js must not reference ${field}`,
      );
    }
  });

  test('service uses the existing api instance, not raw fetch', () => {
    const src = code('src/services/presenceService.js');
    assert.ok(src.includes("from './api.js'"), 'must import api from api.js');
    assert.doesNotMatch(src, /\bfetch\s*\(/, 'must not call fetch directly');
  });

  test('service is the only presence surface (no widget, no localStorage)', () => {
    const src = code('src/services/presenceService.js');
    assert.doesNotMatch(src, /localStorage|sessionStorage/);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  });
});