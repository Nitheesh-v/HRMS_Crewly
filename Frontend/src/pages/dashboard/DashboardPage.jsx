// ============================================================
// 🏠 DASHBOARD — self widgets for everyone + 👥 My Team panel
// for MANAGER / TEAM_LEAD / COMPANY_ADMIN / HR_MANAGER (Phase 10)
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { dashboardService } from '../../services/selfService';
import useAuth from '../../hooks/useAuth';



const SENIORS = ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'];

const errMsg = (err, fb) => err?.response?.data?.message || err?.data?.message || err?.message || fb;
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const monthLabel = (m) => {
  if (!m) return '—';
  const [y, mo] = m.split('-');
  return `${new Date(y, mo - 1).toLocaleDateString('en', { month: 'long' })} ${y}`;
};

const TODAY_STYLE = {
  PRESENT: 'bg-crewly-green/15 text-crewly-green',
  LATE: 'bg-crewly-orange/15 text-crewly-orange',
  HALF_DAY: 'bg-blue-500/15 text-blue-400',
  ABSENT: 'bg-crewly-red/15 text-crewly-red',
};

const StatCard = ({ icon, label, value, sub, accent = 'text-crewly-text' }) => (
  <div className="card">
    <div className="flex items-center justify-between">
      <span className="text-xl">{icon}</span>
      <span className={`text-2xl font-extrabold ${accent}`}>{value}</span>
    </div>
    <p className="mt-1 text-xs uppercase tracking-wide text-crewly-dim">{label}</p>
    {sub && <p className="mt-0.5 text-[11px] text-crewly-dim">{sub}</p>}
  </div>
);

const Panel = ({ title, action, children }) => (
  <section className="card flex min-h-44 flex-col">
    <div className="mb-3 flex items-center justify-between">
      <h3 className="font-semibold">{title}</h3>
      {action}
    </div>
    <div className="flex-1">{children}</div>
  </section>
);

