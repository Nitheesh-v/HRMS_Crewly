/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Building2,
  CalendarClock,
  CalendarRange,
  Coins,
  FileSpreadsheet,
  GitCompareArrows,
  Landmark,
  LineChart,
  Percent,
  PieChart,
  Receipt,
  RefreshCcw,
  Scissors,
  ShieldCheck,
  UserMinus,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import usePermission from '../../../hooks/usePermission.js';
import payrollAnalyticsService from '../../../services/payrollAnalyticsService.js';

import { AccessDenied, EmptyState, ExportMenu, PeriodSelect } from './analyticsShared.jsx';
import { count, currentMonth, money, monthLabel, percent } from './analyticsShared.js';
import {
  Fact,
  Panel,
  Pill,
  Rail,
  StageBand,
  StageButton,
  StatCard,
  Td,
  Th,
} from '../../../components/payroll/PayrollCockpit.jsx';
import { notify } from '../../../utils/notify.js';

// ───────────────────────────────────────────────────────────────────────────
// §5 / §6 / §9 — the executive dashboard.
//
// The first screen under Payroll → Analytics & Reports. It answers "what did
// payroll cost us last month, and why did it move?" in four cards, one
// department breakdown, the movement decomposition and the statutory
// position — then hands off to the detailed reports.
//
// Every figure arrives from the 29.6 snapshots (§2 / §11); nothing is summed
// in the browser. Where the export carried a claim the API cannot prove
// ("100% disbursed", "zero pending", a readiness index) the claim is replaced
// by the field that does back it, or left out.
// ───────────────────────────────────────────────────────────────────────────

const LINKS = [
  { to: '/app/payroll/analytics/overview', label: 'Payroll Overview', icon: BarChart3, note: 'Every headline figure for the window, month by month' },
  { to: '/app/payroll/analytics/department', label: 'Department Analytics', icon: Building2, note: 'Cost, headcount and averages per department' },
  { to: '/app/payroll/analytics/salary-distribution', label: 'Salary Distribution', icon: PieChart, note: 'How pay spreads across the salary bands' },
  { to: '/app/payroll/analytics/trends', label: 'Payroll Trends', icon: LineChart, note: 'Monthly, quarterly and yearly series' },
  { to: '/app/payroll/analytics/earnings', label: 'Earnings Analytics', icon: Coins, note: 'Fixed vs variable pay, component by component' },
  { to: '/app/payroll/analytics/deductions', label: 'Deduction Analytics', icon: Scissors, note: 'What was withheld, and from whom' },
  { to: '/app/payroll/analytics/employer', label: 'Employer Contribution', icon: Landmark, note: 'PF, ESI and LWF the company paid on top' },
  { to: '/app/payroll/analytics/bonus', label: 'Bonus Report', icon: Wallet, note: 'Bonus and variable earnings by employee' },
  { to: '/app/payroll/analytics/overtime', label: 'Overtime Report', icon: CalendarRange, note: 'Hours worked and what they cost' },
  { to: '/app/payroll/analytics/reimbursement', label: 'Reimbursements', icon: Receipt, note: 'Claims paid through payroll' },
  { to: '/app/payroll/analytics/statutory', label: 'Statutory Summary', icon: ShieldCheck, note: 'PF, ESI, PT, TDS and LWF liability' },
  { to: '/app/payroll/analytics/fnf', label: 'F&F Analytics', icon: UserMinus, note: 'Full and final settlements paid' },
  { to: '/app/payroll/analytics/variance', label: 'Payroll Variance', icon: GitCompareArrows, note: 'This month against the last' },
  { to: '/app/payroll/analytics/register', label: 'Payroll Register', icon: FileSpreadsheet, note: 'The employee-wise register, exportable' },
  { to: '/app/payroll/analytics/scheduled', label: 'Scheduled Reports', icon: CalendarClock, note: 'Recurring exports and their history' },
];

