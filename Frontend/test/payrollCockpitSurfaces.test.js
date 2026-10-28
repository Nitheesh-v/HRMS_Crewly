// ═══════════════════════════════════════════════════════════════════════════
// THE THREE PAYROLL STAGE SURFACES — pins.
//
// Re-cut to the three supplied exports:
//   • "Monthly Payroll Inputs"        → /app/payroll/inputs
//   • "Payroll Calculation Cockpit"   → /app/payroll/run
//   • "Direct Salary Disbursement"    → /app/payroll/salary-payment
//
// The exports draw a BioHub sync, an "AI Input Health 98%", a bank gateway with
// a ₹48,50,000 float, a 2-FA OTP, envelope encryption, a dual-admin quorum and
// an NPCI certification. None of those exist in this product, so the pages keep
// the BLOCKS and state the narrower truth instead. These pins hold both halves:
// the blocks the export draws, and the honesty substitutions.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const inputs = read('src/pages/payroll/MonthlyInputsPage.jsx');
const run = read('src/pages/payroll/RunPayrollPage.jsx');
const payment = read('src/pages/payroll/SalaryPaymentPage.jsx');
const kit = read('src/components/payroll/PayrollCockpit.jsx');

const pages = [
  ['monthly inputs', inputs],
  ['run payroll', run],
  ['salary payment', payment],
];

describe('payroll stage surfaces — one shell, three stages', () => {
  test('all three read their furniture from the shared cockpit kit', () => {
    for (const [name, source] of pages) {
      assert.ok(
        source.includes("components/payroll/PayrollCockpit.jsx"),
        `${name} must use the shared cockpit kit, not its own copy of the tabs and cards`,
      );
      assert.ok(source.includes('StageBand'), `${name} must open with the stage band`);
      assert.ok(source.includes('Pipeline'), `${name} must show the four-step cycle`);
      assert.ok(source.includes('StatCard'), `${name} must show its KPI row`);
      assert.ok(source.includes('st-'), `${name} must be on the Warm Organic st- scale`);
    }

    // The kit itself carries the tokens and the lock glyph the exports draw.
    for (const needle of ['bg-st-lowest', 'text-st-on-variant', 'bg-st-primary-container', 'Lock']) {
      assert.ok(kit.includes(needle), `the cockpit kit is missing ${needle}`);
    }
  });

  test('each page names its stage of the four-step cycle', () => {
    assert.match(inputs, /Cycle stage 01 of 04/);
    assert.match(run, /Cycle stage 02 of 04/);
    assert.match(payment, /Cycle step 4 of 4/);

    // The four steps are the same four words on every page.
    for (const [name, source] of pages) {
      for (const label of ['Monthly inputs', 'Run payroll', 'Review & approval', 'Salary payment']) {
        assert.ok(source.includes(`label: '${label}'`), `${name} is missing the "${label}" step`);
      }
    }
  });

  test('every number on the three pages comes from an endpoint', () => {
    // Each page must still call its own service; a mock-faithful layout that
    // invented its figures would be worse than the screen it replaced.
    assert.ok(inputs.includes('monthlyInputService.list'), 'inputs must read the month from the API');
    assert.ok(run.includes('payrollRunService.summary') && run.includes('payrollRunService.results'));
    assert.ok(payment.includes('payrollPaymentService.dashboard'));
    assert.ok(payment.includes('payrollPaymentService.batch'), 'the roster is a read of the real batch');

    // No client-side salary arithmetic: the engine owns every amount.
    for (const [name, source] of pages) {
      assert.ok(
        !/gross\s*\*\s*0\.|basic\s*\*\s*0\.4|Math\.round\(.*\*\s*12\s*\/\s*100\)/.test(source),
        `${name} must not compute a salary or a statutory rate in the browser`,
      );
    }
  });

  test('the exports\' invented infrastructure is not printed as fact', () => {
    const forbidden = [
      ['BioHub', /BioHub/],
      ['AI health score', /AI Input Health/],
      ['gateway float', /48,50,000|Available Float/],
      ['OTC / 2-FA code entry', /Enter Authenticator App|6-Digit OTP/],
      ['cryptographic envelope claim', /256-bit TLS|NPCI \/ RBI|Dual-admin approval quorum/],
      ['Karnataka-style revision stamp', /Rev 2024\.3/],
    ];

    for (const [label, pattern] of forbidden) {
      for (const [name, source] of pages) {
        assert.ok(!pattern.test(source), `${name} must not claim ${label} — nothing backs it`);
      }
    }

    // …but the blocks they lived in are kept, with the honest state instead.
    assert.ok(payment.includes('no bank gateway connected'), 'the gateway block must say it is absent');
    assert.ok(payment.includes('Host-to-host gateway'), 'the bank connectivity panel must survive');
    assert.ok(
      payment.includes('Your finance') || payment.includes('finance team'),
      'the page must say who actually transmits the file',
    );
  });

  test('payroll inputs keeps six facts and its honest readiness', () => {
    for (const label of [
      'Employees',
      'Ready & clear',
      'Needs review',
      'Variable pay',
      'Claims total',
      'LOP days',
    ]) {
      assert.ok(inputs.includes(`label="${label}"`), `the inputs KPI row is missing "${label}"`);
    }

    // "98% AI health" → ready ÷ population, computed from the response.
    assert.ok(inputs.includes('summary.ready') && inputs.includes('summary.employees'));
    assert.ok(!inputs.includes('98%'), 'the export\'s 98% health score must not be printed');
    assert.ok(inputs.includes('Input readiness'), 'the health block survives as readiness');
  });

  test('the cockpit reports calculation facts, not a compliance verdict', () => {
    for (const label of [
      'Scope coverage',
      'Compute status',
      'Audit validation',
      'Gross earnings',
      'Net disbursable',
      'Employer overhead',
    ]) {
      assert.ok(run.includes(`label="${label}"`), `the cockpit KPI row is missing "${label}"`);
    }

    assert.ok(run.includes('Calculation health check'));
    assert.ok(
      run.includes('not a legal opinion'),
      'the health check must not read as a legal compliance verdict',
    );
    // Statutory split comes from the snapshot's own deduction lines.
    assert.ok(run.includes("line.statutory"), 'the deduction split must be read from the snapshot');
    // The page still refuses to approve or pay.
    assert.ok(run.includes('/app/payroll/review'), 'the cockpit must hand off to review, not approve');
  });

  test('disbursement keeps its six facts and never promises a bank transfer', () => {
    for (const label of [
      'Total disbursable',
      'Paid & transferred',
      'Pending bank exec',
      'Bounced transfers',
      'Retry required',
      'Bank files generated',
    ]) {
      assert.ok(payment.includes(`label="${label}"`), `the payment KPI row is missing "${label}"`);
    }

    assert.ok(payment.includes('Payment batches & transfer schedules'));
    assert.ok(payment.includes('Disbursement recipient roster'));
    assert.ok(payment.includes('masked'), 'the roster must say the account is masked');
    assert.ok(
      !payment.includes('Authorize Direct API Disbursement'),
      'there is no gateway to authorise — that button must not exist',
    );
  });

  test('the surfaces are reachable and still behind the payroll tab strip', () => {
    const routes = read('src/routes/AppRoutes.jsx');
    for (const route of ['payroll/inputs', 'payroll/run', 'payroll/salary-payment']) {
      assert.ok(routes.includes(`path="${route}"`), `${route} must stay a route`);
    }
    assert.ok(
      routes.includes('inPayroll('),
      'the pages must keep the in-page payroll strip from the navigation change',
    );
  });
});
