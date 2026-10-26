// ═══════════════════════════════════════════════════════════════════════════
// ORGANIZATION STRUCTURE — the org chart page and the header breadcrumb.
//
// What is pinned here:
//   1. the page still reads the ONE endpoint it always read, and invents nothing;
//   2. its counters are counted from that payload, never typed;
//   3. the three views are three readings of the same tree, not three fetches;
//   4. filtering keeps the ancestors (a match with no context is not a tree);
//   5. the breadcrumb's section labels agree with the sidebar's own groups;
//   6. the page's copy stays honest — no placeholder people, no fake numbers.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const PAGE = 'src/pages/org-chart/OrgChartPage.jsx';
const BREADCRUMB = 'src/components/common/PageBreadcrumb.jsx';
const BREADCRUMB_UTIL = 'src/utils/breadcrumb.js';
const SIDEBAR = 'src/layout/SidebarNav.jsx';
const LAYOUT = 'src/layout/AppLayout.jsx';

const page = read(PAGE);
const util = read(BREADCRUMB_UTIL);
const sidebar = read(SIDEBAR);

/** Comments explain; they should not be able to satisfy a pin on their own. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('org chart — one payload, three readings', () => {
  test('it loads the hierarchy endpoint and nothing else', () => {
    const calls = [...code(page).matchAll(/api\.get\((['"`])([^'"`]+)\1\)/g)].map((m) => m[2]);
    assert.deepEqual(calls, ['/users/hierarchy'], 'the page must not invent a second data source');
  });

  test('the three views are the same tree', () => {
    for (const id of ['canvas', 'list', 'departments']) {
      assert.ok(page.includes(`id: '${id}'`), `the ${id} view exists`);
    }
    // Every view is fed from `roots` (or the filtered tree over it) — not a
    // second request, and not a hard-coded roster.
    assert.match(code(page), /<HierarchyList nodes=\{visible\} \/>/);
    assert.match(code(page), /<DepartmentGrid nodes=\{visible\} \/>/);
    assert.match(code(page), /\{visible\.map\(\(root\) => \(/);
  });

  test('the counters under the title are counted, not typed', () => {
    assert.match(code(page), /const stats = useMemo\(/);
    assert.match(code(page), /people: everyone\.length/);
    assert.match(code(page), /departments: departments\.length/);
    assert.match(code(page), /direct: \(top\?\.children \|\| \[\]\)\.length/);

    // …and they are what the pills render.
    assert.match(code(page), /value=\{stats\.people\} label="Total Members"/);
    assert.match(code(page), /value=\{stats\.departments\} label="Departments"/);
    assert.match(code(page), /value=\{stats\.direct\} label="Direct Reports"/);
  });

  test('direct reports describe the viewer, not the first root', () => {
    // An HR manager who is not the CEO must not see the CEO's report count.
    assert.match(code(page), /String\(node\._id\) === String\(user\?\._id\)/);
    assert.match(code(page), /const top = me \|\| roots\[0\]/);
  });

  test('filtering keeps the ancestors of a match', () => {
    // Searching "software" must still show the chain that leads to those
    // people, or the result is a list of orphans.
    assert.match(code(page), /const filterTree = \(nodes, \{ query, department \}\) =>/);
    assert.match(code(page), /return self \|\| children\.length \? \[\{ \.\.\.node, children \}\] : \[\]/);
  });

  test('a search that finds nobody says so, and offers the way back', () => {
    assert.match(code(page), /visibleCount === 0/);
    assert.match(code(page), /illustration="search"/);
    assert.match(code(page), /Clear filters/);
    assert.match(code(page), /onClick=\{clearFilters\}/);
  });

  test('an empty organisation uses the shared empty state, not a bare sentence', () => {
    assert.match(code(page), /import EmptyState from '\.\.\/\.\.\/components\/common\/EmptyState\.jsx'/);
    assert.match(code(page), /illustration="team"/);
  });

  test('Add Member is gated on the permission the backend enforces', () => {
    // POST /api/users is requirePermission('USER_CREATE') — the button must not
    // appear for someone the server would refuse.
    assert.match(code(page), /hasAnyPermission\(\['USER_CREATE'\]\)/);
    assert.match(code(page), /canAddMember && \(/);
  });

  test('a department is not printed twice in one line', () => {
    // The API returns designation "Human Resource" and department
    // "Human Resource"; "Human Resource · Human Resource" reads like a bug.
    assert.match(code(page), /const placementLine = \(node\) =>/);
    assert.match(
      code(page),
      /designation\.toLowerCase\(\)\.includes\(department\.toLowerCase\(\)\)\) return designation/,
    );
  });

  test('the copy stays honest', () => {
    assert.equal(/lorem ipsum/i.test(page), false);
    assert.equal(/Test User|John Doe|Jane Doe/.test(page), false, 'no placeholder people');
    assert.match(code(page), /Whole company view — reporting lines and team members across every department\./);
    // A scoped viewer is told the view is scoped.
    assert.match(code(page), /Scoped view — your department only\./);
  });
});

describe('breadcrumb', () => {
  test('it is in the header, and it is derived — never hand-maintained per page', () => {
    assert.match(read(LAYOUT), /import PageBreadcrumb from "\.\.\/components\/common\/PageBreadcrumb\.jsx"/);
    assert.match(read(LAYOUT), /<PageBreadcrumb menu=\{menu\} \/>/);
    assert.match(read(BREADCRUMB), /const current = menuItemForPath\(menu, pathname\)/);
    assert.match(read(BREADCRUMB), /const section = sectionForPath\(pathname\)/);
  });

  test('the longest prefix wins', () => {
    assert.match(util, /sort\(\(a, b\) => b\.prefix\.length - a\.prefix\.length\)/);
    assert.match(util, /sort\(\(a, b\) => b\.to\.length - a\.to\.length\)/);
  });

  test('a section is not announced twice on the dashboard', () => {
    assert.match(read(BREADCRUMB), /pathname !== '\/app'/);
    assert.match(read(BREADCRUMB), /section !== current\.title/);
  });

  test('every section label also exists as a sidebar group', () => {
    // The two lists are separate on purpose (the sidebar groups are a
    // rendering concern of SidebarNav), so this is the pin that keeps them
    // from drifting into two different vocabularies for the same place.
    const labels = [...util.matchAll(/label: '([^']+)',\s*prefixes:/g)].map((m) => m[1]);
    assert.ok(labels.length >= 8, `expected the whole app, saw ${labels.length} sections`);

    const groups = sidebar.slice(
      sidebar.indexOf('const NAV_GROUPS'),
      sidebar.indexOf('const PRIMARY_GROUPS'),
    );

    for (const label of labels) {
      assert.ok(groups.includes(`label: "${label}"`), `"${label}" is not a sidebar group label`);
    }
  });

  test('the org chart breadcrumb names the page the way the page does', () => {
    assert.match(util, /'\/app\/org-chart': 'Organization Structure'/);
    assert.match(read(BREADCRUMB), /\{current\.title\}/);
  });
});
