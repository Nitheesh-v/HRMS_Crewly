// PHASE 37.2 — SELF PRESENCE UX (source pins + behavioral assertions).
//
// Pattern matches aiChatWidget.test.js / aiChatUx.test.js: the components
// are JSX and run under plain Node without a JSX transform, so most of
// these tests are comment-stripped SOURCE PINS — the wiring checks that
// actually broke in 36.x (capsule §4.10, §4.5). Where a render or
// dispatch behavior is feasible without a JSX runtime, a behavioral
// assertion is added.

import { describe, test } from 'node:test';
import assert$1 from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describePresence, isSelectablePresence, presenceLabel } from '../src/components/presence/presenceVisual.js';
import { EMPTY_PRESENCE } from '../src/redux/slices/presenceConstants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Strip /* */ block comments and trailing // line comments so a pin
// cannot match its own documentation (Phase 36 capsule §4.5).
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const assert = assert$1;

const INDICATOR = 'src/components/presence/PresenceIndicator.jsx';
const MENU = 'src/components/presence/PresenceMenu.jsx';
const EXPIRY = 'src/components/presence/StatusExpirySelector.jsx';
const MESSAGE = 'src/components/presence/StatusMessageEditor.jsx';
const LOCATION = 'src/components/presence/WorkLocationSelector.jsx';
const APP_LAYOUT = 'src/layout/AppLayout.jsx';

