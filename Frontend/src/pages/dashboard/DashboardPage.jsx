// ============================================================
// DASHBOARD — self widgets for everyone + My Team panel
// for MANAGER / TEAM_LEAD / COMPANY_ADMIN / HR_MANAGER (Phase 10)
// ============================================================
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  LayoutDashboard,
  Megaphone,
  Palmtree,
  Pin,
  ReceiptText,
  Timer,
  Users,
  XCircle,
} from "lucide-react";
import { useDispatch, useSelector } from "react-redux";
import { dashboardService } from "../../services/selfService";
import attendanceWeeklyTargetService from "../../services/attendanceWeeklyTargetService.js";
import useAuth from "../../hooks/useAuth";
import { notify } from '../../utils/notify.js';
import PresenceIndicator from "../../components/presence/PresenceIndicator.jsx";
import { fetchTeamAvailability } from "../../redux/slices/presenceSlice.js";
import EmptyState from '../../components/common/EmptyState.jsx';
import BarChart from '../../components/charts/BarChart.jsx';
import DonutChart, { DonutLegend } from '../../components/charts/DonutChart.jsx';
import RingGauge from '../../components/charts/RingGauge.jsx';
import { StackedBar, SplitRow } from '../../components/charts/StackedBar.jsx';

// 37.4 — work-location chip for the dashboard My Team tile.
// Reads the presence slice's `team.items` (loaded by the team page)
// and falls back to "—" when no row is present for the member.
// The chip is intentionally small — green/amber/sky for the three
// allowed values, gray for unknown. Phase 37.1's resolver sends
// workLocation through, so the slice already has it.
const WORK_LOCATION_STYLE = {
  office: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
  wfh: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  remote: 'border-sky-500/30 bg-sky-500/10 text-sky-600',
};
const WORK_LOCATION_LABEL = {
  office: 'Office',
  wfh: 'WFH',
  remote: 'Remote',
};

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
  PRESENT: "bg-crewly-green/15 text-crewly-green",
  LATE: "bg-crewly-orange/15 text-crewly-orange",
  HALF_DAY: "bg-blue-500/15 text-blue-400",
  ABSENT: "bg-crewly-red/15 text-crewly-red",
};

const StatCard = ({ icon, label, value, sub, accent = "text-crewly-text", to }) => {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-crewly-dim">{icon}</span>
      <span className={`text-2xl font-extrabold ${accent}`}>{value}</span>
    </div>
      <p className="mt-1 text-xs uppercase tracking-wide text-crewly-dim">
        {label}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-crewly-dim">{sub}</p>}
    </>
  );
  if (to) {
    return (
      <Link
        to={to}
        className="card transition hover:border-crewly-green/50 hover:shadow-lg"
      >
        {body}
      </Link>
    );
  }
  return <div className="card">{body}</div>;
};

const Panel = ({ icon, title, action, children }) => (
  <section className="card flex min-h-44 flex-col">
    <div className="mb-3 flex items-center justify-between">
      <h3 className="flex items-center gap-2 font-semibold">
        {icon && <span className="text-crewly-dim">{icon}</span>}
        {title}
      </h3>
      {action}
    </div>
    <div className="flex-1">{children}</div>
  </section>
);

