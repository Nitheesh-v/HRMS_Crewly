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

  test('the widget is mounted in AppLayout, once', () => {
    // Mounted here so it is reachable from EVERY authenticated page. Mounted
    // once, because two instances would mean two conversations.
    const layout = read('src/layout/AppLayout.jsx');

    const mounts = layout.match(/<AiAssistantWidget\s*\/>/g) || [];

    assert.equal(mounts.length, 1, `expected 1 mount, found ${mounts.length}`);
    assert.equal(layout.includes('import AiAssistantWidget'), true);
  });

  test('the widget renders a floating, fixed button', () => {
    const source = read(WIDGET);

    // `fixed bottom-* right-*` is what makes it float over the page rather than
    // sit in the layout flow.
    assert.match(source, /fixed bottom-\d+ right-\d+/);
    assert.equal(source.includes('aria-label="Open the HR assistant"'), true);
  });

  test('the widget opens a modal dialog', () => {
    const source = read(WIDGET);

    assert.equal(source.includes('role="dialog"'), true);
    assert.equal(source.includes('aria-modal="true"'), true);
    assert.equal(source.includes('<AiAssistantPanel'), true);
  });

  test('Escape closes the panel, and only while it is open', () => {
    const source = read(WIDGET);

    assert.equal(source.includes("event.key === 'Escape'"), true);
    assert.equal(
      source.includes('if (!open) return undefined;'),
      true,
      'the listener must not be attached while closed, or it swallows Escape',
    );
  });

  test('the button hides while the panel is open', () => {
    // Two affordances for one action is noise.
    const source = read(WIDGET);

    assert.equal(source.includes('{!open && ('), true);
  });

  test('the widget carries NO fake notification badge', () => {
    // The reference product shows a count badge on its button. Nothing here
    // generates a count, so a badge would be a lie told in the corner of every
    // screen. Pinned so it is not added for looks.
    //
    // Comments are stripped first: the explanation below legitimately NAMES the
    // thing it is forbidding, and a pin that matched its own comment would pass
    // while the code did whatever it liked.
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

    for (const file of [WIDGET, PANEL]) {
      const source = read(file);

      // Strip comments before checking, so an explanation that names a symbol
      // is not mistaken for one that renders it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      assert.equal(emoji.test(code), false, `${file} contains an emoji`);
    }
  });
});
