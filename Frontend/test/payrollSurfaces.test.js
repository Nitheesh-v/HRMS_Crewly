// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL SURFACES — Payroll & Compensation Center · Salary Architecture
//
// Two Stitch exports were re-cut onto live payroll responses:
//
//   · "Payroll Processing & Payslip Hub"      → /app/payroll
//   · "Configuration & Salary Architecture"   → /app/payroll/components
//
// The mocks draw a hardware security key, a dual-admin 2-FA handshake, a bank
// gateway "balance", MCA/NSDL/EPFO verification badges, a statutory revision
// stamp, a Form 16 archive and a compliance verdict. None of those exist in
// the API, so the pages keep the blocks and print the reason instead of the
// number. The pins below hold that line, and hold every figure to an endpoint.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const center = read('src/pages/payroll/PayrollPage.jsx');
const architecture = read('src/pages/payroll/SalaryComponentsPage.jsx');

const pages = [
  ['payroll center', center],
  ['salary architecture', architecture],
];

const has = (source, needle, why) =>
  assert.ok(source.includes(needle), `${why} — expected to find: ${needle}`);
const hasNot = (source, needle, why) =>
  assert.ok(!source.includes(needle), `${why} — must not contain: ${needle}`);

describe('payroll surfaces — one token set, one product', () => {
  test('both pages are on the Warm Organic st- scope', () => {
    for (const [name, source] of pages) {
      has(source, 'st-surface', `${name} uses the st- surface token`);
      has(source, 'bg-st-lowest', `${name} builds cards from st- tokens`);
      hasNot(source, 'bg-white/', `${name} has no dark-only white wash`);
      hasNot(source, 'border-white/', `${name} has no dark-only white hairline`);
      assert.equal(/crewly-/.test(source), false, `${name} is migrated off crewly- tokens`);
    }
  });

  test('no currency literal survives from the mock', () => {
    for (const [name, source] of pages) {
      assert.equal(/₹18,45,200|₹2,03,500|₹7,33,351|₹12,00,000/.test(source), false,
        `${name} prints no hard-coded mock money`);
    }
  });
});

describe('payroll center — every figure has an endpoint', () => {
  test('the run, its total and the per-employee lines are API reads', () => {
    has(center, 'payrollRunService.summary(month)', 'the run summary is the API');
    has(center, 'payrollRunService.results(month)', 'the register is the API');
    has(center, 'payrollRunService.result(month, row.employeeId)', 'the drawer is one stored result');
    has(center, 'payrollRunService.run(month)', 'execution is a real call');
  });

  test('the KPI cards derive from the result rows, not from constants', () => {
    has(center, "row?.totals?.netPay", 'net pay comes from the row');
    has(center, "statutorySum(row.deductions)", 'statutory split reads the engine’s own lines');
    has(center, "lineOf(row.deductions, 'LOP')", 'LOP amount is the engine’s line');
    has(center, "row?.attendance?.lopDays", 'and its day count is the snapshot’s');
    has(center, 'const figures = useMemo', 'all of it is computed, once');
  });

  test('approval, payment, bank and attendance each name their source', () => {
    has(center, 'payrollReviewService.dashboard(month)', 'approval posture is the review API');
    has(center, 'payrollPaymentService.dashboard(month)', 'disbursement is the payment API');
    has(
      center,
      'to="/app/payroll/salary-payment"',
      'the audit trail and the batch itself live in the payment workspace, linked from here',
    );
    has(center, 'payrollSetupService.get()', 'the company bank account is the setup API');
    has(center, 'attendanceService.analyticsOverview({ month })', 'the reconciliation strip is attendance');
    has(center, 'monthlyInputService.periods()', 'the cycle state is the periods API');
    has(center, 'payslipService.mine()', 'the self-service card is the employee’s own payslips');
  });

  test('a disbursement is authorised by permission, and the mock’s hardware key is refused', () => {
    has(center, 'PAYROLL_PAYMENT_GENERATE', 'bank-file generation is permission gated');
    has(center, 'PAYROLL_PAYMENT_MARK_PAID', 'marking paid is permission gated');
    has(center, 'no security-key handshake or dual-admin token', 'and the absence is stated');
    has(center, 'Finance holds this step.', 'a non-finance role sees who owns it');
    hasNot(center, 'Security Key Ready', 'the mock badge does not survive');
    hasNot(center, '2-FA', 'nor its two-factor claim');
  });

  test('the bank card is masked at the source and claims no balance', () => {
    has(center, 'maskedAccountNumber', 'the masked number is what the API returns');
    hasNot(center, 'Balance ₹42,80,000', 'no invented gateway balance');
    has(center, 'Batch ledger', 'the ledger line is the batch summary');
  });

  test('a mock control with no endpoint is labelled, never faked', () => {
    has(center, 'Form 16 — not configured', 'the Form 16 archive is named as absent');
    has(center, 'No Form 16 archive endpoint exists in this build', 'with the reason on the control');
    has(center, 'What this screen refuses to invent', 'the honesty rail is kept');
    has(center, 'confidence percentile', 'no invented confidence score');
    has(center, 'no CIN/PAN/TAN verification badge', 'no invented legal-identifier verdict');
  });

  test('the register is filterable and its footer names its own scope', () => {
    has(center, 'const filtered = useMemo', 'the table filters the response');
    has(center, 'Total net for these', 'the footer sums only the visible rows');
    has(center, '(subset)', 'and says so');
    has(center, 'TableEmpty', 'an empty run uses the shared empty state');
  });
});

