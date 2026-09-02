/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Building2,
  CalendarRange,
  FileSpreadsheet,
  Landmark,
  LineChart,
  PieChart,
  RefreshCcw,
  Users,
  Wallet,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import usePermission from '../../../hooks/usePermission.js';
import payrollAnalyticsService from '../../../services/payrollAnalyticsService.js';

import {
  AccessDenied,
  Banner,
  EmptyState,
  ExportMenu,
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
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §5 / §6 / §9 — the executive dashboard.
//
// The first screen under Payroll → Analytics & Reports. It answers "what did
// payroll cost us last month?" in eight cards, then hands off to the detailed
// reports. Every figure arrives from the 29.6 snapshots (§2 / §11); nothing
// is summed in the browser.
// ───────────────────────────────────────────────────────────────────────────

const LINKS = [
  { to: '/app/payroll/analytics/overview', label: 'Payroll Overview', icon: BarChart3 },
  { to: '/app/payroll/analytics/department', label: 'Department Analytics', icon: Building2 },
  { to: '/app/payroll/analytics/salary-distribution', label: 'Salary Distribution', icon: PieChart },
  { to: '/app/payroll/analytics/trends', label: 'Payroll Trends', icon: LineChart },
  { to: '/app/payroll/analytics/bonus', label: 'Bonus Report', icon: Wallet },
  { to: '/app/payroll/analytics/overtime', label: 'Overtime Report', icon: CalendarRange },
  { to: '/app/payroll/analytics/statutory', label: 'Statutory Summary', icon: Landmark },
  { to: '/app/payroll/analytics/register', label: 'Payroll Register', icon: FileSpreadsheet },
  { to: '/app/payroll/analytics/scheduled', label: 'Scheduled Reports', icon: CalendarRange },
];

const ExecutiveDashboardPage = () => {
  const { loading: permsLoading, hasAnyPermission, hasPermission } = usePermission();

  // §4 — permissions, never role names.
  const canRead = hasAnyPermission([
    'PAYROLL_REPORT_READ',
    'PAYROLL_REPORT_EXPORT',
    'PAYROLL_ANALYTICS_FINANCIAL',
    'PAYROLL_ANALYTICS_SCHEDULE',
  ]);
  const canSeeFinancial = hasPermission('PAYROLL_ANALYTICS_FINANCIAL');

  const [month, setMonth] = useState(currentMonth());
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [banner, setBanner] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await payrollAnalyticsService.dashboard(month);
      setDashboard(data || null);
      setDenied(false);
    } catch (error) {
      if (error?.status === 403 || error?.status === 401) setDenied(true);
      else setBanner({ type: 'error', text: error?.message || 'Unable to load the payroll dashboard' });
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    if (permsLoading || !canRead) return;
    load();
  }, [permsLoading, canRead, load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await payrollAnalyticsService.refresh(month);
      setBanner({
        type: 'success',
        text: result?.queued
          ? 'Executive dashboard refresh queued'
          : `Executive dashboard refreshed for ${monthLabel(month)}`,
      });
      await load();
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Unable to refresh the dashboard' });
    } finally {
      setRefreshing(false);
    }
  };

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader
          icon={BarChart3}
          title="Executive Dashboard"
          subtitle="Payroll cost, headcount and statutory position at a glance"
        />
        <AccessDenied />
      </div>
    );
  }

  const kpis = dashboard?.kpis || {};
  const summary = dashboard?.summary || {};
  const headcount = dashboard?.headcount || {};
  const statutory = dashboard?.statutory || {};
  const accuracy = dashboard?.accuracy || {};
  const months = dashboard?.availableMonths || [];

  return (
    <div className="p-6">
      <PageHeader
        icon={BarChart3}
        title="Executive Dashboard"
        subtitle="Payroll cost, headcount and statutory position at a glance"
        actions={
          <>
            <select
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-crewly-text"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            >
              {(months.length ? months : [month]).map((value) => (
                <option key={value} value={value}>{monthLabel(value)}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-crewly-text hover:bg-white/5 disabled:opacity-50"
            >
              <RefreshCcw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </>
        }
      />

      {banner ? <div className="mb-4"><Banner {...banner} onClose={() => setBanner(null)} /></div> : null}

      {denied ? <AccessDenied /> : null}

      {loading && !dashboard ? (
        <p className="text-sm text-crewly-dim">Loading the payroll dashboard…</p>
      ) : null}

      {!loading && !denied && !dashboard?.month ? (
        <EmptyState message="No completed payroll yet — analytics start once a run is approved." icon={BarChart3} />
      ) : null}

      {dashboard?.month ? (
        <>
          {/* §5 — the eight KPI cards */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard icon={Wallet} label="Total Payroll Cost" value={money(kpis.totalPayrollCost)} hint={`${monthLabel(month)} · gross + employer`} />
            <KpiCard icon={Wallet} label="Net Salary Paid" value={money(kpis.netSalaryPaid)} hint={`${count(kpis.employeesPaid)} employee(s) paid`} />
            <KpiCard icon={BarChart3} label="Gross Salary" value={money(kpis.grossSalary)} tone="info" />
            <KpiCard icon={Landmark} label="Employer Contribution" value={money(kpis.employerContribution)} />
            <KpiCard icon={Users} label="Total Employees Paid" value={count(kpis.employeesPaid)} />
            <KpiCard
              icon={Users}
              label="Average Salary"
              value={money(kpis.averageSalary)}
              hint={kpis.costChangePercent ? `${percent(kpis.costChangePercent)} vs ${monthLabel(dashboard.previousMonth)}` : ''}
              tone={Number(kpis.costChangePercent) > 0 ? 'warn' : 'default'}
            />
            <KpiCard
              icon={Building2}
              label="Highest Department Cost"
              value={money(kpis.highestDepartmentCost?.cost)}
              hint={kpis.highestDepartmentCost?.department || '—'}
            />
            <KpiCard icon={Landmark} label="Total Statutory Liability" value={money(kpis.totalStatutoryLiability)} />
          </div>

          {/* §6 — the overview figures */}
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <SectionCard title="Payroll Overview" subtitle={monthLabel(month)} className="lg:col-span-2">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {[
                  ['Gross', money(summary.grossSalary)],
                  ['Total earnings', money(summary.earningsTotal)],
                  ['Deductions', money(summary.deductionsTotal)],
                  ['Net', money(summary.netSalary)],
                  ['Employer cost', money(summary.employerContribution)],
                  ['Total cost', money(summary.totalPayrollCost)],
                  ['Paid employees', count(summary.employeesPaid)],
                  ['Final settlements', count(dashboard.settlements)],
                  ['Payroll accuracy', percent(accuracy.accuracyPercent)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[11px] uppercase tracking-wide text-crewly-dim">{label}</dt>
                    <dd className="mt-0.5 font-medium text-crewly-text">{value}</dd>
                  </div>
                ))}
              </dl>
            </SectionCard>

            {/* §9 — headcount & cost */}
            <SectionCard
              title="Headcount & Cost"
              subtitle="§9 — joins, exits and cost per head"
              actions={<ExportMenu reportKey="HEADCOUNT" filters={{ month }} onQueued={setBanner} />}
            >
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {[
                  ['Active employees', count(headcount.activeEmployees)],
                  ['Joined this month', count(headcount.joinedThisMonth)],
                  ['Exited this month', count(headcount.exitedThisMonth)],
                  ['Net change', count(headcount.netHeadcountChange)],
                  ['Payroll cost', money(headcount.payrollCost)],
                  ['Cost increase', money(headcount.payrollCostIncrease)],
                  ['Cost per employee', money(headcount.averageCostPerEmployee)],
                  ['Cost per paid head', money(headcount.averageCostPerPaidEmployee)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[11px] uppercase tracking-wide text-crewly-dim">{label}</dt>
                    <dd className="mt-0.5 font-medium text-crewly-text">{value}</dd>
                  </div>
                ))}
              </dl>
            </SectionCard>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {/* §7 — the department split, topped by cost */}
            <SectionCard
              title="Department Payroll Cost"
              subtitle="§7 — sorted by the highest cost"
              actions={<Link to="/app/payroll/analytics/department" className="text-xs text-sky-300 hover:underline">Open report</Link>}
            >
              {dashboard.departments?.length ? (
                <ul className="space-y-2">
                  {dashboard.departments.map((row) => {
                    const share = Number(summary.totalPayrollCost)
                      ? (Number(row.totalCost) / Number(summary.totalPayrollCost)) * 100
                      : 0;
                    return (
                      <li key={row.department}>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-crewly-text">{row.department}</span>
                          <span className="tabular-nums text-crewly-dim">{money(row.totalCost)}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
                          <div className="h-full rounded-full bg-sky-500/60" style={{ width: `${Math.min(100, share)}%` }} />
                        </div>
                        <p className="mt-0.5 text-[11px] text-crewly-dim">
                          {count(row.employees)} employee(s) · {percent(share)} of cost
                        </p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState message="No department cost for this month" icon={Building2} />
              )}
            </SectionCard>

            {/* §15 — the statutory position */}
            <SectionCard
              title="Statutory Position"
              subtitle="§15 — employee + employer, every component"
              actions={<Link to="/app/payroll/analytics/statutory" className="text-xs text-sky-300 hover:underline">Open summary</Link>}
            >
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {[
                  ['PF', money(statutory.pf?.total)],
                  ['ESI', money(statutory.esi?.total)],
                  ['Professional tax', money(statutory.pt?.total)],
                  ['TDS', money(statutory.tds?.total)],
                  ['LWF', money(statutory.lwf?.total)],
                  ['Gratuity provision', money(statutory.gratuity?.monthly)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[11px] uppercase tracking-wide text-crewly-dim">{label}</dt>
                    <dd className="mt-0.5 font-medium text-crewly-text">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
                Gratuity is a provision, shown alongside the remittable liability rather than inside it.
              </p>
            </SectionCard>
          </div>

          {/* §26 — the other nine reports */}
          <SectionCard className="mt-4" title="Reports" subtitle="§26 — every analytics report">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {LINKS.map(({ to, label, icon: Icon }) => (
                <Link
                  key={to}
                  to={to}
                  className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-sm text-crewly-text hover:bg-white/5"
                >
                  <Icon size={15} className="text-crewly-dim" />
                  {label}
                </Link>
              ))}
            </div>
            {!canSeeFinancial ? (
              <p className="mt-3 text-xs text-crewly-dim">
                The cost-to-company report is restricted to Finance (§16).
              </p>
            ) : null}
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default ExecutiveDashboardPage;
