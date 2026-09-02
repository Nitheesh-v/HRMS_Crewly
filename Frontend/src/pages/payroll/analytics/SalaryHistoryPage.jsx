/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { useParams } from 'react-router-dom';

import payrollAnalyticsService from '../../../services/payrollAnalyticsService.js';

import { AccessDenied, Banner, DataTable, PageHeader, SectionCard } from './analyticsShared.jsx';
import { count, formatDate, money, monthLabel } from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §23 — One employee's salary history.
//
// Two different things, kept apart on purpose:
//
//   · WHAT THEY WERE PAID — one row per month, read from the 29.6 snapshots.
//     These are actuals: what actually hit the bank.
//   · WHAT THEY WERE PROMISED — the 29.4 profile's version chain: each
//     revision with the date it took effect. Nothing is overwritten, so the
//     history is still readable years later.
//
// §25 — the scope check lives on the server. A manager scoped to two
// departments cannot read a third department's salary history by typing an id;
// this page simply shows the refusal.
// ───────────────────────────────────────────────────────────────────────────

const SalaryHistoryPage = () => {
  const { employeeId } = useParams();
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!employeeId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await payrollAnalyticsService.employeeHistory(employeeId);
      setHistory(data || null);
      setDenied(false);
    } catch (err) {
      if (err?.status === 403 || err?.status === 401) setDenied(true);
      else setError(err?.message || 'Unable to load this salary history');
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    load();
  }, [load]);

  const employee = history?.employee || {};
  const months = history?.months || [];
  const versions = history?.versions || [];
  const summary = history?.summary || {};

  return (
    <div className="p-6">
      <PageHeader
        icon={History}
        title="Salary History"
        subtitle={`${employee.employeeName || 'Employee'} ${employee.employeeCode || ''} · §23 what was paid, and what was contracted`}
      />

      {error ? <div className="mb-4"><Banner type="error" text={error} onClose={() => {}} /></div> : null}
      {denied ? <AccessDenied message="This employee is outside your payroll scope." /> : null}
      {loading ? <p className="text-sm text-crewly-dim">Loading the salary history…</p> : null}

      {!loading && !denied && history ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="card p-4">
              <p className="text-[11px] uppercase tracking-wide text-crewly-dim">Months on record</p>
              <p className="mt-2 text-xl font-semibold text-crewly-text">{count(summary.months)}</p>
              <p className="mt-1 text-xs text-crewly-dim">
                {summary.firstMonth ? monthLabel(summary.firstMonth) : '—'} → {summary.lastMonth ? monthLabel(summary.lastMonth) : '—'}
              </p>
            </div>
            <div className="card p-4">
              <p className="text-[11px] uppercase tracking-wide text-crewly-dim">Average gross</p>
              <p className="mt-2 text-xl font-semibold text-crewly-text">{money(summary.averageGross)}</p>
              <p className="mt-1 text-xs text-crewly-dim">across every month on record</p>
            </div>
            <div className="card p-4">
              <p className="text-[11px] uppercase tracking-wide text-crewly-dim">First CTC on record</p>
              <p className="mt-2 text-xl font-semibold text-crewly-text">{money(summary.firstCtc)}</p>
            </div>
            <div className="card p-4">
              <p className="text-[11px] uppercase tracking-wide text-crewly-dim">Latest CTC</p>
              <p className="mt-2 text-xl font-semibold text-crewly-text">{money(summary.latestCtc)}</p>
              <p className="mt-1 text-xs text-crewly-dim">
                {Number(summary.ctcChange) ? `${money(summary.ctcChange)} over the period` : 'unchanged over the period'}
              </p>
            </div>
          </div>

          <SectionCard
            className="mt-4"
            title="What they were paid"
            subtitle="§23 — one row per month, read from the payroll snapshots"
          >
            <DataTable
              headers={[
                { key: 'month', label: 'Month', strong: true, render: (row) => monthLabel(row.month) },
                { key: 'structureName', label: 'Structure' },
                { key: 'gross', label: 'Gross', align: 'right', render: (row) => money(row.gross) },
                { key: 'variableEarnings', label: 'Variable', align: 'right', render: (row) => money(row.variableEarnings) },
                { key: 'overtime', label: 'Overtime', align: 'right', render: (row) => money(row.overtime) },
                { key: 'totalDeductions', label: 'Deductions', align: 'right', render: (row) => money(row.totalDeductions) },
                { key: 'net', label: 'Net', align: 'right', render: (row) => money(row.net) },
                { key: 'employerCost', label: 'Employer cost', align: 'right', render: (row) => money(row.employerCost) },
                { key: 'ctc', label: 'CTC', align: 'right', render: (row) => money(row.ctc) },
              ]}
              rows={months}
              empty="No payroll snapshots for this employee yet"
            />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              These are actuals, not a projection: every figure is what the payroll run calculated
              and stored that month. Nothing here is recalculated.
            </p>
          </SectionCard>

          <SectionCard
            className="mt-4"
            title="What they were contracted to be paid"
            subtitle="§23 — the 29.4 profile's version chain, newest first. Nothing is overwritten."
          >
            <DataTable
              headers={[
                { key: 'version', label: 'Version', strong: true, render: (row) => `v${row.version}` },
                { key: 'structureName', label: 'Structure' },
                { key: 'monthlyGross', label: 'Monthly gross', align: 'right', render: (row) => money(row.monthlyGross) },
                { key: 'annualCtc', label: 'Annual CTC', align: 'right', render: (row) => money(row.annualCtc) },
                { key: 'effectiveFrom', label: 'Effective from', render: (row) => formatDate(row.effectiveFrom) },
                { key: 'effectiveTo', label: 'Effective to', render: (row) => (row.effectiveTo ? formatDate(row.effectiveTo) : '—') },
                { key: 'isCurrent', label: 'Status', render: (row) => (row.isCurrent ? 'Current' : 'Superseded') },
              ]}
              rows={versions}
              empty="No salary revisions recorded"
            />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              A revision never rewrites the one before it, which is why this list can be longer than
              one row: the old version stays on record with the date it stopped applying.
            </p>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default SalaryHistoryPage;
