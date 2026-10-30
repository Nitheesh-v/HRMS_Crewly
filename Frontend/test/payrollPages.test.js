// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL — the pages that are actually mounted, and where their figures come
// from.
//
// Payroll used to be three permission-gated areas with an in-page tab strip.
// It is back to one rail row per page, so the pins below describe that shape
// instead: every screen in the folder is behind a route, every screen reads its
// numbers from the server, and the four screens that move money or file
// statutory returns are gated on the permissions the API enforces.
//
// These are deliberately structural. The design of an individual payroll page
// is allowed to change; a page that invents a figure, leaks its route, or
// forgets its permission gate is not.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const PAGES = 'src/pages/payroll';

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith('.jsx')) out.push(rel);
  }
  return out;
};

// Two files in the folder are not pages: the printable payslip document and the
// report kit the analytics screens share.
const NOT_A_PAGE = new Set([
  'src/pages/payroll/PayslipDocument.jsx',
  'src/pages/payroll/analytics/analyticsShared.jsx',
]);
const PAGES_OUT = walk(PAGES).filter((rel) => !NOT_A_PAGE.has(rel)).sort();
const routes = read('src/routes/AppRoutes.jsx');
const layout = read('src/layout/AppLayout.jsx');

describe('payroll pages', () => {
  test('every payroll screen reads its figures from the API', () => {
    // Two shapes are legitimate: the page calls a payroll service itself, or it
    // is a report that goes through analyticsShared, which owns the calls.
    const SHARED = read(`${PAGES}/analytics/analyticsShared.js`);
    assert.match(SHARED, /services\/payrollAnalyticsService\.js/, 'the report kit owns the analytics calls');

    for (const rel of PAGES_OUT) {
      const source = read(rel);
      const direct = /services\/[\w./-]+\.js/.test(source);
      const viaKit = rel.includes('/analytics/') && source.includes('./analyticsShared.js');
      assert.ok(direct || viaKit, `${rel} must read payroll data from a service, not from constants`);
    }
  });

  test('every payroll page is mounted, and nothing else frames it', () => {
    // One route per page: no tab-strip wrapper, and no page left orphaned in
    // the folder.
    assert.equal(routes.includes('inPayroll('), false, 'the tab-strip wrapper is gone');
    assert.equal(layout.includes('payrollNav'), false, 'the rail lists payroll pages one by one again');

    const mounted = [...routes.matchAll(/import\("\.\.\/pages\/payroll\/([\w/]+)\.jsx"\)/g)].map((m) => m[1]);

    for (const rel of PAGES_OUT) {
      const name = rel.replace(`${PAGES}/`, '').replace(/\.jsx$/, '');
      const lazy = mounted.includes(name);
      const imported = routes.includes(`pages/payroll/${name}.jsx`);
      assert.ok(lazy || imported, `${rel} is never mounted by the router`);
    }
  });

  test('the screens that move money or file returns carry their permission gate', () => {
    const gates = [
      ['src/pages/payroll/SalaryPaymentPage.jsx', 'PAYROLL_PAYMENT_GENERATE'],
      ['src/pages/payroll/SalaryPaymentPage.jsx', 'PAYROLL_PAYMENT_MARK_PAID'],
      ['src/pages/payroll/PayslipsPage.jsx', 'PAYSLIP_RELEASE'],
      ['src/pages/payroll/StatutoryCompliancePage.jsx', 'PAYROLL_STATUTORY_GENERATE'],
      ['src/pages/payroll/ReviewPayrollPage.jsx', 'PAYROLL_RUN_APPROVE'],
    ];
    for (const [file, permission] of gates) {
      assert.ok(
        read(file).includes(permission),
        `${file} must gate the action on ${permission}`,
      );
    }
  });

  test('the register is the payroll API, not a local list', () => {
    const center = read(`${PAGES}/PayrollPage.jsx`);
    assert.match(center, /payrollService\./, 'the register comes from payrollService');
    assert.match(center, /TableEmpty/, 'and its empty state is the shared one');
  });
});
