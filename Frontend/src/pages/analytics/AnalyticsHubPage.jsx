// Analytics Hub — one page, many tabs, chosen by YOUR role:
//   SUPER_ADMIN → Platform (MRR/ARR)
//   Admin/HR    → Overview / Attendance / Leaves / Payroll / Work / Hiring
//   Manager/TL  → Team-scoped tabs (backend locks the data)
//   Employee    → My Stats only
// All charts are tiny hand-made SVG components — no chart library needed.
import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { Link } from 'react-router-dom';
import analyticsService from '../../services/analyticsService';

const panel = 'rounded-xl border border-slate-700 bg-slate-900 p-4';
const sel = 'rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100';
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'],
  ['this_month', 'This month'], ['prev_month', 'Prev month'], ['this_quarter', 'This quarter'],
  ['prev_quarter', 'Prev quarter'], ['this_year', 'This year'], ['prev_year', 'Prev year'],
];

// ---------- tiny reusable chart components (pure SVG) ----------

// One big number card
function KPI({ icon, label, value, sub, tone = 'text-slate-100' }) {
  return (
    <div className={panel}>
      <div className="text-xs text-slate-400">{icon} {label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone}`}>{value ?? '—'}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

// Vertical bars: data = [{ label, value }]
function Bars({ data, labelKey, valueKey, color = '#6366f1', height = 140 }) {
  const values = data.map((d) => d[valueKey] || 0);
  const max = Math.max(1, ...values); // Math.max(1, …) avoids divide-by-zero
  if (!data.length) return <p className="text-xs text-slate-500">No data in this range.</p>;
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${d[labelKey]}: ${d[valueKey]}`}>
          <span className="text-[9px] text-slate-400">{d[valueKey]}</span>
          <div className="w-full rounded-t" style={{ height: Math.max(2, (d[valueKey] / max) * (height - 34)), background: color }} />
          <span className="w-full truncate text-center text-[9px] text-slate-500">{String(d[labelKey]).slice(0, 6)}</span>
        </div>
      ))}
    </div>
  );
}

// Line trend: a polyline through points scaled to 0–100
function Trend({ data, labelKey, valueKey, color = '#34d399', height = 140 }) {
  if (!data.length) return <p className="text-xs text-slate-500">No data in this range.</p>;
  const values = data.map((d) => d[valueKey] || 0);
  const max = Math.max(1, ...values);
  const stepX = 100 / Math.max(1, data.length - 1);
  const points = data.map((d, i) => `${i * stepX},${100 - ((d[valueKey] || 0) / max) * 90}`).join(' ');
  return (
    <div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height, width: '100%' }}>
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[9px] text-slate-500">
        <span>{data[0][labelKey]}</span>
        <span>{data[data.length - 1][labelKey]}</span>
      </div>
    </div>
  );
}

