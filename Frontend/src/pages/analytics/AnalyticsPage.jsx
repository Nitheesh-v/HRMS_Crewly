import { useEffect, useState } from 'react';
import systemService from '../../services/systemService';
import useAuth from '../../hooks/useAuth';
import { roleLabel } from '../../utils/roles';


const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const mLabel = (m) => MONTH_SHORT[Number(m.slice(5)) - 1];
const moneyK = (v) => (v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : v >= 1000 ? `₹${Math.round(v / 1000)}k` : `₹${v}`);

const ROLE_COLORS = ['#3fb950', '#58a6ff', '#bc8cff', '#f0a35e', '#8b949e', '#f85149'];

// tiny CSS bar chart — no dependency, respects dark theme
function BarChart({ title, data, formatY = (v) => v, color = '#3fb950', labelKey = 'month', valueKey = 'value', sub }) {
  const max = Math.max(1, ...data.map((d) => d[valueKey]));
  return (
    <div className="card p-5">
      <div className="mb-1 text-sm font-semibold">{title}</div>
      {sub && <div className="mb-3 text-xs text-crewly-dim">{sub}</div>}
      <div className="flex h-36 items-end gap-2">
        {data.map((d) => (
          <div key={d[labelKey]} className="flex flex-1 flex-col items-center gap-1" title={formatY(d[valueKey])}>
            <div className="text-[10px] text-crewly-dim">{d[valueKey] ? formatY(d[valueKey]) : ''}</div>
            <div className="w-full max-w-10 rounded-t" style={{ height: `${Math.max(2, (d[valueKey] / max) * 100)}%`, background: color, opacity: d[valueKey] ? 1 : 0.25 }} />
            <div className="text-[10px] text-crewly-dim">{mLabel(d[labelKey])}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }) {
  return (
    <div className="card p-4">
      <div className="text-xl">{icon}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      <div className="text-xs text-crewly-dim">{label}</div>
    </div>
  );
}

export default function AnalyticsPage() {
  useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await systemService.analytics();
        setData(res?.data || res);
      } catch (err) {
        setError(err?.response?.data?.message || err.message);
      }
    })();
  }, []);

  if (error) return <div className="p-6"><div className="card p-6 text-crewly-red">{error}</div></div>;
  if (!data) return <div className="p-6 text-crewly-dim">Loading analytics…</div>;

  const { counts, roleHeadcount, attendance, leaveTrend, payrollTrend } = data;

  // donut via conic-gradient
  const total = Math.max(1, roleHeadcount.reduce((s, r) => s + r.count, 0));
  let acc = 0;
  const segments = roleHeadcount.map((r, i) => {
    const from = (acc / total) * 100;
    acc += r.count;
    return `${ROLE_COLORS[i % ROLE_COLORS.length]} ${from}% ${(acc / total) * 100}%`;
  });
  const donut = `conic-gradient(${segments.join(', ')})`;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold">📊 Analytics</h1>
        <p className="text-sm text-crewly-dim">Company health at a glance — live from your data.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard icon="👥" label="Employees" value={counts.employees} />
        <StatCard icon="🏗️" label="Departments" value={counts.departments} />
        <StatCard icon="🌴" label="Pending leaves" value={counts.pendingLeaves} />
        <StatCard icon="🚪" label="Pending exits" value={counts.pendingExits} />
        <StatCard icon="📌" label="Open jobs" value={counts.openJobs} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* attendance rate */}
        <div className="card p-5">
          <div className="text-sm font-semibold">🕒 Attendance Rate (this month)</div>
          <div className="mt-3 text-4xl font-bold text-crewly-green">{attendance.rate}%</div>
          <div className="mt-2 h-2 rounded-full bg-crewly-border/40">
            <div className="h-2 rounded-full bg-crewly-green" style={{ width: `${attendance.rate}%` }} />
          </div>
          <div className="mt-2 text-xs text-crewly-dim">{attendance.records} records / {attendance.expected} expected</div>
        </div>

        {/* headcount donut */}
        <div className="card p-5">
          <div className="text-sm font-semibold">👥 Headcount by Role</div>
          <div className="mt-3 flex items-center gap-4">
            <div className="relative h-24 w-24 rounded-full" style={{ background: donut }}>
              <div className="absolute inset-3 flex items-center justify-center rounded-full bg-crewly-card text-sm font-bold">{total}</div>
            </div>
            <div className="space-y-1 text-xs">
              {roleHeadcount.map((r, i) => (
                <div key={r.role} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ROLE_COLORS[i % ROLE_COLORS.length] }} />
                  {roleLabel(r.role)} — <b>{r.count}</b>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* payroll trend */}
        <BarChart title="💰 Payroll Trend (net pay)" sub="last 6 months"
          data={payrollTrend.map((p) => ({ ...p, value: p.netPay }))}
          formatY={moneyK} color="#3fb950" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-1">
        <BarChart title="🌴 Leave Requests Trend" sub="last 6 months"
          data={leaveTrend.map((l) => ({ ...l, value: l.count }))}
          formatY={(v) => `${v} req`} color="#58a6ff" />
      </div>
    </div>
  );
}