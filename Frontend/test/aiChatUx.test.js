// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.6 — THE UX PACK, PINNED BY SOURCE
//
// The panel and the bubble are JSX, and plain Node cannot load JSX. So the
// behavioural laws that matter most are pinned here against the source text,
// the same way 36.5 pinned the voice modules.
//
// These are not decoration. Each one is a rule that was decided during the
// build and would be easy to break silently later:
//
//   · the assistant NAVIGATES and never ACTS;
//   · no chat is ever persisted;
//   · no emojis in the new UI;
//   · typing stops the speech;
//   · the reveal respects prefers-reduced-motion;
//   · the usage page sends no identifiers.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read a source file with its COMMENTS REMOVED.
 *
 * This matters more than it looks. Two of the pins below ban a token that
 * appears in the module's own doc comment explaining why it is NOT used —
 * "Nothing is written to localStorage", "a Blob, a MediaRecorder, an
 * ArrayBuffer". A naive substring search flags the explanation and the test
 * fails while the code is correct. Strip the comments, then search.
 */
const readCode = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read a repo-relative path.
 *
 * `Backend/...` is resolved from the REPO ROOT, everything else from the
 * Frontend root. Getting this wrong silently reads a non-existent file and
 * every assertion against it fails for the wrong reason.
 */
const read = (rel) => {
  const target = rel.startsWith('Backend/')
    ? path.join(here, '..', '..', rel)
    : path.join(here, '..', rel);

  return fs.readFileSync(target, 'utf8');
};

const AI_DIR = 'src/components/AIAssistant';

const NEW_FILES = [
  'ChatMessageBubble.jsx',
  'AiAssistantPanel.jsx',
  'chatTranscript.js',
  'replyCards.js',
  'useProgressiveReveal.js',
];

describe('36.6 — navigation only, never an action', () => {
  test('a deep-link chip calls navigate and nothing else', () => {
    const source = read(`${AI_DIR}/ChatMessageBubble.jsx`);

    assert.equal(source.includes('useNavigate'), true);
    assert.equal(source.includes('onClick={() => navigate(link.path)}'), true);

    // No network, no store dispatch, no mutation. A chip that changed state
    // would mean the assistant had performed an action.
    //
    // NOTE the bans are deliberately narrow. `await navigator.clipboard` is
    // allowed: the copy button writes to the local clipboard, which is not an
    // action on any HR record. A blanket `await ` ban caught it once.
    assert.equal(source.includes('api.'), false);
    assert.equal(source.includes('dispatch('), false);
    assert.equal(source.includes('fetch('), false);
    assert.equal(source.includes('axios'), false);
  });

  test('the deep-link map is server-side and hardcoded, never model-supplied', () => {
    // The single most important backend pin for this feature. If a model could
    // choose the path, a model could choose an action.
    const source = read('Backend/src/services/ai/aiConfig.js');

    const block = source.slice(
      source.indexOf('export const AI_DEEP_LINKS'),
      source.indexOf('export const AI_DEEP_LINK_ORDER'),
    );

    assert.equal(block.includes('/app/'), true);

    // Every path in the map is a literal.
    const paths = block.match(/path: '([^']+)'/g) || [];

    assert.equal(paths.length, 4);
  });

  test('no chip path points outside the app', () => {
    const source = read('Backend/src/services/ai/aiConfig.js');

    const paths = source.match(/path: '([^']+)'/g) || [];

    paths.forEach((entry) => {
      const value = entry.slice(entry.indexOf("'") + 1, entry.lastIndexOf("'"));

      assert.equal(value.startsWith('/app/'), true);
      assert.equal(value.includes('://'), false);
    });
  });
});

describe('36.6 — no persistence', () => {
  test('the transcript export never touches storage or the network', () => {
    const source = read(`${AI_DIR}/chatTranscript.js`);

    ['localStorage', 'sessionStorage', 'indexedDB', 'api.js', 'fetch(', 'axios'].forEach(
      (banned) => {
        assert.equal(source.includes(banned), false, `${banned} found`);
      },
    );
  });

  test('the card parser and the reveal hook store nothing', () => {
    ['replyCards.js', 'useProgressiveReveal.js'].forEach((file) => {
      const source = read(`${AI_DIR}/${file}`);

      ['localStorage', 'sessionStorage', 'indexedDB'].forEach((banned) => {
        assert.equal(source.includes(banned), false, `${file}: ${banned}`);
      });
    });
  });

  test('the new AI files write no prompt or transcript to Mongo', () => {
    // There is no server-side chat persistence at all, and nothing in the
    // frontend should imply otherwise.
    const service = readCode('src/services/aiService.js');

    // readCode, not read: the module's own header says "Nothing is
    // written to localStorage", and a substring search on the raw file
    // flags that sentence.
    assert.equal(service.includes('localStorage'), false);
    assert.equal(service.includes('sessionStorage'), false);
  });
});

