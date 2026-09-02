/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { PieChart, Plus, Settings2, Trash2, Users } from 'lucide-react';

import usePermission from '../../../hooks/usePermission.js';
import payrollAnalyticsService from '../../../services/payrollAnalyticsService.js';

import {
  AccessDenied,
  Banner,
  DataTable,
  ExportMenu,
  FilterBar,
  KpiCard,
  PageHeader,
  SectionCard,
} from './analyticsShared.jsx';
import {
  count,
  currentMonth,
  money,
  monthLabel,
  percent,
  useDepartments,
  useReport,
  usePayrollMonths,
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// 29.13 §8 — the company's OWN salary bands.
//
// The default ranges are a guess about someone else's company. A 40-person
// startup and a 4,000-person manufacturer do not want the same five buckets,
// so the bands are data, edited here and stored per company.
//
// Two rules the editor keeps:
//   · the TOP band has no ceiling — a twelve-lakh salary must still be counted
//   · bands may not overlap — an employee counted twice is worse than a band
//     fewer
//
// The server refuses anything that breaks either, and says why.
// ───────────────────────────────────────────────────────────────────────────

const BandEditor = ({ bands, onSaved, onClose }) => {
  const [draft, setDraft] = useState(() => bands.map((band) => ({ ...band })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const update = (index, field, value) => {
    setDraft((current) => current.map((band, position) => (
      position === index ? { ...band, [field]: value } : band
    )));
  };

  const removeAt = (index) => setDraft((current) => current.filter((_, position) => position !== index));

  const addBand = () => {
    setDraft((current) => {
      const last = current[current.length - 1];
      const floor = Number(last?.min || 0) + 50000;
      // The new band takes the open ceiling; the one above it gets the new
      // floor as its limit, because only the last band may be open-ended.
      const grown = current.map((band, position) => (
        position === current.length - 1 ? { ...band, max: floor } : band
      ));
      return [...grown, { key: `band-${current.length}`, label: '', min: floor, max: null }];
    });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = draft.map((band, index) => ({
        key: band.key || `band-${index}`,
        label: band.label || `${money(band.min)}+`,
        min: Number(band.min || 0),
        max: index === draft.length - 1 ? null : Number(band.max || 0),
      }));
      await payrollAnalyticsService.updateSalaryBands(payload);
      await onSaved?.();
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Unable to save these bands');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
      {error ? <div className="mb-3"><Banner type="error" text={error} onClose={() => setError('')} /></div> : null}

      <div className="space-y-2">
        {draft.map((band, index) => (
          <div key={band.key || index} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
              Name
              <input
                value={band.label}
                onChange={(event) => update(index, 'label', event.target.value)}
                placeholder="e.g. 50k to 1 lakh"
                className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
              From
              <input
                type="number"
                min="0"
                value={band.min}
                onChange={(event) => update(index, 'min', event.target.value)}
                className="w-32 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
              To
              <input
                type="number"
                min="0"
                disabled={index === draft.length - 1}
                value={index === draft.length - 1 ? '' : band.max ?? ''}
                onChange={(event) => update(index, 'max', event.target.value)}
                placeholder="no limit"
                className="w-32 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text disabled:opacity-50"
              />
            </label>
            <button
              type="button"
              onClick={() => removeAt(index)}
              disabled={draft.length <= 2}
              className="rounded-md border border-white/10 px-2 py-1.5 text-sm text-crewly-dim hover:text-red-300 disabled:opacity-40"
              title={draft.length <= 2 ? 'At least two bands are needed' : 'Remove this band'}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addBand}
          className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1.5 text-sm text-crewly-text hover:bg-white/5"
        >
          <Plus size={14} />
          Add band
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-crewly-text hover:bg-white/5 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save bands'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-sm text-crewly-dim hover:text-crewly-text"
        >
          Cancel
        </button>
      </div>

      <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
        The last band is always open-ended, so nobody earning more than the top of the scale is left
        out of the chart. Bands may not overlap — the server refuses them rather than counting one
        person twice.
      </p>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────────────
// §8 + §10 — Salary Distribution.
//
//   §8   designation analytics — count, average, highest, lowest, total cost
//   §10  salary bands — how headcount and payroll spread across the ranges
//
// The bands come from the server as data, so a company that changes its ranges
// does not need a frontend release.
// ───────────────────────────────────────────────────────────────────────────

const SalaryDistributionPage = () => {
  const { loading: permsLoading, hasAnyPermission, hasPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);
  // §8 — editing the bands is configuration, not a read. It rides the verb
  // that already means "configure analytics".
  const canConfigure = hasPermission('PAYROLL_ANALYTICS_SCHEDULE');

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);
  const [editing, setEditing] = useState(false);

  const filters = { month, departmentId };
  const bands = useReport({ reportKey: 'SALARY_BANDS', filters, enabled: !permsLoading && canRead });
  const designations = useReport({ reportKey: 'DESIGNATION', filters, enabled: !permsLoading && canRead });

  // The stored bands are the ones the editor starts from, not the ones the
  // report happens to have fallen back to.
  const loadBands = useCallback(async () => {
    if (!canConfigure) return [];
    try {
      const data = await payrollAnalyticsService.settings();
      return Array.isArray(data?.salaryBands) ? data.salaryBands : [];
    } catch {
      return [];
    }
  }, [canConfigure]);

  const [storedBands, setStoredBands] = useState([]);
  useEffect(() => {
    let alive = true;
    loadBands().then((list) => { if (alive) setStoredBands(list); });
    return () => { alive = false; };
  }, [loadBands]);

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={PieChart} title="Salary Distribution" subtitle="Bands and designations" />
        <AccessDenied />
      </div>
    );
  }

  const bandRows = bands.report?.rows || [];
  const bandTotal = bandRows.reduce((sum, row) => sum + Number(row.payroll || 0), 0);
  const maxBandEmployees = Math.max(1, ...bandRows.map((row) => Number(row.employees || 0)));

  return (
    <div className="p-6">
      <PageHeader
        icon={PieChart}
        title="Salary Distribution"
        subtitle={`${monthLabel(month)} · §10 bands and §8 designation analytics`}
        actions={<ExportMenu reportKey="SALARY_BANDS" filters={filters} onQueued={setBanner} />}
      />

      {banner ? <div className="mb-4"><Banner {...banner} onClose={() => setBanner(null)} /></div> : null}

      <FilterBar
        month={month}
        months={months}
        onMonthChange={setMonth}
        departments={departments}
        departmentId={departmentId}
        onDepartmentChange={setDepartmentId}
      />

      {(bands.denied || designations.denied) ? <AccessDenied /> : null}

      {/* §10 — the bands as bars, not only as numbers */}
      <SectionCard
        title="Salary bands"
        subtitle="§10 — employee count and total payroll in each range"
        actions={(
          <div className="flex items-center gap-2">
            {canConfigure ? (
              <button
                type="button"
                onClick={() => setEditing((value) => !value)}
                className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-crewly-text hover:bg-white/5"
              >
                <Settings2 size={14} />
                {editing ? 'Close editor' : 'Edit bands'}
              </button>
            ) : null}
            <ExportMenu reportKey="SALARY_BANDS" filters={filters} onQueued={setBanner} />
          </div>
        )}
      >
        {editing && (storedBands.length || bandRows.length) ? (
          <BandEditor
            bands={storedBands.length ? storedBands : bandRows.map((row, index) => ({
              key: row.key || `band-${index}`,
              label: row.label,
              min: row.min ?? 0,
              max: row.max ?? null,
            }))}
            onSaved={async () => {
              const list = await loadBands();
              setStoredBands(list);
              await bands.reload();
              setBanner({ type: 'success', text: 'Salary bands saved — the distribution below uses them now.' });
            }}
            onClose={() => setEditing(false)}
          />
        ) : null}

        {bands.loading ? (
          <p className="text-sm text-crewly-dim">Loading the salary bands…</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard icon={Users} label="Employees in bands" value={count(bandRows.reduce((sum, row) => sum + Number(row.employees || 0), 0))} />
              <KpiCard label="Total payroll" value={money(bandTotal)} />
              <KpiCard label="Bands in use" value={count(bandRows.filter((row) => Number(row.employees) > 0).length)} />
              <KpiCard label="Largest band" value={bandRows.slice().sort((a, b) => b.employees - a.employees)[0]?.label || '—'} />
            </div>

            <ul className="mt-4 space-y-3">
              {bandRows.map((row) => (
                <li key={row.key}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-crewly-text">{row.label}</span>
                    <span className="tabular-nums text-crewly-dim">
                      {count(row.employees)} employee{Number(row.employees) === 1 ? '' : 's'} · {money(row.payroll)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/5">
                    <div
                      className="h-full rounded-full bg-sky-500/60"
                      style={{ width: `${(Number(row.employees || 0) / maxBandEmployees) * 100}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-[11px] text-crewly-dim">
                    {percent(row.sharePercent)} of headcount · {money(row.netPayroll)} net
                  </p>
                </li>
              ))}
            </ul>

            <div className="mt-4 border-t border-white/5 pt-3">
              <DataTable
                headers={[
                  { key: 'label', label: 'Band', strong: true },
                  { key: 'employees', label: 'Employees', align: 'right' },
                  { key: 'payroll', label: 'Total payroll', align: 'right', render: (row) => money(row.payroll) },
                  { key: 'netPayroll', label: 'Net payroll', align: 'right', render: (row) => money(row.netPayroll) },
                  { key: 'sharePercent', label: 'Share', align: 'right', render: (row) => percent(row.sharePercent) },
                ]}
                rows={bandRows}
                empty="No salary distribution for this month"
              />
            </div>
          </>
        )}
      </SectionCard>

      {/* §8 — designation analytics */}
      <SectionCard
        className="mt-4"
        title="Designation analytics"
        subtitle="§8 — count, average, highest and lowest by designation"
        actions={<ExportMenu reportKey="DESIGNATION" filters={filters} onQueued={setBanner} />}
      >
        {designations.loading ? (
          <p className="text-sm text-crewly-dim">Loading designation analytics…</p>
        ) : (
          <DataTable
            headers={[
              { key: 'designation', label: 'Designation', strong: true },
              { key: 'employees', label: 'Employees', align: 'right' },
              { key: 'averageSalary', label: 'Average', align: 'right', render: (row) => money(row.averageSalary) },
              { key: 'highest', label: 'Highest', align: 'right', render: (row) => money(row.highest) },
              { key: 'lowest', label: 'Lowest', align: 'right', render: (row) => money(row.lowest) },
              { key: 'totalCost', label: 'Total cost', align: 'right', render: (row) => money(row.totalCost) },
            ]}
            rows={designations.report?.rows || []}
            empty="No designation data for this month"
          />
        )}
      </SectionCard>
    </div>
  );
};

export default SalaryDistributionPage;