const DashboardPage = () => {
  // Meeting date/time that survives BOTH old (date/startTime) and new (startAt) field shapes
  const fmtMeetDay = (m) => {
    const raw = m.date || m.occStart || m.startAt;
    if (!raw) return "—";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return String(raw).slice(5).split("-").reverse().join("/"); // old "YYYY-MM-DD" strings
    }
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const fmtMeetTime = (m) => {
    if (m.startTime) return m.startTime; // old string field
    const raw = m.occStart || m.startAt;
    return raw
      ? new Date(raw).toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
  };

  const { user } = useAuth();
  const isSenior = SENIORS.includes(user?.role);

  // 37.4 — pull the team presence rows out of redux so the My Team
  // tile can show a green/red dot + work-location chip per row,
  // without making a second API call (the slice maintains this from
  // the team page; the dashboard's own manager-overview call still
  // owns attendance). 37.1's `unknown` sentinel stays as a gray dot
  // so a missing row is rendered as "not marked" — not silently
  // bumped to available.
  const dispatch = useDispatch();
  const presenceTeamItems = useSelector(
    (state) => state.presence?.team?.items || [],
  );
  const presenceById = new Map(
    presenceTeamItems.map((p) => [String(p.id), p]),
  );

  const [data, setData] = useState(null);
  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(true);
  // Weekly-hours flexi target — running Mon→Sun context for the chip.
  // Silent on failure: the chip is additive, the card works without it
  // (policy disabled → the endpoint still answers with enabled:false,
  // but a network error must never disturb the dashboard).
  const [weekTarget, setWeekTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    /* 35.1 — nothing to report (failure state cleared) */
    try {
      const calls = [dashboardService.employeeOverview()];
      if (isSenior) calls.push(dashboardService.managerOverview());
      const [self, teamRes] = await Promise.all(calls);
      setData(self?.data || self);
      if (teamRes) setTeam(teamRes?.data || teamRes);
    } catch (err) {
      notify.error(errMsg(err, "Failed to load dashboard"));
    } finally {
      setLoading(false);
    }
  }, [isSenior]);

  useEffect(() => {
    load();
  }, [load]);

  // Weekly-hours flexi policy chip — one small read; silent on failure.
  useEffect(() => {
    attendanceWeeklyTargetService
      .weeklyTarget()
      .then((res) => setWeekTarget(res?.data || null))
      .catch(() => setWeekTarget(null));
  }, []);

  // 37.4 — load the team presence rows so the My Team tile can show
  // a presence dot + work-location chip per row. The slice maintains
  // this in state.presence.team; the team page does the same. This
  // is a separate, small request (paginated, pageSize=50) and does
  // NOT block the manager-overview render. Errors are silent — the
  // tile falls back to the "not marked" badge if the team fetch
  // fails, which preserves the existing 34.x behaviour.
  //
  // Run once on mount. Empty deps so a parent re-render or a
  // team-data change does NOT re-fire this. The slice keeps the
  // data fresh via the realtime runtime; a manual refresh comes
  // from navigating away and back.
  useEffect(() => {
    if (!isSenior) return;
    dispatch(
      fetchTeamAvailability({ page: 1, pageSize: 50, scope: 'company' }),
    ).catch(() => {
      // Intentionally silent. The team tile already renders the
      // attendance "not marked" badge; presence is additive.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, isSenior]);

  if (loading && !data)
    return <p className="text-crewly-dim">Loading your dashboard…</p>;

  const a = data?.attendance || {};
  const balances = data?.leaveBalance || [];
  const totalRemaining = balances.reduce((s, b) => s + b.remaining, 0);
  const today = data?.today;

  // ── charts: every figure below comes straight from the overview payload ──
  // Attendance is counted in days: `present` excludes late arrivals (the API
  // reports them separately) and `absent` is "working day elapsed with no
  // record", so the four slices add up to the working days of the month.
  const attendanceSegments = [
    { label: 'Present', value: a.present || 0, color: '#3fb950' },
    { label: 'Late', value: a.late || 0, color: '#f0a35e' },
    { label: 'Half day', value: a.halfDay || 0, color: '#58a6ff' },
    { label: 'Absent', value: a.absent || 0, color: '#f85149' },
  ].filter((segment) => segment.value > 0);
  const attendanceTotal = attendanceSegments.reduce((sum, segment) => sum + segment.value, 0);
  const attendancePct = attendanceTotal
    ? Math.round((((a.present || 0) + (a.late || 0) + (a.halfDay || 0)) / attendanceTotal) * 100)
    : 0;

  // Leave bars keep a colour per leave type so the eye can follow one quota
  // across months; the four tones are the app's own chart palette.
  const LEAVE_COLORS = ['#a371f7', '#58a6ff', '#3fb950', '#f0a35e', '#f778ba', '#39c5cf'];
  const leaveRows = balances
    .filter((balance) => (balance.total || 0) > 0)
    .map((balance, index) => ({
      ...balance,
      label: String(balance.type || '')
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^./, (char) => char.toUpperCase()),
      color: LEAVE_COLORS[index % LEAVE_COLORS.length],
    }));

  // Bar chart units are people: each member row already carries today's status
  // (or null when they have not marked), so the four bars are a real headcount.
  const teamStatusBars = [
    { label: 'Present', value: 0, color: '#3fb950' },
    { label: 'Late', value: 0, color: '#f0a35e' },
    { label: 'Half day', value: 0, color: '#58a6ff' },
    { label: 'Not marked', value: 0, color: 'rgba(139,148,158,0.55)' },
  ];
  (team?.members || []).forEach((member) => {
    const status = String(member.today || '').toUpperCase();
    if (status === 'PRESENT') teamStatusBars[0].value += 1;
    else if (status === 'LATE') teamStatusBars[1].value += 1;
    else if (status === 'HALF_DAY') teamStatusBars[2].value += 1;
    else teamStatusBars[3].value += 1;
  });

  const teamPresent = team?.today?.present || 0;
  const teamAbsent = team?.today?.absent || 0;
  const teamTotal = Math.max(0, Number(team?.memberCount) || 0);
  const teamSegments = [
    { label: 'Present', value: teamPresent, color: '#3fb950' },
    { label: 'Not marked', value: teamAbsent, color: 'rgba(139,148,158,0.45)' },
  ].filter((segment) => segment.value > 0);
  const hasTeamChart = Boolean(isSenior && team && teamTotal > 0);


  return (
    <div>
      <div className="mb-1 flex items-end justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <LayoutDashboard className="h-6 w-6 text-crewly-green" />
          My Dashboard
        </h1>
        <span className="text-xs text-crewly-dim">
          {monthLabel(data?.month)}
        </span>
      </div>
      <p className="mb-5 text-sm text-crewly-dim">
        Everything about you{isSenior ? " — and your people" : ""}, at a glance.
      </p>

      {/* ── Attendance Quick Action (Phase 31 — one-tap CTA) ── */}
      <div className="card mb-5 border-crewly-green/30 bg-gradient-to-br from-crewly-green/10 via-crewly-card to-crewly-card">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-crewly-green/15 ring-1 ring-crewly-green/20">
              <Timer className="h-6 w-6 text-crewly-green" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold sm:text-lg">
                Attendance
              </h2>
              <p className="text-xs text-crewly-dim sm:text-sm">
                {today ? (
                  <>
                    Checked in at{" "}
                    <span className="font-semibold text-crewly-text">
                      {today.checkIn}
                    </span>{" "}
                    ·{" "}
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${TODAY_STYLE[today.status] || "bg-crewly-green/15 text-crewly-green"}`}
                    >
                      {today.status.replace("_", " ")}
                    </span>
                  </>
                ) : (
                  "You haven't marked attendance yet today"
                )}
              </p>
              <p className="mt-0.5 hidden text-[11px] text-crewly-dim sm:block">
                Tap below to clock in / out, start break & view today&apos;s timeline.
              </p>
            </div>
          </div>
          <Link
            to="/app/attendance"
            className="btn-primary w-full shrink-0 justify-center px-6 py-3 text-sm font-bold sm:w-auto sm:text-[15px]"
          >
            {today ? "Go to Attendance →" : "Mark Attendance →"}
          </Link>
        </div>
        {weekTarget?.enabled ? (
          <div className="mt-4 flex flex-col items-center gap-4 border-t border-crewly-hairline-strong pt-4 sm:flex-row sm:items-center">
            {(() => {
              const done = Math.max(0, Number(weekTarget.achievedMinutes) || 0);
              const goal = Math.max(1, Number(weekTarget.targetMinutes) || 1);
              const pct = Math.min(100, Math.round((done / goal) * 100));
              const h = (m) => (Math.round((m / 60) * 10) / 10).toString();
              return (
                <>
                  <RingGauge
                    value={done}
                    max={goal}
                    size={104}
                    thickness={9}
                    color={weekTarget.qualified ? "#3fb950" : "#58a6ff"}
                    centerValue={`${pct}%`}
                    centerLabel="of the week"
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex items-center justify-between text-[11px]">
                      <span className="text-crewly-dim">
                        Weekly hours goal{weekTarget.qualified ? " — met" : ""}
                      </span>
                      <span className="font-semibold text-crewly-text">
                        {h(done)}h / {h(goal)}h
                      </span>
                    </div>
                    <StackedBar
                      height={6}
                      parts={[
                        { label: "Achieved", value: done, color: weekTarget.qualified ? "#3fb950" : "#58a6ff" },
                        { label: "Still to go", value: Math.max(0, goal - done), color: "rgba(139,148,158,0.28)" },
                      ]}
                    />
                    <p className="mt-1.5 text-[11px] leading-snug text-crewly-dim">
                      {weekTarget.qualified
                        ? "Remaining working days this week are earned rest — paid, no leave deducted. Punch in any day you feel like working."
                        : `${h(goal - done)}h more this week unlocks paid earned rest for the remaining working days.`}
                    </p>
                  </div>
                </>
              );
            })()}
          </div>
        ) : null}
      </div>


      {/* ── MY TEAM panel (Phase 10 — seniors only) ── */}
      {isSenior && team && (
        <section className="card mb-5 border-crewly-green/30">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold">
              <Users className="h-4 w-4 text-crewly-green" />
              My Team{" "}
              <span className="ml-1 text-xs font-normal text-crewly-dim">
                ({team.scopeLabel} · {team.memberCount} people)
              </span>
            </h2>
            <Link
              to="/app/org-chart"
              className="text-xs text-crewly-green hover:underline"
            >
              Org chart →
            </Link>
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-crewly-bg p-3 text-center">
              <p className="text-xl font-extrabold text-crewly-green">
                {team.today.present}
              </p>
              <p className="text-[11px] uppercase text-crewly-dim">
                Present today
              </p>
            </div>
            <div className="rounded-lg bg-crewly-bg p-3 text-center">
              <p className="text-xl font-extrabold text-crewly-red">
                {team.today.absent}
              </p>
              <p className="text-[11px] uppercase text-crewly-dim">Absent</p>
            </div>
            <div className="rounded-lg bg-crewly-bg p-3 text-center">
              <p className="text-xl font-extrabold text-crewly-orange">
                {team.pendingLeaves}
              </p>
              <p className="text-[11px] uppercase text-crewly-dim">
                Leave approvals
              </p>
            </div>
            <div className="rounded-lg bg-crewly-bg p-3 text-center">
              <p className="text-xl font-extrabold text-crewly-text">
                {team.tasks.open}
                {team.tasks.overdue > 0 && (
                  <span className="ml-1 text-xs font-bold text-crewly-red">
                    ({team.tasks.overdue} overdue)
                  </span>
                )}
              </p>
              <p className="text-[11px] uppercase text-crewly-dim">
                Open tasks
              </p>
            </div>
          </div>

          {team.memberCount ? (
            <div className="mb-4 rounded-lg bg-crewly-bg px-4 pb-3 pt-4">
              <BarChart bars={teamStatusBars} height={96} />
              <p className="mt-2 text-[11px] text-crewly-dim">
                {team.today.present} of {team.memberCount} marked attendance today
                {" · "}
                {Math.round((team.today.present / team.memberCount) * 100)}%
              </p>
            </div>
          ) : null}

          {team.members.length === 0 ? (
            <EmptyState
              illustration="team"
              title="No one in your scope yet"
              description="When people report to you, or join your department, they appear here with today's attendance and presence."
              size="sm"
            />
          ) : null}

          <div className="grid gap-2 md:grid-cols-2">
            {team.members.slice(0, 8).map((m) => {
              // 37.4 — overlay presence on top of the existing
              // attendance badge. The manager-overview's `team.members`
              // carries attendance, NOT presence; we look up presence
              // from the presence slice's team cache by user id. A
              // missing row is rendered with a gray "—" chip, which is
              // visually distinct from the existing red/green
              // attendance badges so the operator can tell the two
              // signals apart.
              const presenceRow = presenceById.get(String(m._id));
              const presenceValue = presenceRow?.presence || 'unknown';
              const workLocation = presenceRow?.workLocation || null;
              return (
                <div
                  key={m._id}
                  className="flex items-center gap-3 rounded-lg bg-crewly-bg px-3 py-2"
                >
                  {m.avatarUrl ? (
                    <img
                      src={m.avatarUrl}
                      alt=""
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-crewly-green/15 text-xs font-bold text-crewly-green">
                      {m.name?.[0]?.toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="truncate text-[11px] text-crewly-dim">
                      {m.role?.replace("_", " ")}
                      {m.department ? ` · ${m.department}` : ""}
                    </p>
                  </div>
                  {/* 37.4 — presence + work-location chips. The dot is
                      the 37.2 visual dictionary; the work-location
                      chip is the same green/amber/sky used on the
                      team page so the two screens agree. */}
                  <PresenceIndicator
                    presence={presenceValue}
                    size="xs"
                    showLabel={false}
                    className="shrink-0"
                  />
                  {workLocation ? (
                    <span
                      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                        WORK_LOCATION_STYLE[workLocation] ||
                        'border-slate-500/30 bg-slate-500/10 text-slate-500'
                      }`}
                    >
                      {WORK_LOCATION_LABEL[workLocation] || workLocation}
                    </span>
                  ) : null}
                  {m.today ? (
                    <span className={`badge ${TODAY_STYLE[m.today] || ""}`}>
                      {m.today.replace("_", " ")}
                    </span>
                  ) : (
                    <span className="badge bg-gray-500/15 text-gray-500">
                      not marked
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {team.members.length > 8 && (
            <p className="mt-2 text-center text-xs text-crewly-dim">
              +{team.members.length - 8} more — see User Management
            </p>
          )}
        </section>
      )}

      {/* ── self stat cards ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<CheckCircle2 className="h-5 w-5 text-crewly-green" />}
          label={`Present · ${monthLabel(data?.month)}`}
          value={(a.present || 0) + (a.late || 0)}
          sub={a.late ? `incl. ${a.late} late` : "on time streak!"}
          accent="text-crewly-green"
        />
        <StatCard
          icon={<XCircle className="h-5 w-5 text-crewly-red" />}
          label="Absent days"
          value={a.absent || 0}
          sub={a.halfDay ? `${a.halfDay} half-day(s)` : ""}
          accent={a.absent ? "text-crewly-red" : "text-crewly-text"}
        />
        <StatCard
          icon={<Palmtree className="h-5 w-5 text-crewly-orange" />}
          label="Leave balance"
          value={totalRemaining}
          sub={balances
            .map((b) => `${b.type.toLowerCase()} ${b.remaining}/${b.total}`)
            .join(" · ")}
          accent="text-crewly-orange"
        />
        <StatCard
          to="/app/attendance"
          icon={<Timer className="h-5 w-5 text-crewly-green" />}
          label="Today's attendance"
          value={today ? today.status?.replace("_", " ") : "Not marked"}
          sub={
            today?.checkIn
              ? `checked in ${today.checkIn}`
              : "tap here to mark attendance"
          }
          accent={
            today
              ? today.status === "LATE"
                ? "text-crewly-orange"
                : "text-crewly-green"
              : "text-crewly-dim"
          }
        />
      </div>

      {/* ── charts: the same month, as shapes ──
          Every slice is a figure the API already returns — no projections,
          no smoothing, no invented history. A month with nothing marked draws
          no ring at all; the card says so instead. */}
      <div
        className={`mt-5 grid gap-4 md:grid-cols-2 ${hasTeamChart ? 'xl:grid-cols-3' : ''}`}
      >
        <Panel
          icon={<CalendarDays className="h-4 w-4" />}
          title="Attendance this month"
          action={
            attendanceTotal ? (
              <span className="badge bg-crewly-green/15 text-crewly-green">
                {attendancePct}% attended
              </span>
            ) : null
          }
        >
          {attendanceSegments.length ? (
            <div className="flex flex-wrap items-center justify-center gap-4 sm:flex-nowrap sm:justify-start">
              <DonutChart
                segments={attendanceSegments}
                centerValue={a.marked || 0}
                centerLabel="days marked"
                size={136}
                thickness={15}
                ariaLabel={`Attendance: ${attendanceSegments
                  .map((segment) => `${segment.label} ${segment.value} days`)
                  .join(', ')}`}
              />
              <DonutLegend
                segments={attendanceSegments}
                formatter={(value) => `${value}d`}
              />
            </div>
          ) : (
            <EmptyState
              illustration="calendar"
              title="No attendance this month"
              description="Mark attendance from the card above — each day you punch in is counted here by status."
              size="sm"
            />
          )}
        </Panel>

        <Panel
          icon={<Palmtree className="h-4 w-4" />}
          title="Leave balance"
          action={
            <Link
              to="/app/leaves"
              className="text-xs text-crewly-green hover:underline"
            >
              Request leave →
            </Link>
          }
        >
          {leaveRows.length ? (
            <ul className="space-y-3">
              {leaveRows.map((row) => (
                <SplitRow
                  key={row.type}
                  label={row.label}
                  used={row.used}
                  total={row.total}
                  colors={[row.color, `${row.color}2e`]}
                />
              ))}
            </ul>
          ) : (
            <EmptyState
              illustration="calendar"
              title="No leave types configured"
              description="Your company's leave policy fills this in. Each quota then shows how much is used and how much is left."
              size="sm"
            />
          )}
        </Panel>

        {hasTeamChart ? (
          <Panel
            icon={<Users className="h-4 w-4" />}
            title="Your team today"
            action={
              <Link
                to="/app/team/availability"
                className="text-xs text-crewly-green hover:underline"
              >
                Availability →
              </Link>
            }
          >
            <div className="flex flex-wrap items-center justify-center gap-4 sm:flex-nowrap sm:justify-start">
              <DonutChart
                segments={teamSegments}
                centerValue={`${teamPresent}/${teamTotal}`}
                centerLabel="present"
                size={136}
                thickness={15}
                ariaLabel={`${teamPresent} of ${teamTotal} people have marked attendance today`}
              />
              <div className="min-w-0 flex-1 space-y-3">
                <DonutLegend
                  segments={teamSegments}
                  formatter={(value) => `${value}`}
                />
                <p className="text-[11px] leading-snug text-crewly-dim">
                  {teamAbsent > 0
                    ? `${teamAbsent} ${teamAbsent === 1 ? 'person has' : 'people have'} not marked attendance yet today.`
                    : 'Everyone in your scope has marked attendance today.'}
                </p>
              </div>
            </div>
          </Panel>
        ) : null}
      </div>

      {/* ── self panels ── */}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Panel
          icon={<ClipboardList className="h-4 w-4" />}
          title={`Pending Tasks (${data?.pendingTasks?.count || 0})`}
          action={
            <Link
              to="/app/tasks"
              className="text-xs text-crewly-green hover:underline"
            >
              My Tasks →
            </Link>
          }
        >
          {data?.pendingTasks?.items?.length ? (
            <ul className="space-y-2">
              {data.pendingTasks.items.map((t) => (
                <li
                  key={t._id}
                  className="flex items-center justify-between gap-2 rounded-lg bg-crewly-bg px-3 py-2 text-sm"
                >
                  <span className="truncate">{t.title}</span>
                  <span
                    className={`badge shrink-0 ${t.priority === "HIGH" ? "bg-crewly-red/15 text-crewly-red" : "bg-crewly-orange/15 text-crewly-orange"}`}
                  >
                    {t.status?.replace("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              illustration="tasks"
              title="All clear — no pending tasks"
              description="Nothing is assigned to you right now. New tasks land here with their priority and due date."
              size="sm"
            />
          )}
        </Panel>

        <Panel
          icon={<CalendarDays className="h-4 w-4" />}
          title="Upcoming Meetings"
          action={
            <Link
              to="/app/meetings"
              className="text-xs text-crewly-green hover:underline"
            >
              All meetings →
            </Link>
          }
        >
          {data?.upcomingMeetings?.length ? (
            <ul className="space-y-2">
              {data.upcomingMeetings.map((m) => (
                <li
                  key={m._id}
                  className="flex items-center justify-between gap-2 rounded-lg bg-crewly-bg px-3 py-2 text-sm"
                >
                  <span className="truncate">{m.title}</span>
                  <span className="shrink-0 text-xs text-crewly-dim">
                    {fmtMeetDay(m)} · {fmtMeetTime(m)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              illustration="calendar"
              title="No meetings scheduled"
              description="Nothing on your calendar for the next few days. Meetings you are invited to show up here with their time."
              size="sm"
            />
          )}
        </Panel>

        <Panel
          icon={<ReceiptText className="h-4 w-4" />}
          title="Latest Payslip"
          action={
            <Link
              to="/app/payslips"
              className="text-xs text-crewly-green hover:underline"
            >
              My Payslips →
            </Link>
          }
        >
          {data?.latestPayslip ? (
            <div className="flex items-center justify-between rounded-lg bg-crewly-bg px-4 py-4">
              <div>
                <p className="text-sm text-crewly-dim">
                  {monthLabel(data.latestPayslip.month)}
                </p>
                <p className="text-2xl font-extrabold text-crewly-green">
                  {money(data.latestPayslip.netPay)}
                </p>
              </div>
              <span
                className={`badge ${data.latestPayslip.status === "PAID" ? "bg-crewly-green/15 text-crewly-green" : "bg-crewly-orange/15 text-crewly-orange"}`}
              >
                {data.latestPayslip.status}
              </span>
            </div>
          ) : (
            <EmptyState
              illustration="payslip"
              title="No payslip yet"
              description="Payroll runs once a month. Your latest payslip and its net pay appear here after the run is approved."
              size="sm"
            />
          )}
        </Panel>

        <Panel
          icon={<Megaphone className="h-4 w-4" />}
          title="Announcements"
          action={
            <Link
              to="/app/announcements"
              className="text-xs text-crewly-green hover:underline"
            >
              All →
            </Link>
          }
        >
          {data?.announcements?.length ? (
            <ul className="space-y-2">
              {data.announcements.map((ann) => (
                <li key={ann._id} className="rounded-lg bg-crewly-bg px-3 py-2">
                  <p className="text-sm font-medium">
                    {ann.pinned && <Pin className="mr-1 inline h-3 w-3 text-crewly-orange" />}
                    {ann.title}
                  </p>
                  <p className="text-[11px] text-crewly-dim">
                    {ann.postedBy?.name || "HR"} ·{" "}
                    {new Date(ann.createdAt).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                    })}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              illustration="bell"
              title="No announcements yet"
              description="Company news from HR and pinned notices appear here as they are posted."
              size="sm"
            />
          )}
        </Panel>
      </div>
    </div>
  );
};

export default DashboardPage;