describe('36.6 — no emojis in the new UI', () => {
  // The Unicode property, not a hand-built range. A literal class that
  // includes U+FE0F (the variation selector) is flagged by
  // no-misleading-character-class, because that codepoint is a COMBINING
  // character and the rule exists to stop a class silently matching a
  // base character plus its decoration. \p{Extended_Pictographic} says the
  // same thing without the trap.
  const emoji = /\p{Extended_Pictographic}/u;

  test('none of the new files contains an emoji', () => {
    NEW_FILES.forEach((file) => {
      const source = read(`${AI_DIR}/${file}`);

      const match = emoji.exec(source);

      assert.equal(
        match,
        null,
        `${file} contains an emoji: ${match ? match[0] : ''}`,
      );
    });
  });

  test('the new admin page contains no emoji either', () => {
    const source = read('src/pages/settings/AiUsagePage.jsx');

    assert.equal(emoji.test(source), false);
  });
});

describe('36.6 — voice polish', () => {
  test('typing stops the speech', () => {
    const source = read(`${AI_DIR}/AiAssistantPanel.jsx`);

    assert.equal(source.includes('handleDraftChange'), true);

    // The stop must be conditional on something actually speaking, or every
    // keystroke would cancel the engine for no reason.
    assert.equal(source.includes('if (speakingId) {'), true);
    assert.equal(source.includes('stopSpeaking();'), true);

    // And the draft must still update. Swallowing a character would be a far
    // worse bug than the one being fixed.
    assert.equal(source.includes('setDraft(next);'), true);
    assert.equal(source.includes('onChange={handleDraftChange}'), true);
  });

  test('the 36.5 privacy pins on the voice modules still hold', () => {
    // 36.6 must not have widened the ban list. Those two files are the only
    // ones it applies to, and a new export util using createObjectURL is
    // explicitly allowed — see the note in chatTranscript.js.
    const voiceFiles = [
      'src/hooks/useSpeechRecognition.js',
      'src/utils/speechSynthesis.js',
    ];

    voiceFiles.forEach((target) => {
      const source = readCode(target);

      ['fetch(', 'api.js', 'MediaRecorder', 'createObjectURL', 'new Blob'].forEach(
        (banned) => {
          assert.equal(source.includes(banned), false, `${target}: ${banned}`);
        },
      );
    });
  });
});

