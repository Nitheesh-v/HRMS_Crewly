// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.10 — API PERFORMANCE BOUNDS (hermetic structural guards)
//
// §64/§65-style evidence, no hardware timing:
//   · PURE: the shared search-input helper (bounded length, literal
//     escaping — regex-injection/ReDoS-class input can never reach $regex).
//   · STRUCTURAL: the four legacy list controllers now escape+bound search,
//     hydrate with .lean(), sort with a stable _id tie-breaker, and the task
//     board payload excludes embedded comment/attachment history (sole
//     consumer TasksPage.jsx renders board fields only). Source pins follow
//     the repo's established io-less guarantee pattern (cf. 32.7 guard pin).
//   · MEASURED: synthetic payload delta of the task-board projection
//     (JSON.stringify bytes, §48 — synthetic shapes, no real data).
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/api-perf-bounds';

const { boundedSearchTerm, escapeRegExp, MAX_SEARCH_LENGTH } = await import(
  '../src/utils/searchInput.js'
);

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8');

describe('boundedSearchTerm (pure)', () => {
  test('trims and hard-caps length (presence-service law: 60 chars)', () => {
    const long = `  ${'a'.repeat(500)}  `;
    const out = boundedSearchTerm(long);
    assert.equal(out.length, MAX_SEARCH_LENGTH);
    assert.ok(out.startsWith('aaaa'));
  });

  test('escapes EVERY regex metacharacter — input matches literally', () => {
    assert.equal(escapeRegExp('.*'), '\\.\\*');
    assert.equal(boundedSearchTerm('(a+)+$'), '\\(a\\+\\)\\+\\$');
    assert.equal(boundedSearchTerm("O'Brien {2,}"), "O'Brien \\{2,\\}");
    assert.equal(boundedSearchTerm('C:\\path\\to'), 'C:\\\\path\\\\to');
  });

  test('non-string / empty input yields "" (no filter applied)', () => {
    assert.equal(boundedSearchTerm(undefined), '');
    assert.equal(boundedSearchTerm(null), '');
    assert.equal(boundedSearchTerm(42), '');
    assert.equal(boundedSearchTerm('   '), '');
  });

  test('legitimate searches survive byte-identical (no false behavior change)', () => {
    assert.equal(boundedSearchTerm('Priya Sharma'), 'Priya Sharma');
    assert.equal(boundedSearchTerm('a.b@c.com'), 'a\\.b@c\\.com'); // dot is literal in search
  });
});

describe('structural pins — legacy list controllers (32.10)', () => {
  const userController = read('controllers/userController.js');
  const taskController = read('controllers/taskController.js');
  const projectController = read('controllers/projectController.js');
  const systemController = read('controllers/systemController.js');

  test('no raw user input reaches $regex in the four controllers', () => {
    for (const [name, src] of [
      ['userController', userController],
      ['taskController', taskController],
      ['projectController', projectController],
      ['systemController', systemController],
    ]) {
      assert.doesNotMatch(src, /\$regex:\s*(search|q|req\.query\.q)\b/, `${name} must not pass raw input to $regex`);
      assert.ok(src.includes('boundedSearchTerm'), `${name} must use the shared bounded search helper`);
    }
  });

  test('task board: embedded histories excluded + lean + stable sort', () => {
    assert.ok(
      taskController.includes(".select('-comments -attachments')"),
      'task LIST must not ship comment/attachment history (detail endpoint owns it)'
    );
    assert.ok(/Task\.find\(filter\)[\s\S]{0,400}\.lean\(\)/.test(taskController), 'task list must be lean');
    assert.ok(taskController.includes('createdAt: -1, _id: -1'), 'stable pagination tie-breaker');
  });

  test('audit log list: lean + stable sort', () => {
    assert.ok(/AuditLog\.find\(filter\)[\s\S]{0,200}\.lean\(\)/.test(systemController));
    assert.ok(systemController.includes('createdAt: -1, _id: -1'));
  });

  test('project list: lean + no per-document toObject() + stable sort', () => {
    assert.ok(/Project\.find\(filter\)[\s\S]{0,400}\.lean\(\)/.test(projectController));
    assert.doesNotMatch(projectController, /p\.toObject\(\)/, 'lean spread replaced toObject()');
    assert.ok(projectController.includes('createdAt: -1, _id: -1'));
  });

  test('user list: stable sort preserved with tie-breaker', () => {
    assert.ok(userController.includes('createdAt: -1, _id: -1'));
  });

  test('select:false law untouched — no +field overrides in the OPTIMIZED LIST paths (§28)', () => {
    // Narrow +selects elsewhere in a controller (e.g. the authorized
    // kiosk-PIN boundary) are legitimate §28 service boundaries; the law
    // pin applies to the four list paths this phase touched.
    const listSlice = (src, startMark, endMark) => {
      const a = src.indexOf(startMark);
      return a === -1 ? src : src.slice(a, src.indexOf(endMark, a) === -1 ? undefined : src.indexOf(endMark, a));
    };
    const slices = [
      ['userController.listUsers', listSlice(userController, 'export const listUsers', 'export const getUser')],
      ['taskController.listTasks', listSlice(taskController, 'export const listTasks', 'export const getTask')],
      ['projectController.listProjects', listSlice(projectController, 'export const listProjects', 'export const getProject')],
      ['systemController.audit', listSlice(systemController, 'export const audit', '//')],
    ];
    for (const [name, slice] of slices) {
      assert.doesNotMatch(slice, /select\(\s*['"`]\+/, `${name} must not force hidden fields back (§28)`);
    }
  });
});

describe('payload evidence — task board projection (synthetic, §48)', () => {
  test('excluding comments+attachments shrinks a 300-row board payload', () => {
    // Synthetic board: 300 tasks, each with a realistic 4-comment history
    // and 2 attachments (attachment.storageKey is select:false already, so
    // plain reads never carried it — the URL/name/size metadata did).
    const comment = { user: 'u', name: 'Name', text: 'Please review the updated numbers with the finance team before Friday standup.', at: new Date().toISOString() };
    const attachment = { name: 'policy-document-v2.pdf', url: 'https://res.example.com/crewly/task/att', publicId: null, resourceType: 'raw', size: 48123, uploadedBy: 'u' };
    const baseTask = {
      _id: 't', title: 'Prepare monthly compliance report', status: 'IN_PROGRESS', priority: 'HIGH',
      company: 'c', project: 'p', assignedTo: { _id: 'u1', name: 'Employee One', email: 'e1@x.com', role: 'EMPLOYEE', avatarUrl: '' },
      assignedBy: { _id: 'u2', name: 'Manager Two' }, dueDate: '2026-10-01', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const withHistory = [];
    const boardOnly = [];
    for (let i = 0; i < 300; i += 1) {
      withHistory.push({ ...baseTask, comments: Array.from({ length: 4 }, () => comment), attachments: Array.from({ length: 2 }, () => attachment) });
      boardOnly.push(baseTask);
    }

    const beforeBytes = Buffer.byteLength(JSON.stringify(withHistory));
    const afterBytes = Buffer.byteLength(JSON.stringify(boardOnly));

    // Structural claim: the board payload is a small fraction of the
    // history-laden one (measured ~3.5x here; real boards carry longer
    // comment histories, so the real-world delta is larger).
    assert.ok(afterBytes < beforeBytes / 3, `board payload (${afterBytes}B) must be far below history-laden (${beforeBytes}B)`);
    assert.ok(beforeBytes > 300_000, 'synthetic board is realistically large for the measurement');
  });
});