describe('salary architecture — components, setup and a real preview', () => {
  test('the catalogue and its filters are the component API', () => {
    has(architecture, 'salaryComponentService.list({', 'the catalogue is the API');
    has(architecture, 'calculationType:', 'the formula filter is a real query parameter');
    has(architecture, 'taxability:', 'so is the tax filter');
    has(architecture, 'salaryComponentService.createDefaults()', 'the CTC bundle is a real call');
  });

  test('the completion strip is the setup evaluation, section by section', () => {
    has(architecture, 'payrollSetupService.get()', 'setup is the API');
    has(architecture, 'evaluation?.sections', 'sections come from the response');
    has(architecture, 'evaluation?.completedCount', 'so does the completion count');
    has(architecture, 'config?.legal', 'the legal identity is stored configuration');
    has(architecture, 'statutoryOn', 'statutory applicability is read, not assumed');
    has(architecture, 'maskedAccountNumber', 'the payout account stays masked');
    has(architecture, 'No rule revision badge', 'no invented statutory revision stamp');
  });

  test('the CTC builder posts to the preview engine', () => {
    has(architecture, '.preview({', 'preview is a server call');
    has(architecture, 'items: (selectedStructure.items || []).map', 'built from the structure’s own items');
    has(architecture, 'gross: Number(sampleGross) || 0', 'against the sample gross the user types');
    has(architecture, 'previewTotals.netPay', 'take-home is the computed one');
    has(architecture, 'Nothing is stored', 'and the rail says the preview persists nothing');
    has(architecture, 'No saved structure to price', 'with an honest empty rail');
  });

  test('the mock’s compliance verdict becomes a configuration check', () => {
    has(architecture, 'Configuration check', 'the block is kept');
    has(architecture, 'It is a structural check', 'and its limits are stated');
    hasNot(architecture, 'Code on Wages 2019', 'no legal verdict is claimed');
    hasNot(architecture, 'MCA V3 Portal', 'no registry verification is claimed');
    hasNot(architecture, 'NSDL Records', 'nor NSDL');
    hasNot(architecture, 'Karnataka', 'nor a revision number');
  });

  test('deactivation is never described as a delete', () => {
    has(architecture, 'nothing is deleted', 'the confirm dialog is explicit');
    has(architecture, 'Historical payroll and every stored snapshot stay unchanged', 'and scoped');
  });
});