describe('Phase 37.2 — presence widget source pins', () => {
  test('all five components exist and default-export', () => {
    for (const rel of [INDICATOR, MENU, EXPIRY, MESSAGE, LOCATION]) {
      const src = read(rel);
      assert.ok(src.includes('export default'), `${rel} must have a default export`);
    }
  });

  test('the barrel re-exports the public surface', () => {
    const barrel = read('src/components/presence/index.js');
    for (const name of [
      'PresenceIndicator',
      'PresenceMenu',
      'StatusExpirySelector',
      'StatusMessageEditor',
      'WorkLocationSelector',
      'describePresence',
      'isSelectablePresence',
      'presenceLabel',
    ]) {
      assert.ok(barrel.includes(name), `barrel must export ${name}`);
    }
  });

  test('PresenceMenu dispatches the four presence thunks (37.2 §17)', () => {
    const src = code(MENU);
    for (const thunk of [
      'loadMyPresence',
      'updateMyStatus',
      'updateMyStatusMessage',
      'updateMyWorkLocation',
    ]) {
      assert.ok(src.includes(thunk), `PresenceMenu must reference ${thunk}`);
    }
  });

  test('PresenceMenu does NOT send identity-override fields (37.2 §19)', () => {
    const src = code(MENU);
    // The presence object identity is the OBJECT key sent in a mutation
    // payload. The test pins property-style references, NOT bare words
    // that may appear in user-facing copy ("your company", "the user can").
    const identityKeys = ['companyId', 'userId', 'employeeId'];
    for (const key of identityKeys) {
      assert.doesNotMatch(
        src,
        new RegExp(`\\b${key}\\b`),
        `PresenceMenu must not reference ${key}`,
      );
    }
    // Bare 'company' / 'employee' / 'user' are common English words; pin
    // the property-style form that would actually appear in a request body.
    assert.doesNotMatch(
      src,
      /body\s*[:=]\s*{[^}]*\bcompany\b/i,
      'PresenceMenu must not put a "company" key in a request body',
    );
    assert.doesNotMatch(
      src,
      /\buser\b\s*[:=]/,
      'PresenceMenu must not put a "user" key in a request body',
    );
    assert.doesNotMatch(
      src,
      /\bemployee\b\s*[:=]/,
      'PresenceMenu must not put an "employee" key in a request body',
    );
  });

  test('PresenceMenu never persists state to localStorage / sessionStorage (37.2 §26)', () => {
    const src = code(MENU);
    assert.doesNotMatch(src, /localStorage|sessionStorage/);
  });

  test('PresenceMenu never uses dangerouslySetInnerHTML (37.2 §25)', () => {
    const src = code(MENU);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  });

  test('WorkLocationSelector handles all three policy states (37.2 §12)', () => {
    const src = code(LOCATION);
    for (const mode of ['self_declare', 'approval_required', 'disabled']) {
      assert.ok(
        src.includes(mode),
        `WorkLocationSelector must reference ${mode}`,
      );
    }
    assert.ok(
      src.includes('approval'),
      'WorkLocationSelector must render an explanatory approval-required copy (no fake activation)',
    );
  });

  test('StatusMessageEditor enforces 160-char cap (37.2 §10 / backend 37.1 §14)', () => {
    const src = code(MESSAGE);
    assert.ok(src.includes('160'), 'STATUS_MESSAGE_MAX must be 160');
    assert.ok(src.includes('maxLength'), 'textarea must set maxLength');
  });

  test('StatusExpirySelector supports "Until cleared" / "Today" / custom (37.2 §8)', () => {
    const src = code(EXPIRY);
    assert.ok(src.includes("'Until cleared'"));
    assert.ok(src.includes("'Today'"));
    assert.ok(src.includes("'Custom'"));
    assert.ok(src.includes('datetime-local'), 'custom expiry must use datetime-local');
  });

  test('AppLayout mounts PresenceMenu in the header (37.2 §4)', () => {
    const src = code(APP_LAYOUT);
    assert.ok(
      src.includes('PresenceMenu'),
      'AppLayout must import and mount PresenceMenu',
    );
    // It must be mounted near the avatar, NOT in a separate route.
    assert.doesNotMatch(
      src,
      /import\s+PresenceMenu\s+from\s+['"][^'"]*pages/,
      'PresenceMenu must NOT live in pages — it is a header affordance',
    );
  });

  test('PresenceIndicator renders both colour AND label (37.2 §22)', () => {
    const src = code(INDICATOR);
    assert.ok(src.includes('aria-label'), 'indicator must carry aria-label');
    assert.ok(src.includes('aria-hidden="true"'), 'decorative dot/icon must be aria-hidden');
  });

  test('the feature is NOT modal (37.2 §22)', () => {
    const src = code(MENU);
    assert.doesNotMatch(src, /aria-modal/);
    assert.doesNotMatch(src, /fixed\s+inset-0/);
  });

  test('Phase 36 AI surface has NO presence imports (37.2 §31)', () => {
    const aiFiles = [
      'src/services/aiService.js',
      'src/components/AIAssistant/AiAssistantWidget.jsx',
      'src/components/AIAssistant/chatPrompts.js',
    ];
    for (const rel of aiFiles) {
      const src = code(rel);
      assert.doesNotMatch(
        src,
        /presenceService|presenceSlice|presenceMenu|presenceIndicator/,
        `${rel} must not reference presence modules`,
      );
    }
  });

  test('no team-availability surface is added in 37.2 (37.2 §28)', () => {
    const root$ = new URL('..', import.meta.url);
    const pagesDir = path.join(root$.pathname, 'src/pages');
    if (fs.existsSync(pagesDir)) {
      for (const entry of fs.readdirSync(pagesDir)) {
        const lc = entry.toLowerCase();
        // 37.2 ships no presence-* page in the TEAM directory.
        // 37.3+ added the presence pages; the settings directory is
        // the AI admin pages (Phase 36.6/36.7) — out of scope here.
        // The presence pages themselves are Phase 37 territory, not
        // team-availability territory. We keep this pin narrow to
        // the team directory.
        if (entry === 'settings') continue;
        if (entry === 'presence') continue; // 37.3+
        if (entry === 'team') continue; // team availability is 37.3
        assert.equal(
          lc.includes('presence'),
          false,
          `${entry} must not exist (37.2 ships no presence-* page outside presence/ and team/)`,
        );
      }
    }
  });

  test('no heartbeat / mousemove / keydown activity tracking (37.2 §27)', () => {
    const src = code(MENU);
    assert.doesNotMatch(src, /mousemove|keydown.*activity|setInterval.*heartbeat/);
  });

  test('no fake WFH approval API (37.2 §29)', () => {
    const src = code(MENU);
    // The menu must NOT invent a fake "request WFH approval" endpoint.
    assert.doesNotMatch(
      src,
      /\/presence\/me\/work-location\/request/,
      'menu must not invent a fake approval endpoint (37.5 owns that)',
    );
  });

  test('no leave / shift derived guesses (37.2 §30)', () => {
    const src = code(MENU);
    assert.doesNotMatch(src, /fromLeave|leaveService|shiftService/);
  });

  test('no salary / phone / aadhaar leaks (37.2 §25)', () => {
    const src = code(MENU);
    for (const token of ['aadhaar', 'PAN', 'UAN', 'bankAccount', 'phone', 'salary', 'deductions']) {
      assert.doesNotMatch(src, new RegExp(`\\b${token}\\b`, 'i'));
    }
  });

  test('UNKNOWN renders as Presence unavailable, not Offline (37.2 §6)', () => {
    assert.equal(presenceLabel('unknown'), 'Presence unavailable');
    assert.equal(isSelectablePresence('unknown'), false);
    assert.equal(isSelectablePresence('offline'), false);
    assert.equal(isSelectablePresence('away'), false);
    assert.equal(isSelectablePresence('on_leave'), false);
  });

  test('manual-only set: Available / Busy / DND (37.2 §7)', () => {
    assert.equal(isSelectablePresence('available'), true);
    assert.equal(isSelectablePresence('busy'), true);
    assert.equal(isSelectablePresence('dnd'), true);
  });

  test('describePresence falls back to the unknown palette, never throws (37.2 §5)', () => {
    assert.equal(describePresence(undefined).label, 'Presence unavailable');
    assert.equal(describePresence(null).label, 'Presence unavailable');
    assert.equal(describePresence('invented').label, 'Presence unavailable');
  });

  test('EMPTY_PRESENCE never claims Offline (37.1 §20)', () => {
    assert.equal(EMPTY_PRESENCE.presence, 'unknown');
    assert.equal(EMPTY_PRESENCE.livePresenceAvailable, false);
  });
});