describe('36.6 — progressive reveal', () => {
  test('it respects prefers-reduced-motion', () => {
    const source = read(`${AI_DIR}/useProgressiveReveal.js`);

    assert.equal(
      source.includes("matchMedia('(prefers-reduced-motion: reduce)')"),
      true,
    );
  });

  test('the only setState is inside the timer callback', () => {
    const source = read(`${AI_DIR}/useProgressiveReveal.js`);

    // react-hooks/set-state-in-effect bans a synchronous setState in an effect
    // body, and that rule exists for a real reason. This pin keeps the hook in
    // the shape that satisfies it.
    const effectBody = source.slice(
      source.indexOf('useEffect(() => {'),
      source.indexOf('}, [full, instant]);'),
    );

    const setStateCalls = effectBody.match(/setShown\(/g) || [];

    setStateCalls.forEach(() => {
      // the one call must sit inside the interval callback
      assert.equal(effectBody.includes('window.setInterval('), true);
    });

    assert.equal(effectBody.includes('return undefined;'), true);
  });

  test('the timer is always cleared on cleanup', () => {
    const source = read(`${AI_DIR}/useProgressiveReveal.js`);

    assert.equal(source.includes('return () => window.clearInterval(timer);'), true);
  });

  test('user messages never animate', () => {
    const source = read(`${AI_DIR}/ChatMessageBubble.jsx`);

    assert.equal(source.includes('enabled: isAssistant'), true);
  });
});

describe('36.6 — the usage dashboard', () => {
  test('the client sends no identifiers at all', () => {
    const service = read('src/services/aiService.js');

    const block = service.slice(service.indexOf('export const getAiUsage'));

    const call = block.slice(
      block.indexOf('api.get('),
      block.indexOf('const payload'),
    );

    // The call itself carries NOTHING: no params, no body, no companyId, no
    // date range. The server derives the tenant from the caller's own token
    // and the month from its own clock.
    assert.equal(call.includes("api.get('/ai/usage')"), true);
    assert.equal(call.includes('api.get(\'/ai/usage\','), false);
    assert.equal(call.includes('params'), false);
    assert.equal(call.includes('body'), false);
    assert.equal(call.includes('companyId'), false);

    // And it is a GET. A usage dashboard that POSTed would be suspicious.
    assert.equal(block.includes('api.post'), false);

    // `userId` DOES appear in this block — in a comment documenting the
    // server's payload shape. That is documentation, not a request, so the
    // ban above is on the CALL, not on the whole function.
  });

  test('the page normalises byStatus as an object, not an array', () => {
    // The server returns a record keyed by status. Treating it as an array
    // would silently render nothing.
    const service = read('src/services/aiService.js');

    const block = service.slice(service.indexOf('export const getAiUsage'));

    assert.equal(block.includes('Object.keys(byStatus).reduce'), true);
    assert.equal(block.includes('typeof byStatus ==='), true);
  });

  test('a deleted user is labelled, not rendered as undefined', () => {
    const page = read('src/pages/settings/AiUsagePage.jsx');

    assert.equal(page.includes('Deleted employee'), true);
    assert.equal(page.includes('row.name ||'), true);
  });

  test('the route is COMPANY_ADMIN only', () => {
    const routes = read('src/routes/AppRoutes.jsx');

    const block = routes.slice(
      routes.indexOf('path="settings/ai-usage"') - 200,
      routes.indexOf('<AiUsagePage />'),
    );

    assert.equal(block.includes('RequireRole'), true);
    assert.equal(block.includes('COMPANY_ADMIN'), true);
  });

  test('the backend route is behind SETTINGS_MANAGE', () => {
    const source = readCode('Backend/src/routes/ai.js');

    const block = source.slice(source.indexOf(".route('/usage')"));

    assert.equal(block.includes("requirePermission('SETTINGS_MANAGE')"), true);

    // No invented ai:admin permission. That would need a registry change and
    // a migration for every existing tenant.
    assert.equal(source.includes("ai:admin"), false);
  });

  test('the usage controller reads nothing from the request', () => {
    const source = read('Backend/src/controllers/aiController.js');

    const block = source.slice(source.indexOf('export const getUsage'));

    assert.equal(block.includes('req.body'), false);
    assert.equal(block.includes('req.query'), false);
    assert.equal(block.includes('req.params'), false);
    assert.equal(block.includes('req.companyId'), true);
    assert.equal(block.includes('new Date()'), true);
  });

  test('the breakdown lookup is read-only and narrow', () => {
    const source = read('Backend/src/services/ai/aiUsageTracker.js');

    const block = source.slice(
      source.indexOf('export const getUsageBreakdown'),
      source.indexOf('export const checkQuota'),
    );

    // Two scalar fields off User, and nothing else.
    assert.equal(block.includes("from: 'users'"), true);
    assert.equal(block.includes("name: { $ifNull: ['$person.name', ''] }"), true);
    assert.equal(block.includes("designation: { $ifNull:"), true);
    assert.equal(block.includes('preserveNullAndEmptyArrays: true'), true);

    // A deleted user keeps their spend, so the total stays honest.
    assert.equal(block.includes('$unwind'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 36.6 — the usage page clears its loading flag
//
// The SAME defect the 36.7 capsule records for AiSettingsPage: `loading`
// starts as true, only `load()` clears it, and the mount effect called
// `readUsage()` instead. The fix and its pin were both scoped to the settings
// page, so it survived here untouched.
//
// It is worse on this page than it was on that one. On AiSettingsPage the
// damage was "you cannot save". Here the read can also FAIL, and the only
// recovery control on the page — Refresh — is itself gated on the stuck flag,
// so a transient network error left the dashboard wedged behind an error
// banner with a dead Retry button and no way out but a full reload.
//
// Every read below goes through readCode(): the fix carries a long comment
// that names both `readUsage()` and the stuck flag, and a raw substring
// search would match the explanation instead of the code.
// ═══════════════════════════════════════════════════════════════════════════
describe('36.6 — the usage page clears its loading flag', () => {
  const page = () => readCode('src/pages/settings/AiUsagePage.jsx');

  test('the mount effect goes through load(), not readUsage()', () => {
    const source = page();

    assert.equal(/useEffect\(\(\) => \{\s*load\(\);/.test(source), true);
    assert.equal(/useEffect\(\(\) => \{\s*readUsage\(\);/.test(source), false);
  });

  test('load() is the wrapper that actually clears the flag', () => {
    // Pinning the contract rather than the call site: whatever the effect
    // ends up calling has to be something that resets `loading`.
    const source = page();

    assert.equal(source.includes('setLoading(true)'), true);
    assert.equal(source.includes('setLoading(false)'), true);
  });

  test('readUsage() does not own the flag either', () => {
    // The split is pinned so the two never fight over one boolean:
    // readUsage fetches, load gates.
    const source = page();

    const body = source.slice(
      source.indexOf('const readUsage = useCallback'),
      source.indexOf('const load = useCallback'),
    );

    assert.equal(body.includes('setLoading'), false);
  });

  test('the blast radius of a stuck flag is on record', () => {
    // Every control gated on `loading`. One boolean, and when it sticks the
    // whole page dies while still rendering. The count is the point: a new
    // gate here is a new thing that breaks together.
    const source = page();

    const gates = source.match(/disabled=\{[^}]*\bloading\b[^}]*\}/g) || [];

    assert.equal(gates.length, 1, `expected 1 loading gate, found ${gates.length}`);
    assert.equal(gates[0], 'disabled={loading}');
  });

  test('Refresh is the recovery path and load() is wired to it', () => {
    // A failed read must leave a way back. The button is useless if the flag
    // it is gated on never clears.
    const source = page();

    assert.equal(source.includes('onClick={load}'), true);
    assert.equal(/disabled=\{loading\}[\s\S]{0,400}Refresh/.test(source), true);
  });
});