const DashboardPage = () => {

// 🛡️ Meeting date/time that survives BOTH old (date/startTime) and new (startAt) field shapes
const fmtMeetDay = (m) => {
  const raw = m.date || m.occStart || m.startAt;
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return String(raw).slice(5).split('-').reverse().join('/'); // old "YYYY-MM-DD" strings
  }
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const fmtMeetTime = (m) => {
  if (m.startTime) return m.startTime; // old string field
  const raw = m.occStart || m.startAt;
  return raw ? new Date(raw).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
};

  const { user } = useAuth();
  const isSenior = SENIORS.includes(user?.role);

  const [data, setData] = useState(null);
  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const calls = [dashboardService.employeeOverview()];
      if (isSenior) calls.push(dashboardService.managerOverview());
      const [self, teamRes] = await Promise.all(calls);
      setData(self?.data || self);
      if (teamRes) setTeam(teamRes?.data || teamRes);
    } catch (err) { setError(errMsg(err, 'Failed to load dashboard')); }
    finally { setLoading(false); }
  }, [isSenior]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <p className="text-crewly-dim">Loading your dashboard…</p>;

  const a = data?.attendance || {};
  const balances = data?.leaveBalance || [];
  const totalRemaining = balances.reduce((s, b) => s + b.remaining, 0);
  const today = data?.today;

  return (
    <div>
      <div className="mb-1 flex items-end justify-between">
        <h1 className="text-2xl font-bold">🏠 My Dashboard</h1>
        <span className="text-xs text-crewly-dim">{monthLabel(data?.month)}</span>
      </div>
      <p className="mb-5 text-sm text-crewly-dim">Everything about you{isSenior ? ' — and your people' : ''}, at a glance. 💪</p>

      {error && <div className="mb-5 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      {/* ── 👥 MY TEAM panel (Phase 10 — seniors only) ── */}
      {isSenior && team && (
        <section className="card mb-5 border-crewly-green/30">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">👥 My Team <span className="ml-1 text-xs font-normal text-crewly-dim">({team.scopeLabel} · {team.memberCount} people)</span></h2>
            <Link to="/app/org-chart" className="text-xs text-crewly-green hover:underline">Org chart →</Link>
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-crewly-bg p-3 text-center">
              <p className="text-xl font-extrabold text-crewly-green">{team.today.present}</p>
              <p className="text-[11px] uppercase text-crewly-dim">Present today</p>
            </div>
            <div className="rounded-lg bg-crewly-bg p-3 text-center">
              <p className="text-xl font-extrabold text-crewly-red">{team.today.absent}</p>
              <p className="text-[11px] uppercase text-crewly-dim">Absent</p>
            </div>
            <div className="rounded-lg bg-crewly-bg p-3 text-center">
              <p className="text-xl font-extrabold text-crewly-orange">{team.pendingLeaves}</p>
              <p className="text-[11px] uppercase text-crewly-dim">Leave approvals</p>
            </div>
            <div className="rounded-lg bg-crewly-bg p-3 text-center">
              <p className="text-xl font-extrabold text-crewly-text">
                {team.tasks.open}
                {team.tasks.overdue > 0 && <span className="ml-1 text-xs font-bold text-crewly-red">({team.tasks.overdue} overdue)</span>}
              </p>
              <p className="text-[11px] uppercase text-crewly-dim">Open tasks</p>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            {team.members.slice(0, 8).map((m) => (
              <div key={m._id} className="flex items-center gap-3 rounded-lg bg-crewly-bg px-3 py-2">
                {m.avatarUrl ? (
                  <img src={m.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-crewly-green/15 text-xs font-bold text-crewly-green">
                    {m.name?.[0]?.toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.name}</p>
                  <p className="truncate text-[11px] text-crewly-dim">{m.role?.replace('_', ' ')}{m.department ? ` · ${m.department}` : ''}</p>
                </div>
                {m.today ? (
                  <span className={`badge ${TODAY_STYLE[m.today] || ''}`}>{m.today.replace('_', ' ')}</span>
                ) : (
                  <span className="badge bg-gray-500/15 text-gray-500">not marked</span>
                )}
              </div>
            ))}
          </div>
          {team.members.length > 8 && (
            <p className="mt-2 text-center text-xs text-crewly-dim">+{team.members.length - 8} more — see User Management</p>
          )}
        </section>
      )}

      {/* ── self stat cards ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon="✅" label={`Present · ${monthLabel(data?.month)}`} value={(a.present || 0) + (a.late || 0)} sub={a.late ? `incl. ${a.late} late` : 'on time streak!'} accent="text-crewly-green" />
        <StatCard icon="❌" label="Absent days" value={a.absent || 0} sub={a.halfDay ? `${a.halfDay} half-day(s)` : ''} accent={a.absent ? 'text-crewly-red' : 'text-crewly-text'} />
        <StatCard icon="🌴" label="Leave balance" value={totalRemaining} sub={balances.map((b) => `${b.type.toLowerCase()} ${b.remaining}/${b.total}`).join(' · ')} accent="text-crewly-orange" />
        <StatCard
          icon="🕒"
          label="Today's attendance"
          value={today ? today.status?.replace('_', ' ') : 'Not marked'}
          sub={today?.checkIn ? `checked in ${today.checkIn}` : 'mark it from Attendance →'}
          accent={today ? (today.status === 'LATE' ? 'text-crewly-orange' : 'text-crewly-green') : 'text-crewly-dim'}
        />
      </div>

      {/* ── self panels ── */}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Panel title={`📋 Pending Tasks (${data?.pendingTasks?.count || 0})`} action={<Link to="/app/tasks" className="text-xs text-crewly-green hover:underline">My Tasks →</Link>}>
          {data?.pendingTasks?.items?.length ? (
            <ul className="space-y-2">
              {data.pendingTasks.items.map((t) => (
                <li key={t._id} className="flex items-center justify-between gap-2 rounded-lg bg-crewly-bg px-3 py-2 text-sm">
                  <span className="truncate">{t.title}</span>
                  <span className={`badge shrink-0 ${t.priority === 'HIGH' ? 'bg-crewly-red/15 text-crewly-red' : 'bg-crewly-orange/15 text-crewly-orange'}`}>{t.status?.replace('_', ' ')}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-6 text-center text-sm text-crewly-dim">All clear — no pending tasks 🎉</p>}
        </Panel>

        <Panel title="📅 Upcoming Meetings" action={<Link to="/app/meetings" className="text-xs text-crewly-green hover:underline">All meetings →</Link>}>
          {data?.upcomingMeetings?.length ? (
            <ul className="space-y-2">
              {data.upcomingMeetings.map((m) => (
                <li key={m._id} className="flex items-center justify-between gap-2 rounded-lg bg-crewly-bg px-3 py-2 text-sm">
                  <span className="truncate">{m.title}</span>
             <span className="shrink-0 text-xs text-crewly-dim">{fmtMeetDay(m)} · {fmtMeetTime(m)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-6 text-center text-sm text-crewly-dim">No meetings scheduled — enjoy the focus time 🧘</p>}
        </Panel>

        <Panel title="🧾 Latest Payslip" action={<Link to="/app/payslips" className="text-xs text-crewly-green hover:underline">My Payslips →</Link>}>
          {data?.latestPayslip ? (
            <div className="flex items-center justify-between rounded-lg bg-crewly-bg px-4 py-4">
              <div>
                <p className="text-sm text-crewly-dim">{monthLabel(data.latestPayslip.month)}</p>
                <p className="text-2xl font-extrabold text-crewly-green">{money(data.latestPayslip.netPay)}</p>
              </div>
              <span className={`badge ${data.latestPayslip.status === 'PAID' ? 'bg-crewly-green/15 text-crewly-green' : 'bg-crewly-orange/15 text-crewly-orange'}`}>{data.latestPayslip.status}</span>
            </div>
          ) : <p className="mt-6 text-center text-sm text-crewly-dim">No payslip yet — payroll runs monthly 💸</p>}
        </Panel>

        <Panel title="📢 Announcements" action={<Link to="/app/announcements" className="text-xs text-crewly-green hover:underline">All →</Link>}>
          {data?.announcements?.length ? (
            <ul className="space-y-2">
              {data.announcements.map((ann) => (
                <li key={ann._id} className="rounded-lg bg-crewly-bg px-3 py-2">
                  <p className="text-sm font-medium">{ann.pinned && '📌 '}{ann.title}</p>
                  <p className="text-[11px] text-crewly-dim">{ann.postedBy?.name || 'HR'} · {new Date(ann.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</p>
                </li>
              ))}
            </ul>
          ) : <p className="mt-6 text-center text-sm text-crewly-dim">Quiet day — no announcements 📭</p>}
        </Panel>
      </div>
    </div>
  );
};

export default DashboardPage;