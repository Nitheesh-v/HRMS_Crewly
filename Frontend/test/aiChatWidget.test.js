// PHASE 36.3 — the assistant is a floating widget, not a page.
//
// These are SOURCE PINS rather than render tests: the components are JSX and
// this suite runs under plain Node with no JSX transform (see test/loaders/).
// What is being pinned is the WIRING, because that is what actually broke
// before — 36.3 shipped a route and a sidebar entry that no longer exist, and a
// slice that was never registered. A pin fails loudly on the omission.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const WIDGET = 'src/components/AIAssistant/AiAssistantWidget.jsx';
const PANEL = 'src/components/AIAssistant/AiAssistantPanel.jsx';
const BUBBLE = 'src/components/AIAssistant/ChatMessageBubble.jsx';

describe('Phase 36.3 — the assistant is a widget', () => {
  test('the widget file exists and exports a component', () => {
    const source = read(WIDGET);

    assert.equal(source.includes('export default AiAssistantWidget'), true);
  });

  test('the panel file exists and exports a component', () => {
    const source = read(PANEL);

    assert.equal(source.includes('export default AiAssistantPanel'), true);
  });

  test('the old page and route are GONE', () => {
    // The floating button replaced them. Leaving a dead route behind would let
    // someone bookmark /app/ai-assistant and land on a screen the product no
    // longer advertises.
    assert.equal(
      fs.existsSync(path.join(root, 'src/pages/AIAssistant')),
      false,
      'pages/AIAssistant should no longer exist',
    );

    const routes = read('src/routes/AppRoutes.jsx');

    assert.equal(routes.includes('ai-assistant'), false, 'the route must be removed');
    assert.equal(routes.includes('AiAssistantPage'), false);
  });

  test('the sidebar entry is GONE', () => {
    // The nav group, the icon mapping and the lucide import were all added for
    // the page. The floating button is the single entry point now.
    const sidebar = read('src/layout/SidebarNav.jsx');

    assert.equal(sidebar.includes('ai-assistant'), false, 'the nav path must be removed');
    assert.equal(sidebar.includes('"ai"'), false, 'the nav group must be removed');

    const layout = read('src/layout/AppLayout.jsx');

    assert.equal(layout.includes('ai-assistant'), false, 'the nav entry must be removed');
  });

  test('the widget button carries no badge', () => {
    // The pin matched its own doc comment the first time it was written, so
    // comments are stripped before the check. A pin that matches its own
    // explanation passes while the code does whatever it likes.
    const code = read(WIDGET)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    assert.equal(code.includes('badge'), false);
    assert.equal(code.includes('unread'), false);
    assert.equal(code.includes('count'), false);
  });

  test('the panel still guards against an unregistered slice', () => {
    // The blank-screen bug of 36.3: state.aiChat was undefined and the
    // destructuring threw. The defaults are the safety net.
    const source = read(PANEL);

    assert.equal(source.includes('useSelector((state) => state.aiChat) ?? {}'), true);
    assert.equal(source.includes('messages = []'), true);
  });

  test('no emojis in the new UI code', () => {
    // House law: lucide-react icons only.
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

    for (const file of [WIDGET, PANEL, BUBBLE]) {
      const source = read(file);

      // Strip comments before checking, so an explanation that names a symbol
      // is not mistaken for one that renders it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      assert.equal(emoji.test(code), false, `${file} contains an emoji`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.4 — RETRY AND COPY
// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 36.4 — a failed turn can be retried', () => {
  test('the panel exposes a retry control on the error banner', () => {
    const source = read(PANEL);

    assert.equal(source.includes('RotateCcw'), true, 'no retry icon');
    assert.equal(source.includes('Try again'), true, 'no retry label');
    assert.equal(source.includes('onClick={retry}'), true, 'retry is not wired');
  });

  test('retry re-sends the existing conversation and adds no duplicate turn', () => {
    // The server is stateless and rebuilds the HR context itself, so the same
    // payload that just failed is the right payload to send again. Appending
    // the question a second time would read as the person having asked twice.
    const source = read(PANEL);

    assert.equal(source.includes('const retry = useCallback'), true);
    assert.equal(source.includes('sendChatMessage({'), true);

    // It dispatches the send thunk directly — NOT messageAdded, which is what
    // would duplicate the user's turn.
    const retryBlock = source.slice(
      source.indexOf('const retry = useCallback'),
      source.indexOf('const shown ='),
    );

    assert.equal(retryBlock.includes('messageAdded'), false);
  });

  test('retry is disabled while a send is in flight', () => {
    // Two in-flight requests would race for the same reply slot.
    const source = read(PANEL);

    const retryBlock = source.slice(
      source.indexOf('onClick={retry}'),
      source.indexOf('onClick={retry}') + 400,
    );

    assert.equal(retryBlock.includes('disabled={sending}'), true);
  });
});

describe('Phase 36.4 — the answer can be copied', () => {
  test('the bubble offers a copy control', () => {
    const source = read(BUBBLE);

    assert.equal(source.includes('navigator.clipboard.writeText'), true);
    assert.equal(source.includes('Copy'), true);
    assert.equal(source.includes('Copied'), true);
  });

  test('copy is opt-in per bubble, not always on', () => {
    // A button on every bubble would turn the transcript into a wall of
    // controls, so the panel passes it only for the newest answer.
    const source = read(BUBBLE);

    assert.equal(source.includes('onCopy &&'), true);
  });

  test('copy is offered on the newest assistant answer only', () => {
    const source = read(PANEL);

    assert.equal(source.includes('lastAssistantId'), true);
    assert.equal(source.includes('onCopy={'), true);
  });

  test('the copy control is never offered on the welcome message', () => {
    // The welcome text is not an answer and copying it is meaningless.
    const source = read(PANEL);

    assert.equal(source.includes("message.id !== 'welcome'"), true);
  });

  test('a failed clipboard write is swallowed, not thrown', () => {
    // The clipboard API is unavailable in insecure contexts and in some
    // embedded frames. The text stays selectable by hand, so the button
    // degrading quietly is the honest behaviour.
    const source = read(BUBBLE);

    assert.equal(source.includes('} catch {'), true);
  });
});
