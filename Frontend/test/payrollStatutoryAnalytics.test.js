// ═══════════════════════════════════════════════════════════════════════════
// STATUTORY · EXECUTIVE · STRUCTURES — pins.
//
// Re-cut to the three supplied exports:
//   • "Statutory Compliance"        → /app/payroll/statutory
//   • "Executive Payroll Dashboard" → /app/payroll/analytics
//   • "Salary Structures"           → /app/payroll/structures
//
// The exports draw an ECR "validated" stamp, a "Challan ready" badge, a 72%
// statutory preparedness index, "100% Disbursed", "Zero Pending", an "Optimal"
// budget verdict, an AI input health score and per-card CTC bands the list API
// never returns. None of that can be proved from the endpoints these pages can
// read, so the pages keep the BLOCKS and state the narrower truth. These pins
// hold both halves: the blocks the exports draw, and the honesty substitutions.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const statutory = read('src/pages/payroll/StatutoryCompliancePage.jsx');
const executive = read('src/pages/payroll/analytics/ExecutiveDashboardPage.jsx');
const structures = read('src/pages/payroll/SalaryStructuresPage.jsx');

const pages = [
  ['statutory compliance', statutory],
  ['executive dashboard', executive],
  ['salary structures', structures],
];

describe('statutory · executive · structures — one shell', () => {
  test('all three read their furniture from the shared cockpit kit', () => {
    for (const [name, source] of pages) {
      assert.ok(
        source.includes('components/payroll/PayrollCockpit.jsx'),
        `${name} must use the shared cockpit kit, not its own copy of the panels`,
      );
      assert.ok(source.includes('StageBand'), `${name} must open with the stage band`);
      assert.ok(source.includes('Panel'), `${name} must use the shared panel`);
      assert.ok(source.includes('st-'), `${name} must be on the Warm Organic st- scale`);
    }

    assert.ok(statutory.includes('Rail'), 'statutory keeps the due-date rail beside the table');
    assert.ok(executive.includes('Rail'), 'the executive page keeps a right rail');
  });

  test('no page prints a figure it cannot read from its own endpoint', () => {
    // The exported verdicts, none of which is a field on any response.
    for (const ghost of [
      'Optimal',
      '100% Disbursed',
      'Zero Pending',
      'Statutory Preparedness',
      'ECR Validated',
      'Challan Ready',
      'AI Input Health',
      'Formula Set 2026',
    ]) {
      for (const [name, source] of pages) {
        assert.ok(!source.includes(ghost), `${name} must not claim "${ghost}"`);
      }
    }
  });
});

describe('statutory compliance — filing summary on live roll-up', () => {
  test('the four type cards and the summary table come from the dashboard summary', () => {
    for (const needle of [
      'summary.pf?.total',
      'summary.esi?.total',
      'summary.pt?.total',
      'summary.tds?.total',
      'summary.lwf?.total',
      'summary.gratuity?.monthly',
    ]) {
      assert.ok(statutory.includes(needle), `the summary must read ${needle}`);
    }

    // The mock's six-column filing table survives, with a real action column.
    for (const header of [
      'Employee share',
      'Employer share',
      'Total payable',
      'Filing',
    ]) {
      assert.ok(statutory.includes(header), `the filing summary is missing the "${header}" column`);
    }
  });

  test('due dates come from the calendar endpoint, not from a browser guess', () => {
    assert.ok(
      statutory.includes('statutoryService\n      .calendar([month])'),
      'the overview must read the month calendar for its due dates',
    );
    assert.ok(statutory.includes('dueLabel'), 'due dates must be phrased from daysRemaining');
    assert.ok(statutory.includes('row.overdue'), 'an overdue return must be allowed to say so');
  });

  test('filing is stated as a human record, never an automatic act', () => {
    assert.ok(
      statutory.includes('Nothing here is\n                  auto-filed'),
      'the readiness panel must say filing is recorded, not performed',
    );
    assert.ok(
      statutory.includes('no return is claimed as filed by'),
      'the footer must disclaim any automatic filing',
    );
    assert.ok(statutory.includes('CheckRow'), 'readiness must be a checklist of real states');
  });

  test('the register is a ledger of months that actually exist', () => {
    assert.ok(statutory.includes('statutoryService\n      .history('), 'the ledger reads the register');
    assert.ok(statutory.includes('historyRows'), 'the ledger keeps only the newest months');
    assert.ok(
      statutory.includes('No completed payroll month is recorded'),
      'an empty register must say so instead of drawing three sample rows',
    );
  });
});

