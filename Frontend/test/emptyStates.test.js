// ═══════════════════════════════════════════════════════════════════════════
// EMPTY STATES — pins for the shared illustration + empty-state components.
//
// Before this pass every module invented its own way of saying "nothing here
// yet": a bare `text-crewly-dim` paragraph, a dashed border, a lone lucide icon,
// sometimes a sentence with an exclamation mark. The screens that carry the most
// weight for a brand new workspace were the least designed.
//
// These pins protect the three things the sweep depends on:
//   1. one art module, original, offline, no third-party assets;
//   2. one component that owns the composition (art → headline → line → CTA);
//   3. actual adoption — the pages keep using it instead of drifting back.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const srcDir = path.join(root, 'src');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const ILLUSTRATIONS = 'src/components/common/EmptyIllustration.jsx';
const EMPTY_STATE = 'src/components/common/EmptyState.jsx';

// Walk src/ once and hand every caller the same list of JSX/JS modules.
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
};

const MODULES = walk(srcDir);
const rel = (full) => path.relative(root, full).split(path.sep).join('/');
const SOURCES = MODULES.map((full) => ({ file: rel(full), text: fs.readFileSync(full, 'utf8') }));

const art = read(ILLUSTRATIONS);
const emptyState = read(EMPTY_STATE);