const delta = (now, before) => Number(now || 0) - Number(before || 0);

const signedMoney = (value) => {
  const amount = Number(value || 0);
  if (!amount) return 'no change';
  return `${amount > 0 ? '+' : '−'}${money(Math.abs(amount))}`;
};

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
  // §4 — a period preset, or a custom range. "What did payroll cost us this
  // year?" should not need twelve clicks.
  const [preset, setPreset] = useState('CURRENT_MONTH');
  const [fromMonth, setFromMonth] = useState(currentMonth());
  const [toMonth, setToMonth] = useState(currentMonth());
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await payrollAnalyticsService.dashboard({ month, preset, fromMonth, toMonth });
      setDashboard(data || null);
      setDenied(false);
    } catch (error) {
      if (error?.status === 403 || error?.status === 401) setDenied(true);
      else notify.error(error, 'Unable to load the payroll dashboard');
    } finally {
      setLoading(false);
    }
  }, [month, preset, fromMonth, toMonth]);

  useEffect(() => {
    if (permsLoading || !canRead) return;
    load();
  }, [permsLoading, canRead, load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await payrollAnalyticsService.refresh(month);
      notify.success(
        result?.queued
          ? 'Executive dashboard refresh queued'
          : `Executive dashboard refreshed for ${monthLabel(month)}`,
      );
      await load();
    } catch (error) {
      notify.error(error, 'Unable to refresh the dashboard');
    } finally {
      setRefreshing(false);
    }
  };

  if (!permsLoading && !canRead) {
    return (
      <div className="space-y-3">
        <StageBand
          eyebrow="Payroll · Analytics"
          title="Executive payroll dashboard"
          description="Cost, headcount and the statutory position for the payroll window."
        />
        <AccessDenied />
      </div>
    );
  }

  const kpis = dashboard?.kpis || {};
  const summary = dashboard?.summary || {};
  const previousSummary = dashboard?.previousSummary || {};
  const headcount = dashboard?.headcount || {};
  const statutory = dashboard?.statutory || {};
  const statutoryTotals = kpis.statutory || statutory.totals || {};
  const buckets = statutory.buckets || [];
  const accuracy = dashboard?.accuracy || {};
  const movement = dashboard?.movement || null;
  const departments = dashboard?.departments || [];
  const months = dashboard?.availableMonths || [];
  const periodLabel = dashboard?.period?.label || monthLabel(month);

  const totalForDepartment = departments.reduce((total, row) => total + Number(row.totalCost || 0), 0);
  const paidCount = Number(kpis.employeesPaid || 0);

  // The variable lines the movement decomposition folds together — shown
  // individually so a reader can see which one actually moved.
  const variableLines = [
    {
      key: 'BONUS',
      label: 'Bonus & variable pay',
      now: summary.bonusTotal,
      before: previousSummary.bonusTotal,
    },
    {
      key: 'OT',
      label: 'Overtime',
      now: summary.overtimeTotal,
      before: previousSummary.overtimeTotal,
    },
    {
      key: 'REIMB',
      label: 'Reimbursements',
      now: summary.reimbursements,
      before: previousSummary.reimbursements,
    },
  ].map((line) => ({ ...line, change: delta(line.now, line.before) }));

  const costChangePercent = Number(kpis.costChangePercent || 0);

  return (
    <div className="space-y-3">
      <StageBand
        eyebrow="Payroll · Analytics"
        title="Executive payroll dashboard"
        description={
          dashboard?.month
            ? `${periodLabel} · ${monthLabel(dashboard.month)} · ${count(paidCount)} employee(s) paid. Every figure is a roll-up of the payroll snapshots in this window — no estimate is recomputed here.`
            : 'Cost, headcount and the statutory position for the payroll window.'
        }
        pills={[
          { label: periodLabel, tone: 'default' },
          { label: `${count(paidCount)} paid`, tone: 'accent' },
          {
            label: `accuracy ${percent(accuracy.accuracyPercent)}`,
            tone: Number(accuracy.errors) ? 'warn' : 'good',
            title: `${count(accuracy.calculated)} snapshot(s) calculated cleanly, ${count(accuracy.errors)} with errors`,
          },
          ...(movement
            ? [
                {
                  label: movement.reconciled ? 'movement reconciles' : 'movement does not reconcile',
                  tone: movement.reconciled ? 'good' : 'bad',
                },
              ]
            : []),
        ]}
        aside={
          <div className="text-right">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
              Total payroll cost
            </p>
            <p className="text-lg font-bold leading-tight tabular-nums text-st-on">
              {money(kpis.totalPayrollCost)}
            </p>
            <p className="text-[10px] text-st-on-variant">
              {dashboard?.previousMonth
                ? `${costChangePercent > 0 ? '+' : ''}${percent(costChangePercent)} vs ${monthLabel(dashboard.previousMonth)}`
                : 'no comparison window'}
            </p>
          </div>
        }
        actions={
          <>
            <PeriodSelect
              theme="st"
              preset={preset}
              onPresetChange={setPreset}
              fromMonth={fromMonth}
              toMonth={toMonth}
              onFromMonthChange={setFromMonth}
              onToMonthChange={setToMonth}
              months={months}
            />
            {preset === 'CURRENT_MONTH' || preset === 'PREVIOUS_MONTH' ? (
              <select
                className="rounded-lg border border-st-outline-variant/70 bg-st-lowest px-2 py-1.5 text-[11px] font-semibold text-st-on"
                value={month}
                aria-label="Payroll month"
                onChange={(event) => setMonth(event.target.value)}
              >
                {(months.length ? months : [month]).map((value) => (
                  <option key={value} value={value}>
                    {monthLabel(value)}
                  </option>
                ))}
              </select>
            ) : null}
            <ExportMenu theme="st" reportKey="HEADCOUNT" filters={{ month }} />
            <StageButton icon={RefreshCcw} onClick={refresh} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </StageButton>
          </>
        }
      />

      {denied ? <AccessDenied /> : null}

      {loading && !dashboard ? (
        <Panel>
          <p className="px-4 py-8 text-[11px] text-st-on-variant">Reading the payroll dashboard…</p>
        </Panel>
      ) : null}

      {!loading && !denied && !dashboard?.month ? (
        <Panel>
          <div className="px-4 py-4">
            <EmptyState
              message="No completed payroll yet — analytics start once a run is approved."
              icon={BarChart3}
            />
          </div>
        </Panel>
      ) : null}

      {dashboard?.month ? (
        <>
          {/* ── the four headline cards ──────────────────────────────── */}
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={Wallet}
              label="Total payroll cost"
              value={money(kpis.totalPayrollCost)}
              hint={`Gross ${money(kpis.grossSalary)} + employer ${money(kpis.employerContribution)}`}
              badge={
                dashboard.previousMonth
                  ? {
                      label: `${costChangePercent > 0 ? '+' : ''}${percent(costChangePercent)}`,
                      tone: costChangePercent > 0 ? 'warn' : 'good',
                    }
                  : undefined
              }
            />
            <StatCard
              icon={Users}
              label="Net disbursed"
              value={money(kpis.netSalaryPaid)}
              hint={`${count(paidCount)} employee(s) paid in ${monthLabel(dashboard.month)}`}
            />
            <StatCard
              icon={Percent}
              label="Average salary / employee"
              value={money(kpis.averageSalary)}
              hint={`Cost per paid head ${money(headcount.averageCostPerPaidEmployee)}`}
            />
            <StatCard
              icon={Landmark}
              label="Statutory liability"
              value={money(kpis.totalStatutoryLiability)}
              hint={`Employee ${money(statutoryTotals.employee)} + employer ${money(statutoryTotals.employer)}`}
              tone="default"
            />
          </div>

          {/* ── the rest of the cost lines, one compact strip ─────────── */}
          <Panel
            title="Other cost lines in this window"
            subtitle={`Read from the same snapshots: ${monthLabel(dashboard.month)} payroll.`}
            bodyClassName="grid gap-x-6 gap-y-1 border-t border-st-high px-4 py-2.5 sm:grid-cols-2 xl:grid-cols-4"
          >
            <Fact label="Gross salary" value={money(summary.grossSalary)} />
            <Fact label="Employer contribution" value={money(summary.employerContribution)} />
            <Fact label="Employee deductions" value={money(kpis.employeeDeductions)} />
            <Fact
              label="Overtime"
              value={`${money(kpis.overtimeCost)} · ${count(kpis.overtimeHours)} h`}
            />
            <Fact label="Bonus" value={money(kpis.bonusTotal)} />
            <Fact label="Reimbursements" value={money(kpis.reimbursements)} />
            <Fact
              label="Loss of pay"
              value={`${money(kpis.lopDeduction)} · ${count(kpis.lopDays)} day(s)`}
            />
            <Fact
              label="F&F settlements"
              value={`${count(kpis.finalSettlements)} · ${money(kpis.settlementAmount)}`}
            />
          </Panel>

          <div className="flex flex-col gap-3 xl:flex-row">
            <div className="min-w-0 flex-1 space-y-3">
              {/* ── department breakdown ─────────────────────────────── */}
              <Panel
                title="Department cost breakdown"
                subtitle={`Top ${count(departments.length)} department(s) by total cost — gross plus employer contribution.`}
                right={
                  <Link
                    to="/app/payroll/analytics/department"
                    className="inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low"
                  >
                    Full roster <ArrowRight aria-hidden="true" size={10} />
                  </Link>
                }
                bodyClassName="px-4 pb-4"
              >
                {departments.length === 0 ? (
                  <p className="text-[11px] leading-relaxed text-st-on-variant">
                    No department split for this window — a snapshot only carries a department when the
                    employee had one on the payroll date.
                  </p>
                ) : (
                  <ul className="space-y-2.5">
                    {departments.map((row) => {
                      const share = totalForDepartment
                        ? (Number(row.totalCost) / totalForDepartment) * 100
                        : 0;
                      return (
                        <li key={row.department}>
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="text-[12px] font-semibold text-st-on">
                              {row.department}
                              <span className="ml-1.5 text-[10px] font-normal text-st-on-variant">
                                {count(row.employees)} staff · avg {money(row.averageSalary)}
                              </span>
                            </span>
                            <span className="text-[11px] font-semibold tabular-nums text-st-on">
                              {money(row.totalCost)}
                              <span className="ml-1.5 text-[10px] font-normal text-st-on-variant">
                                {percent(share)}
                              </span>
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-st-inset-strong">
                            <div
                              className="h-full rounded-full bg-st-primary-container"
                              style={{ width: `${Math.min(100, share)}%` }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>

              {/* ── cost movement ─────────────────────────────────────── */}
              <Panel
                title="Cost movement & variance"
                subtitle={
                  dashboard.previousMonth
                    ? `Reconciliation against ${monthLabel(dashboard.previousMonth)}.`
                    : 'No previous window to reconcile against.'
                }
                right={
                  <Link
                    to="/app/payroll/analytics/variance"
                    className="inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low"
                  >
                    Variance report <ArrowRight aria-hidden="true" size={10} />
                  </Link>
                }
                bodyClassName="px-4 pb-4"
              >
                {movement ? (
                  <>
                    <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                      <Fact
                        icon={UserPlus}
                        label={`Headcount effect · ${count(movement.joiners)} joined, ${count(movement.leavers)} left`}
                        value={signedMoney(movement.headcountEffect)}
                      />
                      <Fact
                        icon={GitCompareArrows}
                        label={`Like-for-like · ${count(movement.stayers)} stayed`}
                        value={signedMoney(movement.likeForLikeEffect)}
                      />
                      <Fact label="Of which fixed pay" value={signedMoney(movement.fixedEffect)} />
                      <Fact label="Of which variable pay" value={signedMoney(movement.variableEffect)} />
                    </div>

                    <div className="mt-3 overflow-x-auto border-t border-st-high">
                      <table className="min-w-full">
                        <thead>
                          <tr className="bg-st-low/60">
                            <Th>Variable line</Th>
                            <Th className="text-right">{monthLabel(dashboard.previousMonth) || 'Previous'}</Th>
                            <Th className="text-right">{monthLabel(dashboard.month)}</Th>
                            <Th className="text-right">Change</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {variableLines.map((line) => (
                            <tr key={line.key} className="border-t border-st-high">
                              <Td>{line.label}</Td>
                              <Td className="text-right tabular-nums">{money(line.before)}</Td>
                              <Td className="text-right tabular-nums">{money(line.now)}</Td>
                              <Td
                                className={`text-right font-semibold tabular-nums ${
                                  line.change > 0 ? 'text-st-primary' : line.change < 0 ? 'text-st-secondary' : ''
                                }`}
                              >
                                {signedMoney(line.change)}
                              </Td>
                            </tr>
                          ))}
                          <tr className="border-t border-st-high">
                            <Td>Loss of pay</Td>
                            <Td className="text-right tabular-nums">
                              {count(previousSummary.lopDays)} day(s)
                            </Td>
                            <Td className="text-right tabular-nums">
                              {count(summary.lopDays)} day(s)
                            </Td>
                            <Td className="text-right font-semibold tabular-nums">
                              {signedMoney(delta(summary.lopDeduction, previousSummary.lopDeduction))}
                            </Td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <p
                      className={`mt-2 rounded-lg px-2 py-1.5 text-[10px] leading-snug ${
                        movement.reconciled
                          ? 'bg-st-secondary-container/40 text-st-on'
                          : 'bg-st-error-container/50 text-st-on-error-container'
                      }`}
                    >
                      {movement.reconciled
                        ? `The two effects add up to ${signedMoney(movement.total)}, which matches the change in gross payroll between the two windows.`
                        : `The two effects add up to ${signedMoney(movement.total)} but the gross payroll moved ${signedMoney(headcount.payrollCostIncrease)} — check the payroll runs before quoting either number.`}
                    </p>
                  </>
                ) : (
                  <p className="text-[11px] leading-relaxed text-st-on-variant">
                    A movement breakdown needs two payroll windows. Pick a month that has a completed
                    predecessor to see why the cost changed.
                  </p>
                )}
              </Panel>

              {/* ── reports ───────────────────────────────────────────── */}
              <Panel
                title="Key reports & downloads"
                subtitle="Fifteen analytics reports, each reading the same snapshots."
                bodyClassName="grid gap-2 border-t border-st-high p-3 sm:grid-cols-2 2xl:grid-cols-3"
              >
                {LINKS.map(({ to, label, icon: Icon, note }) => (
                  <Link
                    key={to}
                    to={to}
                    className="flex items-start gap-2 rounded-xl border border-st-high bg-st-low/30 px-2.5 py-2 hover:bg-st-low"
                  >
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-st-low text-st-on-variant">
                      <Icon aria-hidden="true" size={12} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[11px] font-semibold text-st-on">{label}</span>
                      <span className="block text-[10px] leading-snug text-st-on-variant">{note}</span>
                    </span>
                  </Link>
                ))}
              </Panel>
              {!canSeeFinancial ? (
                <p className="px-1 text-[10px] text-st-on-variant">
                  The cost-to-company report is restricted to Finance (§16).
                </p>
              ) : null}
            </div>

            {/* ── right rail ─────────────────────────────────────────── */}
            <Rail>
              <Panel
                title="Quick statutory position"
                subtitle="Employee + employer, for the same window."
                right={<Pill tone={buckets.length ? 'good' : 'default'}>{money(statutoryTotals.totalLiability)}</Pill>}
                bodyClassName="px-4 pb-4"
              >
                {buckets.length === 0 ? (
                  <p className="text-[11px] leading-relaxed text-st-on-variant">
                    No statutory liability in this window — either no scheme applies or no snapshot
                    carried one.
                  </p>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr>
                        <Th className="px-0">Component</Th>
                        <Th className="px-0 text-right">Employee</Th>
                        <Th className="px-0 text-right">Employer</Th>
                        <Th className="px-0 text-right">Total</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {buckets.map((bucket) => (
                        <tr key={bucket.key} className="border-t border-st-high">
                          <Td className="px-0">{bucket.label}</Td>
                          <Td className="px-0 text-right tabular-nums">{money(bucket.employee)}</Td>
                          <Td className="px-0 text-right tabular-nums">
                            {Number(bucket.employer) ? money(bucket.employer) : '—'}
                          </Td>
                          <Td className="px-0 text-right font-semibold tabular-nums">
                            {money(bucket.total)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="mt-2 border-t border-st-high pt-1">
                  <Fact label="Gratuity provision" value={money(statutoryTotals.gratuityProvision)} />
                  <Fact
                    label="Annualised gratuity exposure"
                    value={money(statutoryTotals.gratuityAnnualised)}
                  />
                </div>
                <p className="pt-2 text-[10px] leading-snug text-st-on-variant">
                  Gratuity is a provision the company carries, not money remitted this month, so it sits
                  outside the liability total.
                </p>
                <Link
                  to="/app/payroll/analytics/statutory"
                  className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-st-primary hover:underline"
                >
                  Open the statutory summary <ArrowRight aria-hidden="true" size={10} />
                </Link>
              </Panel>

              <Panel
                title="Headcount & cost"
                subtitle={`Active employees against the ${monthLabel(dashboard.month)} payroll.`}
                right={<ExportMenu theme="st" reportKey="HEADCOUNT" filters={{ month }} />}
                bodyClassName="px-4 pb-4"
              >
                <Fact label="Active employees" value={count(headcount.activeEmployees)} />
                <Fact label="Joined this month" value={count(headcount.joinedThisMonth)} />
                <Fact label="Exited this month" value={count(headcount.exitedThisMonth)} />
                <Fact label="Net headcount change" value={count(headcount.netHeadcountChange)} />
                <Fact label="Employees paid" value={count(headcount.employeesPaid)} />
                <Fact label="Cost per active employee" value={money(headcount.averageCostPerEmployee)} />
                <Fact
                  label={`Change vs ${monthLabel(dashboard.previousMonth) || 'previous'}`}
                  value={`${money(headcount.payrollCostIncrease)} · ${percent(headcount.payrollCostIncreasePercent)}`}
                />
              </Panel>

              <Panel title="How this page knows" bodyClassName="px-4 pb-4">
                <Fact label="Snapshot path" value={dashboard.source || '—'} />
                <Fact label="Window" value={`${monthLabel(dashboard.period?.fromMonth || dashboard.month)} → ${monthLabel(dashboard.period?.toMonth || dashboard.month)}`} />
                <Fact
                  label="Snapshots calculated / errored"
                  value={`${count(accuracy.calculated)} / ${count(accuracy.errors)}`}
                />
                <Fact
                  label="Payroll accuracy"
                  value={percent(accuracy.accuracyPercent)}
                />
                <p className="pt-2 text-[10px] leading-snug text-st-on-variant">
                  &ldquo;Accuracy&rdquo; is the share of this month&apos;s payroll snapshots that calculated
                  without an error. It is not a claim that the payroll was checked by a person.
                </p>
              </Panel>
            </Rail>
          </div>
        </>
      ) : null}
    </div>
  );
};

export default ExecutiveDashboardPage;