describe('executive dashboard — cost, movement, statutory', () => {
  test('the four headline cards are the four export blocks', () => {
    for (const needle of [
      'kpis.totalPayrollCost',
      'kpis.netSalaryPaid',
      'kpis.averageSalary',
      'kpis.totalStatutoryLiability',
    ]) {
      assert.ok(executive.includes(needle), `the headline row must read ${needle}`);
    }
    assert.ok(executive.includes('Department cost breakdown'), 'the department panel survives');
    assert.ok(executive.includes('Cost movement & variance'), 'the movement panel survives');
    assert.ok(executive.includes('Quick statutory position'), 'the statutory rail survives');
    assert.ok(executive.includes('Key reports & downloads'), 'the report directory survives');
  });

  test('the movement split is quoted with its reconciliation state', () => {
    assert.ok(executive.includes('movement.reconciled'), 'the split must declare whether it adds up');
    assert.ok(
      executive.includes('movement.headcountEffect') &&
        executive.includes('movement.likeForLikeEffect'),
      'the split must show the two real effects',
    );
    assert.ok(
      executive.includes('check the payroll runs before quoting either number'),
      'a split that does not add up must say so on the page',
    );
  });

  test('the page states how it knows', () => {
    assert.ok(executive.includes('dashboard.source'), 'the snapshot path must be shown');
    assert.ok(executive.includes('accuracy.calculated'), 'snapshot counts back the accuracy figure');
    assert.ok(
      executive.includes('not a claim that the payroll was checked by a person'),
      'accuracy must not be over-claimed',
    );
  });

  test('a missing department split or liability is said, not filled', () => {
    assert.ok(
      executive.includes('No department split for this window'),
      'the department panel needs an honest empty state',
    );
    assert.ok(
      executive.includes('No statutory liability in this window'),
      'the statutory rail needs an honest empty state',
    );
  });
});

describe('salary structures — cards priced by the server', () => {
  test('every per-card amount is the server preview, never a browser sum', () => {
    assert.ok(structures.includes('salaryStructureService\n          .preview('), 'cards must call preview');
    assert.ok(structures.includes('previews[structure._id]'), 'each card reads its own preview');
    assert.ok(structures.includes('server preview'), 'the distribution bar must label its source');
    assert.ok(
      structures.includes('the server\n                      returns amounts only for components that are still active'),
      'a card without a preview must explain why',
    );
  });

  test('assignment counts are read from the pay profiles', () => {
    assert.ok(structures.includes('employeePayrollService'), 'assignment must come from the profiles');
    assert.ok(structures.includes('perStructure'), 'assignments are grouped by structure');
    assert.ok(
      structures.includes('assignment hidden'),
      'without EMPLOYEE_SALARY_READ the count must say it cannot see, not print a zero',
    );
  });

  test('the card grid keeps the export blocks', () => {
    for (const needle of [
      'activeStructures',
      'assignedCount',
      'Filters',
      'Distribution of gross',
      'View staff',
      'Manage components',
    ]) {
      assert.ok(structures.includes(needle), `the structure grid is missing ${needle}`);
    }
  });

  test('the Indian standard prefill only uses components the company has', () => {
    assert.ok(structures.includes('prefillIndianStandard'), 'the standard split must be offered');
    assert.ok(
      structures.includes("const available = new Set(components.map((component) => component.code))"),
      'the prefill must check the component library first',
    );
    assert.ok(
      structures.includes('Not in your component library'),
      'a skipped component must be named in the toast',
    );
  });
});