// The scenes are declared as `name: () => (` entries in the scenes map.
const SCENE_KEYS = [...art.matchAll(/^ {2}([a-zA-Z]+): \(\) => \(/gm)].map((m) => m[1]);

describe('empty-state art', () => {
  test('is one original SVG module — no bitmaps, no remote assets', () => {
    assert.ok(art.includes('<svg'), 'art module must draw inline SVG');
    assert.ok(!/<img\b/.test(art), 'no <img> tags: the art is vector, drawn in the repo');
    assert.ok(!/https?:\/\//.test(art), 'no remote URLs inside the art module');
    assert.ok(
      !/\.(png|jpe?g|gif|webp)\b/.test(art),
      'no bitmap assets: nothing to download and no third-party licence to carry',
    );
    assert.ok(
      !/storyset\.com/i.test(art),
      'Storyset was a style reference only — its assets must not be vendored',
    );
    assert.ok(!/<image\b/.test(art), 'no embedded or linked raster layers');
  });

  test('every scene shares one 320×200 frame so panels line up', () => {
    assert.ok(art.includes('viewBox="0 0 320 200"'));
    assert.equal((art.match(/viewBox=/g) || []).length, 1, 'one viewBox, one frame');
  });

  test('is decorative and silent to assistive tech', () => {
    assert.ok(art.includes('aria-hidden="true"'));
    assert.ok(art.includes('focusable="false"'));
    assert.ok(!art.includes('role="img"'), 'the scene must not pretend to be content');
  });

  test('ships the full scene set', () => {
    assert.ok(SCENE_KEYS.length >= 14, `expected at least 14 scenes, found ${SCENE_KEYS.length}`);
    for (const name of [
      'inbox',
      'calendar',
      'payslip',
      'team',
      'documents',
      'chat',
      'tasks',
      'chart',
      'bell',
      'box',
      'search',
      'shield',
      'hiring',
      'wallet',
    ]) {
      assert.ok(SCENE_KEYS.includes(name), `missing scene: ${name}`);
    }
  });

  test('every illustration name used in the app resolves to a real scene', () => {
    const used = new Set();
    for (const { text } of SOURCES) {
      for (const match of text.matchAll(/illustration=["'{]?([a-zA-Z]+)["'}]?/g)) {
        // Dynamic props such as illustration={rows.length ? 'payslip' : 'search'}
        // are captured separately below; skip anything that is not a scene key.
        if (SCENE_KEYS.includes(match[1])) used.add(match[1]);
      }
      for (const match of text.matchAll(/illustration=\{[^}]*(?:'([a-zA-Z]+)'|"([a-zA-Z]+)")/g)) {
        const name = match[1] || match[2];
        if (name) used.add(name);
      }
    }
    assert.ok(used.size >= 10, `expected broad scene use, saw ${used.size}`);
    for (const name of used) {
      assert.ok(SCENE_KEYS.includes(name), `unknown scene referenced in the app: ${name}`);
    }
  });

  test('the palette stays inside the app theme', () => {
    for (const colour of ['#3fb950', '#58a6ff', '#a371f7', '#f0a35e']) {
      assert.ok(art.includes(colour), `scene palette must include ${colour}`);
    }
    // The ink is a theme token now (`--art-ink-rgb`): the scenes have to read on
    // the dark card and on the light theme's paper, so the neutral tones come
    // from CSS instead of a hard-coded colour. The accent hexes above stay
    // because they are the illustration's own palette, legible on both.
    assert.ok(art.includes('rgba(var(--art-ink-rgb)'), 'ink is the app text colour, via the theme token');
    assert.ok(art.includes('var(--art-plate)'), 'the little dark plate is a theme token too');
  });
});

describe('empty-state component', () => {
  test('exports the panel and the table-body variant', () => {
    assert.ok(/export const TableEmpty/.test(emptyState));
    assert.ok(/export default EmptyState/.test(emptyState));
    assert.ok(emptyState.includes("import EmptyIllustration from './EmptyIllustration.jsx'"));
  });

  test('owns the composition: art, headline, line, optional action', () => {
    const order = ['<EmptyIllustration', '<p className="mt-3 text-sm font-semibold', '{description ?', '{action ?'];
    let cursor = -1;
    for (const part of order) {
      const at = emptyState.indexOf(part, cursor + 1);
      assert.ok(at > cursor, `${part} must come after the previous element`);
      cursor = at;
    }
  });

  test('sizes map to shared frames and paddings', () => {
    assert.ok(/sm: 'h-24 w-40'/.test(emptyState));
    assert.ok(/md: 'h-36 w-56'/.test(emptyState));
    assert.ok(/lg: 'h-44 w-72'/.test(emptyState));
    assert.ok(/sm: 'py-6'/.test(emptyState));
    assert.ok(/md: 'py-10'/.test(emptyState));
    assert.ok(/lg: 'py-14'/.test(emptyState));
  });

  test('TableEmpty keeps the columns of an empty table', () => {
    assert.ok(/<tr>/.test(emptyState));
    assert.ok(/colSpan=\{colSpan\}/.test(emptyState));
  });

  test('the component module exports components only (fast-refresh safe)', () => {
    const exported = [...emptyState.matchAll(/^export (?:const|default) ([A-Za-z]+)/gm)].map((m) => m[1]);
    assert.deepEqual(exported.sort(), ['EmptyState', 'TableEmpty']);
  });

  test('no exclamation marks — the copy stays calm', () => {
    assert.ok(!/['"`][^'"`\n]*!/.test(emptyState.replace(/\/\/.*$/gm, '')));
  });
});

describe('adoption across the app', () => {
  const adopters = SOURCES.filter(({ text }) => /common\/EmptyState\.jsx/.test(text));

  test('the shared empty state is used across modules, not in one corner', () => {
    assert.ok(
      adopters.length >= 50,
      `expected the sweep to reach at least 50 modules, found ${adopters.length}`,
    );
  });

  test('representative screens from every major module are converted', () => {
    const files = adopters.map((entry) => entry.file);
    for (const file of [
      'src/pages/dashboard/DashboardPage.jsx',
      'src/pages/leaves/LeavesPage.jsx',
      'src/pages/leaves/LeaveApprovalsPage.jsx',
      'src/pages/attendance/AttendanceReportPage.jsx',
      'src/pages/payroll/ReviewPayrollPage.jsx',
      'src/pages/payroll/analytics/analyticsShared.jsx',
      'src/pages/recruitment/RequisitionsPage.jsx',
      'src/pages/documents/EmployeeFilesPage.jsx',
      'src/pages/security/AuditLogsPage.jsx',
      'src/pages/users/UsersPage.jsx',
      'src/pages/billing/BillingPage.jsx',
      'src/components/chat/MessageList.jsx',
    ]) {
      assert.ok(files.includes(file), `${file} must use the shared empty state`);
    }
  });

  test('the payroll analytics reports all funnel through one empty state', () => {
    const shared = read('src/pages/payroll/analytics/analyticsShared.jsx');
    assert.ok(shared.includes('EmptyStateArt'));
    assert.ok(shared.includes('emptyIllustration'), 'DataTable must accept an illustration');
    assert.ok(!shared.includes("icon: Icon = Inbox"), 'the lone-icon version must be gone');
  });

  test('retired copy is gone from the source', () => {
    for (const retired of [
      'No payslip yet — payroll runs monthly',
      'No projects in your scope yet — create the first one!',
      'No tickets here. Need help? Raise one!',
      'No users found.',
      'No payroll for {month} yet — click Generate.',
    ]) {
      const found = SOURCES.some(({ text }) => text.includes(retired));
      assert.ok(!found, `retired empty-state copy still present: ${retired}`);
    }
  });
});
