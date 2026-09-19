// Dashboard — Figma parity (HRDashboard Community - Light/Dark, green #00C875)
// Keeps real API: dashboardService.employeeOverview / managerOverview
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Info,
  LayoutDashboard,
  Megaphone,
  Palmtree,
  Pin,
  ReceiptText,
  Timer,
  Users,
  XCircle,
} from "lucide-react";
import { dashboardService } from "../../services/selfService";
import useAuth from "../../hooks/useAuth";

const SENIORS = ["COMPANY_ADMIN", "HR_MANAGER", "MANAGER", "TEAM_LEAD"];
const errMsg = (err, fb) =>
  err?.response?.data?.message || err?.data?.message || err?.message || fb;
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const monthLabel = (m) => {
  if (!m) return "—";
  const [y, mo] = m.split("-");
  return `${new Date(y, mo - 1).toLocaleDateString("en", { month: "long" })} ${y}`;
};

const TODAY_STYLE = {
  PRESENT: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  LATE: "bg-amber-500/15 text-amber-600",
  HALF_DAY: "bg-blue-500/15 text-blue-500",
  ABSENT: "bg-red-500/15 text-red-500",
};

const FigmaStat = ({ icon, label, value, sub, accent = "text-slate-800 dark:text-white", to }) => {
  const body = (
    <>
      <div className="flex items-start justify-between">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-white/60">
          {icon}
        </div>
        <span className={`text-lg font-extrabold leading-none ${accent}`}>{value}</span>
      </div>
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-white/60">
        {label}
      </p>
      {sub && <p className="mt-1 text-xs leading-snug text-slate-600 dark:text-white/70 line-clamp-1">{sub}</p>}
    </>
  );
  if (to) {
    return (
      <Link to={to} className="rounded-xl border border-[#E6E9F0] bg-white p-4 shadow-sm transition hover:border-[#00C875]/40 hover:shadow-md dark:border-white/10 dark:bg-white/[0.04]">
        {body}
      </Link>
    );
  }
  return <div className="rounded-xl border border-[#E6E9F0] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">{body}</div>;
};

const Panel = ({ icon, title, action, children }) => (
  <section className="rounded-xl border border-[#E6E9F0] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
    <div className="mb-3 flex items-center justify-between">
      <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-white">
        {icon && <span className="text-slate-400">{icon}</span>}
        {title}
      </h3>
      {action}
    </div>
    <div>{children}</div>
  </section>
);