// Donut: parts = [{ label, value }] drawn as colored circle segments
function Donut({ parts, size = 130 }) {
  const colors = ['#6366f1', '#34d399', '#f59e0b', '#f472b6', '#38bdf8', '#a78bfa', '#fb7185'];
  const total = Math.max(1, parts.reduce((sum, p) => sum + p.value, 0));
  const radius = 15.9;
  const circumference = 2 * Math.PI * radius;
  let drawnSoFar = 0; // fraction of the circle already painted (0..1)
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox="0 0 42 42">
        <circle cx="21" cy="21" r={radius} fill="none" stroke="#1e293b" strokeWidth="6" />
        {parts.map((p, i) => {
          const fraction = p.value / total;
          const dasharray = `${fraction * circumference} ${circumference}`;
          const dashoffset = -drawnSoFar * circumference;
          drawnSoFar += fraction;
          return <circle key={i} cx="21" cy="21" r={radius} fill="none" stroke={colors[i % colors.length]} strokeWidth="6" strokeDasharray={dasharray} strokeDashoffset={dashoffset} />;
        })}
        <text x="21" y="23" textAnchor="middle" fill="#e2e8f0" fontSize="7" fontWeight="bold">{total}</text>
      </svg>
      <div className="space-y-1 text-xs">
        {parts.map((p, i) => (
          <div key={i} className="flex items-center gap-2 text-slate-300">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colors[i % colors.length] }} />
            {p.label} <b>{p.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- the page itself ----------
export default function AnalyticsHubPage() {
  const user = useSelector((s) => s.auth.user);
  const role = user?.role;
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const isHR = role === 'COMPANY_ADMIN' || role === 'HR_MANAGER';
  const isSenior = isHR || role === 'MANAGER' || role === 'TEAM_LEAD';

  // which tabs this role is allowed to see (backend enforces it too)
  let tabs = [['my', '📊 My Stats']];
  if (isSuperAdmin) tabs = [['platform', '🏢 Platform']];
  else if (isHR) tabs = [['overview', '📊 Overview'], ['attendance', '🕒 Attendance'], ['leaves', '🌴 Leaves'], ['payroll', '💰 Payroll'], ['work', '✅ Work'], ['recruitment', '🧲 Hiring']];
  else if (isSenior) tabs = [['overview', '📊 Team'], ['attendance', '🕒 Attendance'], ['leaves', '🌴 Leaves'], ['work', '✅ Work']];

  const [tab, setTab] = useState(tabs[0][0]);
  const [preset, setPreset] = useState('this_month');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  // fetch the right endpoint whenever tab or date preset changes
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        let result;
        if (tab === 'overview') result = await analyticsService.overview({ preset });
        else if (tab === 'attendance') result = await analyticsService.attendance({ preset });
        else if (tab === 'leaves') result = await analyticsService.leaves({ preset });
        else if (tab === 'payroll') result = await analyticsService.payroll({ preset });
        else if (tab === 'work') result = await analyticsService.work({ preset });
        else if (tab === 'recruitment') result = await analyticsService.recruitment({ preset });
        else if (tab === 'platform') result = await analyticsService.saas();
        else result = await analyticsService.my();
        if (!cancelled) setData(result);
      } catch (error) {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; }; // ignore old answers if the user switched tabs quickly
  }, [tab, preset]);

  const k = data?.kpis;

  return (
    <div className="p-6 space-y-5 text-slate-100">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">📊 Analytics</h1>
          <p className="text-sm text-slate-400">Server-side aggregated · RBAC-scoped · export-ready</p>
        </div>
        <div className="flex items-center gap-2">
          {!isSuperAdmin && tab !== 'my' && (
            <select className={sel} value={preset} onChange={(e) => setPreset(e.target.value)}>
              {PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          )}
          {isSenior && <Link to="/app/reports" className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium text-white">📑 Report Builder</Link>}
        </div>
      </div>

      {/* tab switcher */}
      <div className="flex flex-wrap gap-2">
        {tabs.map(([value, label]) => (
          <button key={value} onClick={() => setTab(value)}
            className={tab === value ? 'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white' : 'rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-2 text-sm text-slate-300'}>
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-slate-400">Crunching numbers… ⚙️</p>}

      {/* OVERVIEW */}
      {!loading && tab === 'overview' && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <KPI icon="👥" label="Headcount" value={k.headcount} sub={`${k.growth >= 0 ? '📈' : '📉'} ${k.growth}% vs prev month`} />
            <KPI icon="✅" label="Active" value={k.active} tone="text-emerald-300" />
            <KPI icon="⏸" label="Inactive" value={k.inactive} tone="text-slate-400" />
            <KPI icon="✨" label="New hires" value={k.newHires} tone="text-indigo-300" />
            <KPI icon="🚪" label="Exits" value={k.exits} tone="text-rose-300" />
            <KPI icon="📉" label="Attrition" value={`${k.attritionRate}%`} sub="exits ÷ avg headcount" tone="text-amber-300" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">📈 Headcount trend (12 months)</h3><Trend data={data.headcountTrend || []} labelKey="label" valueKey="headcount" /></div>
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">🏬 Department strength</h3><Bars data={data.byDepartment || []} labelKey="name" valueKey="count" color="#38bdf8" /></div>
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">🎖 By designation</h3><Bars data={data.byDesignation || []} labelKey="name" valueKey="count" color="#a78bfa" /></div>
            <div className="grid grid-cols-2 gap-3">
              <KPI icon="🏬" label="Departments" value={k.departments} />
              <KPI icon="🌴" label="Pending leaves" value={k.pendingLeaves} tone="text-amber-300" />
              <KPI icon="🧲" label="Open jobs" value={k.openJobs} />
              <KPI icon="📁" label="Active projects" value={k.activeProjects} />
            </div>
          </div>
        </div>
      )}

      {/* ATTENDANCE */}
      {!loading && tab === 'attendance' && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KPI icon="✅" label="Present" value={data.counts.present} tone="text-emerald-300" />
            <KPI icon="❌" label="Absent" value={data.counts.absent} tone="text-rose-300" />
            <KPI icon="⏰" label="Late" value={data.counts.late} tone="text-amber-300" />
            <KPI icon="🌗" label="Half-day" value={data.counts.halfDay} />
            <KPI icon="🌴" label="On leave" value={data.counts.leave} />
            <KPI icon="📊" label="Attendance" value={`${data.counts.attendancePct}%`} sub="present ÷ (present+absent)" tone="text-indigo-300" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">📅 Daily presents trend</h3><Trend data={data.dailyTrend || []} labelKey="d" valueKey="present" /></div>
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">🥧 Status mix</h3><Donut parts={(data.byStatusRaw || []).map((s) => ({ label: s._id || 'UNKNOWN', value: s.count }))} /></div>
          </div>
        </div>
      )}

      {/* LEAVES */}
      {!loading && tab === 'leaves' && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPI icon="🌴" label="Total requests" value={data.counts.total} />
            <KPI icon="✅" label="Approved" value={data.counts.approved} tone="text-emerald-300" />
            <KPI icon="⏳" label="Pending" value={data.counts.pending} tone="text-amber-300" />
            <KPI icon="❌" label="Rejected" value={data.counts.rejected} tone="text-rose-300" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">🌴 Days used by type (approved)</h3><Bars data={data.byType || []} labelKey="type" valueKey="days" color="#34d399" /></div>
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">📈 Monthly trend</h3><Trend data={data.monthlyTrend || []} labelKey="label" valueKey="count" color="#f59e0b" /></div>
            {(data.topUsers || []).length > 0 && (
              <div className={panel}>
                <h3 className="mb-2 text-sm font-semibold text-slate-300">🏖 Highest leave usage</h3>
                <div className="space-y-1 text-sm">
                  {data.topUsers.map((u, i) => <div key={i} className="flex justify-between text-slate-300"><span>{u.name}</span><b>{u.days} days</b></div>)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PAYROLL (HR/Admin only — the route enforces this too) */}
      {!loading && tab === 'payroll' && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPI icon="💰" label="Total net paid" value={money(data.totals.net)} tone="text-emerald-300" />
            <KPI icon="🧾" label="Gross" value={money(data.totals.gross)} />
            <KPI icon="➖" label="Deductions" value={money(data.totals.deductions)} tone="text-rose-300" />
            <KPI icon="📄" label="Payslips" value={data.totals.slips} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">📈 Net payroll trend</h3><Trend data={data.monthly || []} labelKey="label" valueKey="net" /></div>
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">🏬 Cost by department</h3><Bars data={(data.byDepartment || []).map((d) => ({ name: d.name, net: d.net }))} labelKey="name" valueKey="net" color="#f472b6" /></div>
          </div>
        </div>
      )}

      {/* WORK */}
      {!loading && tab === 'work' && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <KPI icon="✅" label="Tasks done" value={`${data.tasks.done}/${data.tasks.total}`} sub={`${data.tasks.completionPct}% complete`} tone="text-emerald-300" />
            <KPI icon="🔥" label="Overdue" value={data.tasks.overdue} tone="text-rose-300" />
            <KPI icon="📁" label="Projects" value={`${data.projects.active}/${data.projects.total}`} sub="active / total" />
            <KPI icon="⏰" label="Delayed projects" value={data.projects.delayed} tone="text-amber-300" />
            <KPI icon="💸" label="Approved expenses" value={money(data.expenses.approvedTotal)} />
            <KPI icon="⭐" label="Avg rating" value={data.performance.avgRating || '—'} sub={`goals ${data.performance.goalCompletion}%`} tone="text-indigo-300" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">👤 Tasks per teammate</h3><Bars data={(data.tasks.byUser || []).map((u) => ({ name: u.name, total: u.total }))} labelKey="name" valueKey="total" color="#38bdf8" /></div>
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">🥧 Task status mix</h3><Donut parts={(data.tasks.byStatusRaw || []).map((s) => ({ label: s._id, value: s.count }))} /></div>
          </div>
        </div>
      )}

      {/* RECRUITMENT */}
      {!loading && tab === 'recruitment' && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <KPI icon="🧲" label="Jobs" value={data.jobs.total} sub={`${data.jobs.open} open`} />
            {data.applications ? (
              <>
                <KPI icon="📨" label="Applications" value={data.applications.total} />
                <KPI icon="🔍" label="Screening" value={data.applications.screening} sub={`${data.applications.rates.appToScreening}% of apps`} />
                <KPI icon="⭐" label="Shortlisted" value={data.applications.shortlisted} sub={`${data.applications.rates.screeningToShortlist}% of screened`} />
                <KPI icon="🎤" label="Interviews" value={data.applications.interview} sub={`${data.applications.rates.interviewToOffer}% → offer`} />
                <KPI icon="🤝" label="Hires" value={data.applications.hires} sub={`${data.applications.rates.offerAcceptance}% acceptance`} tone="text-emerald-300" />
              </>
            ) : (
              <KPI icon="📨" label="Applications" value="—" sub="Add an Application model to unlock the funnel" />
            )}
          </div>
          {data.applications?.bySource?.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">🌐 Applications by source</h3><Bars data={data.applications.bySource} labelKey="source" valueKey="applications" color="#f59e0b" /></div>
              <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">🤝 Hires by source</h3><Bars data={data.applications.bySource} labelKey="source" valueKey="hires" color="#34d399" /></div>
            </div>
          )}
        </div>
      )}

      {/* PLATFORM (SUPER_ADMIN) */}
      {!loading && tab === 'platform' && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <KPI icon="🏢" label="Companies" value={data.companies.total} sub={`+${data.companies.newThisMonth} this month`} />
            <KPI icon="🧪" label="On trial" value={data.companies.trial} tone="text-amber-300" />
            <KPI icon="👤" label="Platform users" value={data.users.total} sub={`+${data.users.newThisMonth} new`} />
            <KPI icon="💳" label="Paying companies" value={data.revenue.payingCompanies} tone="text-emerald-300" />
            <KPI icon="📈" label="MRR" value={money(data.revenue.mrr)} sub={`${data.revenue.mrrGrowthPct >= 0 ? '+' : ''}${data.revenue.mrrGrowthPct}% MoM`} tone="text-emerald-300" />
            <KPI icon="🗓" label="ARR" value={money(data.revenue.arr)} tone="text-indigo-300" />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">📦 Plan distribution</h3><Donut parts={data.companies.byPlan.map((p) => ({ label: p.name, value: p.count }))} /></div>
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">🚦 Status distribution</h3><Donut parts={data.companies.byStatus.map((p) => ({ label: p.name, value: p.count }))} /></div>
            <div className={panel}><h3 className="mb-2 text-sm font-semibold text-slate-300">💰 MRR by plan</h3><Bars data={data.revenue.mrrByPlan} labelKey="plan" valueKey="mrr" color="#34d399" /></div>
          </div>
          <p className="text-xs text-slate-500">⚙️ MRR uses <code>PLAN_PRICING</code> in <code>saasAnalyticsController.js</code> — edit the prices there to match your real plans.</p>
        </div>
      )}

      {/* MY STATS (everyone's own view) */}
      {!loading && tab === 'my' && data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPI icon="🕒" label="Days marked (month)" value={data.attendance.reduce((sum, x) => sum + x.count, 0)} />
            <KPI icon="✅" label="Tasks done" value={(data.tasks.find((t) => ['COMPLETED', 'DONE'].includes(String(t._id).toUpperCase())) || {}).count || 0} />
            <KPI icon="🌴" label="Leaves approved" value={(data.leaves.find((l) => l._id === 'APPROVED') || {}).count || 0} />
            <KPI icon="🔀" label="My shift" value={data.roster?.shift ? `${data.roster.shift.startTime}–${data.roster.shift.endTime}` : '—'} sub={data.roster?.shift?.name || 'no shift assigned'} />
          </div>
          <div className={panel}>
            <h3 className="mb-2 text-sm font-semibold text-slate-300">🎉 Upcoming holidays</h3>
            <div className="flex flex-wrap gap-2">
              {(data.upcomingHolidays || []).map((h) => (
                <span key={h.id + h.date} className="rounded-full bg-slate-800 border border-slate-700 px-3 py-1 text-xs text-slate-300"><b className="text-slate-100">{h.name}</b> · {h.date}</span>
              ))}
              {!data.upcomingHolidays?.length && <span className="text-xs text-slate-500">None in the next 45 days.</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}