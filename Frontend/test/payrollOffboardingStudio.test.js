// ═══════════════════════════════════════════════════════════════════════════
// OFFBOARDING · SETUP · PAYSLIP STUDIO — pins.
//
// Re-cut to the three supplied exports:
//   • "Full & Final Settlement Command Center" → /app/payroll/final-settlement
//   • "Payroll Setup & Statutory Onboarding"   → /app/payroll/setup
//   • "Payslips Workspace & Bulk Studio"       → /app/payroll/payslips
//
// The exports draw a settlement pool in escrow, "Department Clearance 4 of 4
// signed" with named people, an SLA window, KYC verified against NSDL and MCA,
// a 92% "compliance confidence", a bank handshake, an AES-256 encrypted ZIP, a
// bounce rate and an SMTP-verified delivery panel. None of that exists in the
// endpoints these pages read, so the pages keep the BLOCKS, say the narrower
// truth, and are deliberately lighter than the exports.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const fnf = read('src/pages/payroll/FinalSettlementPage.jsx');
const setup = read('src/pages/payroll/PayrollSetupPage.jsx');
const payslips = read('src/pages/payroll/PayslipsPage.jsx');

const pages = [
  ['final settlement', fnf],
  ['payroll setup', setup],
  ['payslips', payslips],
];

describe('offboarding · setup · payslips — one shell, less on screen', () => {
  test('all three use the shared cockpit kit', () => {
    for (const [name, source] of pages) {
      assert.ok(
        source.includes('components/payroll/PayrollCockpit.jsx'),
        `${name} must use the shared cockpit kit`,
      );
      assert.ok(source.includes('StageBand'), `${name} must open with the stage band`);
      assert.ok(source.includes('Panel'), `${name} must use the shared panel`);
      assert.ok(source.includes('st-'), `${name} must be on the Warm Organic st- scale`);
    }
  });

  test('no page repeats an exported claim it cannot back', () => {
    for (const ghost of [
      'AES-256',
      'SMTP Verified',
      'Bounce Rate',
      'KYC Verified',
      'NSDL',
      'Escrow',
      'Compliance Confidence',
      'Auto-save active',
      'ISO-27001',
      'maker-checker',
    ]) {
      for (const [name, source] of pages) {
        assert.ok(!source.includes(ghost), `${name} must not claim "${ghost}"`);
      }
    }
  });
});

describe('final settlement — five cards, one queue, one breakdown', () => {
  test('the dashboard counters come from settlementKpis', () => {
    for (const needle of [
      'kpis.pendingSettlements',
      'kpis.hrReview',
      'kpis.financeApproval',
      'kpis.paid',
      'kpis.totalSettlementAmount',
    ]) {
      assert.ok(fnf.includes(needle), `the settlement dashboard must read ${needle}`);
    }
    assert.ok(fnf.includes('StatCard'), 'the counters must be the shared stat cards');
  });

  test('the queue shows real exit facts and the clearance count', () => {
    assert.ok(fnf.includes('row.lastWorkingDate'), 'each row must show the real last working day');
    assert.ok(fnf.includes('checklistProgress'), 'the clearance count must come from the record');
    assert.ok(fnf.includes('row.netSettlement'), 'each row must show the calculated net');
  });

  test('the line-by-line panel is the same read as the detail tab', () => {
    assert.ok(fnf.includes('fnfService\n      .get('), 'the breakdown must be a server read');
    assert.ok(
      fnf.includes('spotlight.totals?.netSettlement'),
      'the net must be the stored total, not a browser subtraction',
    );
    assert.ok(fnf.includes('CHECKLIST_LABELS'), 'clearances must be named from the real checklist');
  });

  test('an empty pipeline says so instead of drawing sample exits', () => {
    assert.ok(fnf.includes('No settlements yet'), 'the queue needs an honest empty state');
    assert.ok(
      fnf.includes('A final settlement starts from an approved resignation'),
      'the empty state must explain where a settlement comes from',
    );
  });
});

describe('payroll setup — four steps, no fake assurance', () => {
  test('progress is the completed-section count the API evaluates', () => {
    assert.ok(setup.includes('evaluation?.completedCount'), 'progress must be the evaluated count');
    assert.ok(setup.includes('evaluation?.totalCount'), 'progress must know the denominator');
    assert.ok(setup.includes('evaluation?.sections'), 'each card reads its own section state');
  });

  test('each step card shows saved values only', () => {
    assert.ok(setup.includes('FACTS_FOR'), 'the per-step facts must be a single data-driven map');
    assert.ok(setup.includes('config.legal.legalName'), 'legal facts come from the saved config');
    assert.ok(setup.includes('summary?.bank?.maskedAccountNumber'), 'the account stays masked');
    assert.ok(setup.includes('STEP_HINTS'), 'each step must explain itself in plain words');
  });

  test('a suspended configuration is an actionable state, not a wall', () => {
    assert.ok(setup.includes("status === 'SUSPENDED'"), 'suspended payroll must be recognised');
    assert.ok(setup.includes('Reactivate payroll'), 'reactivation must be offered where permitted');
  });
});

describe('payslips — a list, a counter row, one archive', () => {
  test('the counters read the payslip summary', () => {
    for (const needle of [
      'summary.totalPayslips',
      'summary.emailed',
      'summary.downloaded',
      'summary.failed',
      'summary.totalNetSalary',
    ]) {
      assert.ok(payslips.includes(needle), `the payslip counters must read ${needle}`);
    }
  });

  test('each row is one person, one net, one PDF', () => {
    assert.ok(payslips.includes('row.netSalary'), 'the row must show the frozen net');
    assert.ok(payslips.includes('row.status'), 'the row must show its delivery state');
    assert.ok(payslips.includes('downloadOne(row)'), 'the row must download the real PDF');
  });

  test('an empty archive is not offered as a download', () => {
    assert.ok(
      payslips.includes('Empty archive — build it again once payslips exist'),
      'a zero-payslip archive must say so instead of downloading an empty ZIP',
    );
    assert.ok(
      payslips.includes('Number(newestArchive.total) > 0'),
      'the download button must be conditional on the archive holding files',
    );
  });

  test('a failed download reports the server sentence, not the status code', () => {
    const api = read('src/services/api.js');
    assert.ok(api.includes('readBlobMessage'), 'a Blob error body must be read back');
    assert.ok(
      api.includes('error.blobMessage ||'),
      'the Blob message must outrank axios\' generic sentence',
    );
  });

  test('the archive panel stays one strip, not a table', () => {
    assert.ok(payslips.includes('newestArchive'), 'only the newest archive is shown');
    assert.ok(
      payslips.includes('older archive(s) are listed'),
      'the rest must be counted, not listed',
    );
    assert.ok(
      !payslips.includes('password'),
      'the archive must not claim a password or encryption it does not apply',
    );
  });
});