export default function DashboardPage() {
  const fmtMeetDay = (m) => {
    const raw = m.date || m.occStart || m.startAt;
    if (!raw) return "—";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw).slice(5).split("-").reverse().join("/");
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const fmtMeetTime = (m) => {
    if (m.startTime) return m.startTime;
    const raw = m.occStart || m.startAt;
    return raw ? new Date(raw).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";
  };

  const { user } = useAuth();
  const isSenior = SENIORS.includes(user?.role);
  const [data, setData] = useState(null);
  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const calls = [dashboardService.employeeOverview()];
      if (isSenior) calls.push(dashboardService.managerOverview());
      const [self, teamRes] = await Promise.all(calls);
      setData(self?.data || self);
      if (teamRes) setTeam(teamRes?.data || teamRes);
    } catch (err) {
      setError(errMsg(err, "Failed to load dashboard"));
    } finally {
      setLoading(false);
    }
  }, [isSenior]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) return <p className="text-sm text-slate-500">Loading your dashboard…</p>;

  const a = data?.attendance || {};
  const balances = data?.leaveBalance || [];
  const totalRemaining = balances.reduce((s, b) => s + b.remaining, 0);
  const today = data?.today;

  return (
    <div className="min-h-[calc(100dvh-64px)] bg-[#F5F7FB] dark:bg-crewly-bg -m-3 sm:-m-4 lg:-m-6 p-3 sm:p-4 lg:p-6">
      <div className="mx-auto max-w-[1160px]">
        {/* breadcrumb */}
        <p className="text-[11px] tracking-wide text-slate-500 dark:text-white/60">
          <Link to="/app" className="hover:text-slate-800 dark:hover:text-white">
            Dashboard
          </Link>{" "}
          <span className="mx-1">›</span> <span className="text-slate-800 dark:text-white">Overview</span>
        </p>
        <p className="mt-0.5 text-[11px] text-slate-400 dark:text-white/40">Manage &gt; Overview</p>

        {/* header */}
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-extrabold tracking-tight text-slate-800 dark:text-white">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0f1a2b] text-white dark:bg-white dark:text-slate-900">
                <LayoutDashboard className="h-4 w-4" />
              </span>
              My Dashboard
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-white/60">
              Everything about you{isSenior ? " — and your people" : ""}, at a glance. ·{" "}
              <span className="font-medium text-slate-700 dark:text-white/80">{monthLabel(data?.month)}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${today ? (TODAY_STYLE[today.status] || "bg-emerald-500/15 text-emerald-600") : "bg-white border border-[#E6E9F0] text-slate-500 dark:bg-white/5 dark:border-white/10 dark:text-white/60"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${today ? "bg-current" : "bg-slate-300"}`} />
              {today ? today.status.replace("_", " ") : "Not marked"}
              {today?.checkIn ? ` · ${today.checkIn}` : ""}
            </span>
            <Link to="/app/attendance" className="hidden sm:inline-flex items-center justify-center rounded-full bg-[#00C875] px-4 py-2 text-sm font-semibold text-white hover:brightness-105">
              {today ? "Go to Attendance →" : "Mark Attendance →"}
            </Link>
          </div>
        </div>

        {/* CTA mobile */}
        <Link to="/app/attendance" className="mt-3 flex sm:hidden items-center justify-center rounded-full bg-[#00C875] px-4 py-2.5 text-sm font-bold text-white">
          {today ? "Go to Attendance →" : "Mark Attendance →"}
        </Link>

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
            {error}
          </div>
        )}

        {/* 4 metric cards */}
        <div className="mt-6 grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
          <FigmaStat
            icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
            label={`Present · ${monthLabel(data?.month)}`}
            value={(a.present || 0) + (a.late || 0)}
            sub={a.late ? `incl. ${a.late} late` : "on time streak!"}
            accent="text-emerald-600"
          />
          <FigmaStat
            icon={<XCircle className="h-4 w-4 text-red-400" />}
            label="Absent days"
            value={a.absent || 0}
            sub={a.halfDay ? `${a.halfDay} half-day(s)` : "No absences"}
            accent={a.absent ? "text-red-500" : "text-slate-800 dark:text-white"}
          />
          <FigmaStat
            icon={<Palmtree className="h-4 w-4 text-amber-500" />}
            label="Leave balance"
            value={totalRemaining}
            sub={balances.map((b) => `${b.type.toLowerCase()} ${b.remaining}/${b.total}`).join(" · ") || "No leaves"}
            accent="text-amber-500"
          />
          <Link to="/app/attendance" className="rounded-xl border border-[#E6E9F0] bg-white p-4 shadow-sm transition hover:border-[#00C875]/40 hover:shadow-md dark:border-white/10 dark:bg-white/[0.04]">
            <div className="flex items-start justify-between">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-white/5 dark:text-emerald-400">
                <Timer className="h-4 w-4" />
              </div>
              <span className={`text-lg font-extrabold leading-none ${today ? (today.status === "LATE" ? "text-amber-500" : "text-emerald-600") : "text-slate-400"}`}>
                {today ? today.status?.replace("_", " ") : "Not marked"}
              </span>
            </div>
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-white/60">Today&apos;s attendance</p>
            <p className="mt-1 text-xs leading-snug text-slate-600 dark:text-white/70 line-clamp-1">
              {today?.checkIn ? `checked in ${today.checkIn}` : "tap here to mark attendance"}
            </p>
          </Link>
        </div>

        {/* blue banner */}
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-[#dbe4ff] bg-[#eef2ff] px-4 py-3 text-xs leading-relaxed text-[#3b5bdb] dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Your workspace is live — check in from the attendance page, track leaves, and review payroll. Need help? Contact HR or try Chrome DevTools Sensors for geofence testing (dev only).
          </p>
        </div>

        {/* My Team — seniors */}
        {isSenior && team && (
          <section className="mt-4 rounded-xl border border-[#E6E9F0] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-white">
                <Users className="h-4 w-4 text-[#00C875]" />
                My Team{" "}
                <span className="ml-1 text-xs font-normal text-slate-500 dark:text-white/60">
                  ({team.scopeLabel} · {team.memberCount} people)
                </span>
              </h2>
              <Link to="/app/org-chart" className="text-xs font-semibold text-[#00C875] hover:underline">
                Org chart →
              </Link>
            </div>
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-[#E6E9F0] bg-[#F5F7FB] p-3 text-center dark:border-white/10 dark:bg-white/5">
                <p className="text-xl font-extrabold text-emerald-600">{team.today.present}</p>
                <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-white/60">Present today</p>
              </div>
              <div className="rounded-xl border border-[#E6E9F0] bg-[#F5F7FB] p-3 text-center dark:border-white/10 dark:bg-white/5">
                <p className="text-xl font-extrabold text-red-500">{team.today.absent}</p>
                <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-white/60">Absent</p>
              </div>
              <div className="rounded-xl border border-[#E6E9F0] bg-[#F5F7FB] p-3 text-center dark:border-white/10 dark:bg-white/5">
                <p className="text-xl font-extrabold text-amber-500">{team.pendingLeaves}</p>
                <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-white/60">Leave approvals</p>
              </div>
              <div className="rounded-xl border border-[#E6E9F0] bg-[#F5F7FB] p-3 text-center dark:border-white/10 dark:bg-white/5">
                <p className="text-xl font-extrabold text-slate-800 dark:text-white">
                  {team.tasks.open}
                  {team.tasks.overdue > 0 && <span className="ml-1 text-xs font-bold text-red-500">({team.tasks.overdue} overdue)</span>}
                </p>
                <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-white/60">Open tasks</p>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {team.members.slice(0, 8).map((m) => (
                <div key={m._id} className="flex items-center gap-3 rounded-xl border border-[#E6E9F0] bg-[#F5F7FB] px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
                  {m.avatarUrl ? (
                    <img src={m.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#00C875]/15 text-xs font-bold text-[#00C875]">
                      {m.name?.[0]?.toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800 dark:text-white">{m.name}</p>
                    <p className="truncate text-[11px] text-slate-500 dark:text-white/60">
                      {m.role?.replace("_", " ")}
                      {m.department ? ` · ${m.department}` : ""}
                    </p>
                  </div>
                  {m.today ? (
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${TODAY_STYLE[m.today] || ""}`}>{m.today.replace("_", " ")}</span>
                  ) : (
                    <span className="inline-flex rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-500 dark:bg-white/10 dark:text-white/60">not marked</span>
                  )}
                </div>
              ))}
            </div>
            {team.members.length > 8 && <p className="mt-2 text-center text-xs text-slate-500">+{team.members.length - 8} more — see User Management</p>}
          </section>
        )}

        {/* panels */}
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel
            icon={<ClipboardList className="h-4 w-4" />}
            title={`Pending Tasks (${data?.pendingTasks?.count || 0})`}
            action={
              <Link to="/app/tasks" className="text-xs font-semibold text-[#00C875] hover:underline">
                My Tasks →
              </Link>
            }
          >
            {data?.pendingTasks?.items?.length ? (
              <ul className="space-y-2">
                {data.pendingTasks.items.map((t) => (
                  <li key={t._id} className="flex items-center justify-between gap-2 rounded-xl border border-[#E6E9F0] bg-[#F5F7FB] px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5">
                    <span className="truncate text-slate-700 dark:text-white/80">{t.title}</span>
                    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${t.priority === "HIGH" ? "bg-red-500/15 text-red-500" : "bg-amber-500/15 text-amber-600"}`}>
                      {t.status?.replace("_", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-8 text-center text-sm text-slate-400">All clear — no pending tasks</p>
            )}
          </Panel>

          <Panel
            icon={<CalendarDays className="h-4 w-4" />}
            title="Upcoming Meetings"
            action={
              <Link to="/app/meetings" className="text-xs font-semibold text-[#00C875] hover:underline">
                All meetings →
              </Link>
            }
          >
            {data?.upcomingMeetings?.length ? (
              <ul className="space-y-2">
                {data.upcomingMeetings.map((m) => (
                  <li key={m._id} className="flex items-center justify-between gap-2 rounded-xl border border-[#E6E9F0] bg-[#F5F7FB] px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5">
                    <span className="truncate text-slate-700 dark:text-white/80">{m.title}</span>
                    <span className="shrink-0 text-xs text-slate-500 dark:text-white/60">
                      {fmtMeetDay(m)} · {fmtMeetTime(m)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-8 text-center text-sm text-slate-400">No meetings scheduled — enjoy the focus time</p>
            )}
          </Panel>

          <Panel
            icon={<ReceiptText className="h-4 w-4" />}
            title="Latest Payslip"
            action={
              <Link to="/app/payslips" className="text-xs font-semibold text-[#00C875] hover:underline">
                My Payslips →
              </Link>
            }
          >
            {data?.latestPayslip ? (
              <div className="flex items-center justify-between rounded-xl border border-[#E6E9F0] bg-[#F5F7FB] px-4 py-4 dark:border-white/10 dark:bg-white/5">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-white/60">{monthLabel(data.latestPayslip.month)}</p>
                  <p className="text-2xl font-extrabold text-[#00C875]">{money(data.latestPayslip.netPay)}</p>
                </div>
                <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${data.latestPayslip.status === "PAID" ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}>
                  {data.latestPayslip.status}
                </span>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-slate-400">No payslip yet — payroll runs monthly</p>
            )}
          </Panel>

          <Panel
            icon={<Megaphone className="h-4 w-4" />}
            title="Announcements"
            action={
              <Link to="/app/announcements" className="text-xs font-semibold text-[#00C875] hover:underline">
                All →
              </Link>
            }
          >
            {data?.announcements?.length ? (
              <ul className="space-y-2">
                {data.announcements.map((ann) => (
                  <li key={ann._id} className="rounded-xl border border-[#E6E9F0] bg-[#F5F7FB] px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
                    <p className="text-sm font-semibold text-slate-800 dark:text-white">
                      {ann.pinned && <Pin className="mr-1 inline h-3 w-3 text-amber-500" />}
                      {ann.title}
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-white/60">
                      {ann.postedBy?.name || "HR"} · {new Date(ann.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-8 text-center text-sm text-slate-400">Quiet day — no announcements</p>
            )}
          </Panel>
        </div>

        <p className="mt-6 text-center text-[11px] text-slate-400 dark:text-white/30">Crewly · Figma HRDashboard — Dashboard parity · data live via API</p>
      </div>
    </div>
  );
}
