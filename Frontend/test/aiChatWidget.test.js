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
const SIDEBAR = 'src/layout/SidebarNav.jsx';

/*
 * THE SOURCE, WITH COMMENTS STRIPPED.
 *
 * A ban on a token will otherwise match the comment that explains the ban.
 * That is not hypothetical: the "not modal" tests below failed on their first
 * run because the widget's own header comment says it used to be
 * `fixed inset-0` with a `bg-black/50` backdrop. The pin was right and the
 * comment was in the way.
 *
 * Same helper aiSettings.test.js and aiVoice.test.js use, for the same reason.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

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

// ── THE PANEL IS NOT MODAL ──────────────────────────────────────────────────
//
// The assistant used to open as `fixed inset-0` with a full-screen
// `bg-black/50` backdrop, which dimmed and blocked the entire page. Opening
// the assistant to ask about a leave balance meant losing sight of the leave
// page you were reading — the exact thing you opened it for.
//
// It now sits in the corner where the button was, sized to the viewport, and
// the page behind it stays live and clickable.

describe('Phase 36.7 — the assistant does not take over the page', () => {
  // code(), NOT read(): these are BANS, and a ban matches the comment that
  // explains it. The widget's header comment says it used to be
  // `fixed inset-0` with a `bg-black/50` backdrop, which is exactly what is
  // being asserted absent.
  const source = () => code(WIDGET);

  test('the panel is not marked modal, because it is not one', () => {
    // `aria-modal` was a claim the markup did not back up: there was never a
    // focus trap, so a screen-reader user was told the rest of the page was
    // inert while it was not.
    assert.equal(source().includes('aria-modal'), false);
  });

  test('there is no full-screen backdrop dimming the page', () => {
    const widget = source();

    // No inset-0 container and no dimming layer behind the panel.
    assert.equal(widget.includes('inset-0'), false);
    assert.equal(widget.includes('bg-black'), false);
  });

  test('the panel is sized to the viewport rather than to the screen', () => {
    // `calc(100vh-8rem)` keeps the top edge clear on a short screen and
    // `max-h` stops it becoming a full-height column on a tall one. The old
    // `h-[85vh]` inside an inset-0 flex box only worked because the box, not
    // the panel, was doing the positioning.
    const widget = source();

    assert.equal(widget.includes('h-[calc(100vh-8rem)]'), true);
    assert.equal(widget.includes('max-h-[600px]'), true);
    assert.equal(widget.includes('max-w-[calc(100vw-2.5rem)]'), true);
  });

  test('Escape still closes it, which is the keyboard way out', () => {
    // Non-modal does not mean un-dismissable. The handler is attached only
    // while the panel is open, so it can never swallow an Escape meant for
    // something else on the page.
    const widget = source();

    assert.equal(widget.includes("event.key === 'Escape'"), true);
    assert.equal(widget.includes('if (!open) return undefined;'), true);
  });

  test('clicking the page does NOT close the panel', () => {
    // A panel that vanishes the moment you click your own work is a panel you
    // stop trusting. The close affordances are the X and Escape, and nothing
    // else — pinned here so nobody re-adds a backdrop "for convenience".
    const widget = source();

    assert.equal(/onClick=\{close\}/.test(widget), false);
  });
});

// ── ONE GREETING, NOT TWO ───────────────────────────────────────────────────
//
// The empty state used to exist twice: the welcome bubble in the conversation
// and a "Welcome to CREWLY HR Assistant" card in the footer. The card repeated
// most of the bubble's sentence, and between them they pushed the input to the
// very bottom edge of a 600px panel with a blank conversation above it.

describe('Phase 36.7 — the empty state is one surface, not two', () => {
  const source = () => read(PANEL);

  test('there is no second welcome card in the footer', () => {
    const panel = source();

    assert.equal(panel.includes('Welcome to CREWLY HR Assistant'), false);
    assert.equal(panel.includes('Ask about your own leave, attendance'), false);
  });

  test('the badges and example chips live in the conversation area', () => {
    // Under the welcome bubble, inside the scroll container, so they read as
    // part of the conversation rather than as a toolbar above the input.
    const panel = source();

    const scrollArea = panel.slice(
      panel.indexOf('overflow-y-auto'),
      panel.indexOf('<ChatInputBar'),
    );

    assert.equal(scrollArea.includes('ONBOARDING_BADGES'), true);
    assert.equal(scrollArea.includes('ONBOARDING_SECTIONS'), true);
  });

  test('the input sits directly under the conversation', () => {
    // The footer holds the input and nothing else, so what you type is
    // adjacent to what was just said.
    const panel = source();

    const footer = panel.slice(panel.indexOf('<ChatInputBar'));

    assert.equal(footer.includes('ONBOARDING'), false);
    assert.equal(footer.includes('ONBOARDING_BADGES'), false);
  });

  test('the welcome bubble is still the greeting', () => {
    // The bubble stays, so the `'welcome'` id that gates copy and auto-speak
    // keeps meaning something.
    const panel = source();

    assert.equal(panel.includes("id: 'welcome'"), true);
  });
});

// ── THE LANGUAGE SELECTOR NO LONGER SAYS "ENGLISH — ENGLISH" ────────────────

describe('Phase 36.7 — the language option text is not printed twice', () => {
  const source = () => read(PANEL);

  test('the native script is shown only when it differs from the label', () => {
    // English and Tanglish have label === native, so the old
    // `{entry.label} — {entry.native}` rendered "English — English" as the
    // default option. It looked like a rendering bug to everyone who saw it.
    const panel = source();

    assert.equal(panel.includes('{entry.label} — {entry.native}'), false);
    assert.equal(panel.includes('entry.label === entry.native'), true);
  });

  test('a language whose script differs still shows both', () => {
    // Tamil must still read "Tamil — தமிழ்": the script is the whole point of
    // showing it.
    const panel = source();

    assert.equal(panel.includes('`${entry.label} — ${entry.native}`'), true);
  });
});

// ── THE ASSISTANT IS REACHABLE FROM THE SIDEBAR ─────────────────────────────
//
// 36.3 shipped it as its own route. The owner asked for the floating widget
// instead, and the route, the nav group and the icon were removed. Now they
// have asked for a sidebar entry back — so the entry returns, but the PAGE
// does not: this is a button that opens the panel, not a NavLink to a route.

describe('Phase 36.7 — the assistant has a sidebar entry', () => {
  const source = () => code(SIDEBAR);

  test('the sidebar renders an assistant entry', () => {
    const sidebar = source();

    assert.equal(sidebar.includes('renderAssistant'), true);
    assert.equal(sidebar.includes('HR Assistant'), true);
    assert.equal(sidebar.includes('dispatch(openAssistantPanel())'), true);
  });

  test('it is a BUTTON, not a link — the page stays removed', () => {
    // 36.3b removed the route on the owner's instruction and it stays removed.
    // This opens the panel; it does not navigate to /app/ai-assistant.
    const sidebar = source();

    // Bounded to the function itself. Slicing to the end of the file instead
    // would sweep up every NavLink in the sidebar below it and fail for the
    // wrong reason.
    const entry = sidebar.slice(
      sidebar.indexOf('const renderAssistant'),
      sidebar.indexOf('const renderItem'),
    );

    assert.equal(entry.includes('NavLink'), false);
    assert.equal(sidebar.includes('/app/ai-assistant'), false);
  });

  test('it is TOP-LEVEL, not nested inside any group', () => {
    // An assistant you consult from any screen does not belong under "Me" or
    // under "Work", and burying it inside a collapsed group is how a feature
    // becomes undiscoverable.
    const sidebar = source();

    const groups = sidebar.slice(
      sidebar.indexOf('const NAV_GROUPS'),
      sidebar.indexOf('const PRIMARY_GROUPS'),
    );

    assert.equal(groups.includes('assistant'), false);
    assert.equal(groups.includes('HR Assistant'), false);
  });

  test('it sits OUTSIDE the <nav>, so search cannot hide it', () => {
    // The page search filters the nav. An entry that lives inside it would
    // vanish the moment someone typed a query, and would scroll out of reach
    // on a long list.
    const sidebar = source();

    const call = sidebar.indexOf('{renderAssistant(');
    const nav = sidebar.indexOf('<nav');

    assert.notEqual(call, -1);
    assert.notEqual(nav, -1);
    assert.equal(call < nav, true);
  });

  test('it is rendered in the collapsed rail too', () => {
    // A sidebar that narrows to icons must not lose the assistant, or it is
    // only reachable on a wide screen.
    const sidebar = source();

    assert.equal(sidebar.includes('{renderAssistant(collapsed)}'), true);
    assert.equal(sidebar.includes('renderAssistant(true)'), false);
  });

  test('the mobile drawer closes before the panel opens', () => {
    // Otherwise the panel would appear underneath the drawer on a phone.
    const sidebar = source();

    const entry = sidebar.slice(
      sidebar.indexOf('onClick={() => {'),
      sidebar.indexOf('dispatch(openAssistantPanel())'),
    );

    assert.equal(entry.includes('handleNav();'), true);
  });
});

// ── THE WIDGET NO LONGER OWNS THE STATE ─────────────────────────────────────

describe('Phase 36.7 — the widget reads the shared open state', () => {
  const source = () => code(WIDGET);

  test('the open state comes from Redux, not from local useState', () => {
    // This is the whole reason the sidebar entry could not exist before: the
    // flag lived inside the widget, so nothing outside it could set it.
    const widget = source();

    assert.equal(widget.includes('useSelector'), true);
    assert.equal(widget.includes('state.aiChat?.panelOpen === true'), true);
    assert.equal(widget.includes('useState'), false);
  });

  test('both the floating button and the close control dispatch actions', () => {
    const widget = source();

    assert.equal(widget.includes('dispatch(openAssistantPanel())'), true);
    assert.equal(widget.includes('dispatch(closeAssistantPanel())'), true);
  });

  test('the floating button is still there, and is not the only way in', () => {
    // The sidebar entry is an ADDITION. The corner button stays, because it is
    // the affordance that works on every screen without hunting for a menu.
    const widget = source();

    assert.equal(widget.includes('fixed bottom-5 right-5 z-40'), true);
    assert.equal(widget.includes('Open the HR assistant'), true);
  });
});
