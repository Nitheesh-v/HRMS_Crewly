// Analytics Hub — role-aware analytics:
// SUPER_ADMIN → Platform
// Admin/HR → Company analytics
// Manager/TL → Team-scoped analytics
// Employee → My Stats

import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { Link } from "react-router-dom";
import analyticsService from "../../services/analyticsService";

const panel = "rounded-xl border border-slate-700 bg-slate-900 p-4";
const sel =
  "rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100";

const money = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 0,
  })}`;

const PRESETS = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["this_week", "This week"],
  ["this_month", "This month"],
  ["prev_month", "Prev month"],
  ["this_quarter", "This quarter"],
  ["prev_quarter", "Prev quarter"],
  ["this_year", "This year"],
  ["prev_year", "Prev year"],
];

const KPI = ({ icon, label, value, sub, tone = "text-slate-100" }) => (
  <div className={panel}>
    <div className="text-xs text-slate-400">
      {icon} {label}
    </div>
    <div className={`mt-1 text-2xl font-bold ${tone}`}>{value ?? "—"}</div>
    {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
  </div>
);

const Bars = ({
  data = [],
  labelKey,
  valueKey,
  color = "#6366f1",
  height = 140,
}) => {
  if (!data.length) {
    return <p className="text-xs text-slate-500">No data in this range.</p>;
  }

  const values = data.map((item) => Number(item?.[valueKey] || 0));
  const max = Math.max(1, ...values);

  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {data.map((item, index) => {
        const label = item?.[labelKey] ?? "";
        const value = Number(item?.[valueKey] || 0);

        return (
          <div
            key={`${label}-${index}`}
            className="flex flex-1 flex-col items-center justify-end gap-1"
            title={`${label}: ${value}`}
          >
            <span className="text-[9px] text-slate-400">{value}</span>
            <div
              className="w-full rounded-t"
              style={{
                height: Math.max(2, (value / max) * (height - 34)),
                background: color,
              }}
            />
            <span className="w-full truncate text-center text-[9px] text-slate-500">
              {String(label).slice(0, 8)}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const Trend = ({
  data = [],
  labelKey,
  valueKey,
  color = "#34d399",
  height = 140,
}) => {
  if (!data.length) {
    return <p className="text-xs text-slate-500">No data in this range.</p>;
  }

  const values = data.map((item) => Number(item?.[valueKey] || 0));
  const max = Math.max(1, ...values);
  const stepX = 100 / Math.max(1, data.length - 1);

  const points = data
    .map((item, index) => {
      const value = Number(item?.[valueKey] || 0);
      return `${index * stepX},${100 - (value / max) * 90}`;
    })
    .join(" ");

  return (
    <div>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ height, width: "100%" }}
      >
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="flex justify-between text-[9px] text-slate-500">
        <span>{data[0]?.[labelKey] ?? ""}</span>
        <span>{data[data.length - 1]?.[labelKey] ?? ""}</span>
      </div>
    </div>
  );
};

const Donut = ({ parts = [], size = 130 }) => {
  const colors = [
    "#6366f1",
    "#34d399",
    "#f59e0b",
    "#f472b6",
    "#38bdf8",
    "#a78bfa",
    "#fb7185",
  ];

  const rawTotal = parts.reduce(
    (sum, part) => sum + Number(part?.value || 0),
    0,
  );

  const total = Math.max(1, rawTotal);
  const radius = 15.9;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox="0 0 42 42">
        <circle
          cx="21"
          cy="21"
          r={radius}
          fill="none"
          stroke="#1e293b"
          strokeWidth="6"
        />

        {parts.map((part, index) => {
          const value = Number(part?.value || 0);
          const fraction = value / total;
          const dasharray = `${fraction * circumference} ${circumference}`;

          const previousTotal = parts
            .slice(0, index)
            .reduce(
              (sum, previousPart) => sum + Number(previousPart?.value || 0),
              0,
            );

          const dashoffset = -(previousTotal / total) * circumference;

          return (
            <circle
              key={`${part?.label || "part"}-${index}`}
              cx="21"
              cy="21"
              r={radius}
              fill="none"
              stroke={colors[index % colors.length]}
              strokeWidth="6"
              strokeDasharray={dasharray}
              strokeDashoffset={dashoffset}
            />
          );
        })}

        <text
          x="21"
          y="23"
          textAnchor="middle"
          fill="#e2e8f0"
          fontSize="7"
          fontWeight="bold"
        >
          {rawTotal}
        </text>
      </svg>

      <div className="space-y-1 text-xs">
        {parts.map((part, index) => (
          <div
            key={`${part?.label || "legend"}-${index}`}
            className="flex items-center gap-2 text-slate-300"
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: colors[index % colors.length] }}
            />
            {part?.label || "Unknown"} <b>{Number(part?.value || 0)}</b>
          </div>
        ))}

        {!parts.length && (
          <span className="text-slate-500">No data in this range.</span>
        )}
      </div>
    </div>
  );
};

const AnalyticsHubPage = () => {
  const user = useSelector((state) => state.auth.user);
  const role = user?.role;

  const isSuperAdmin = role === "SUPER_ADMIN";
  const isHR = role === "COMPANY_ADMIN" || role === "HR_MANAGER";
  const isTeamRole = role === "MANAGER" || role === "TEAM_LEAD";
  const isSenior = isHR || isTeamRole;

  let tabs = [["my", "📊 My Stats"]];

  if (isSuperAdmin) {
    tabs = [["platform", "🏢 Platform"]];
  } else if (isHR) {
    tabs = [
      ["overview", "📊 Overview"],
      ["attendance", "🕒 Attendance"],
      ["leaves", "🌴 Leaves"],
      ["payroll", "💰 Payroll"],
      ["work", "✅ Work"],
      ["recruitment", "🧲 Hiring"],
    ];
  } else if (isTeamRole) {
    tabs = [
      ["overview", "📊 Team"],
      ["attendance", "🕒 Attendance"],
      ["leaves", "🌴 Leaves"],
      ["work", "✅ Work"],
    ];
  }

  const [tab, setTab] = useState(tabs[0][0]);
  const [preset, setPreset] = useState("this_month");
  const [data, setData] = useState(null);
  const [loadedTab, setLoadedTab] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError("");

      try {
        let result;

        if (tab === "overview") {
          result = await analyticsService.overview({ preset });
        } else if (tab === "attendance") {
          result = await analyticsService.attendance({ preset });
        } else if (tab === "leaves") {
          result = await analyticsService.leaves({ preset });
        } else if (tab === "payroll") {
          result = await analyticsService.payroll({ preset });
        } else if (tab === "work") {
          result = await analyticsService.work({ preset });
        } else if (tab === "recruitment") {
          result = await analyticsService.recruitment({ preset });
        } else if (tab === "platform") {
          result = await analyticsService.saas();
        } else {
          result = await analyticsService.my();
        }

        const requiredKeys = {
          overview: ["kpis"],
          attendance: ["counts"],
          leaves: ["counts"],
          payroll: ["totals"],
          work: ["tasks", "projects", "expenses", "performance"],
          recruitment: ["jobs"],
          platform: ["companies", "users", "revenue"],
          my: ["attendance", "tasks", "leaves"],
        };

        const missingKeys = (requiredKeys[tab] || []).filter(
          (key) => result?.[key] == null,
        );

        if (!result || typeof result !== "object" || missingKeys.length) {
          const details = missingKeys.length
            ? ` (missing: ${missingKeys.join(", ")})`
            : "";

          throw new Error(
            `Analytics ${tab} returned an unexpected response${details}.`,
          );
        }

        if (
          tab === "my" &&
          !["attendance", "tasks", "leaves"].every((key) =>
            Array.isArray(result[key]),
          )
        ) {
          throw new Error(
            "Analytics my stats returned an unexpected list format.",
          );
        }

        if (!cancelled) {
          setData(result);
          setLoadedTab(tab);
        }
      } catch (loadError) {
        if (!cancelled) {
          setData(null);
          setLoadedTab(null);
          setError(
            loadError?.response?.data?.message ||
              loadError?.message ||
              "Could not load analytics.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [tab, preset]);

  const hasCurrentData = loadedTab === tab && data !== null;
  const k = hasCurrentData ? data?.kpis : null;

  const changeTab = (nextTab) => {
    if (nextTab === tab) return;

    setData(null);
    setLoadedTab(null);
    setError("");
    setLoading(true);
    setTab(nextTab);
  };

  const changePreset = (event) => {
    setData(null);
    setLoadedTab(null);
    setError("");
    setLoading(true);
    setPreset(event.target.value);
  };

  return (
    <div className="space-y-5 p-6 text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">📊 Analytics</h1>
          <p className="text-sm text-slate-400">
            Server-side aggregated · RBAC-scoped · export-ready
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!isSuperAdmin && tab !== "my" && (
            <select className={sel} value={preset} onChange={changePreset}>
              {PRESETS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}

          {isSenior && (
            <Link
              to="/app/reports"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              📑 {isTeamRole ? "Team Reports" : "Report Builder"}
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => changeTab(value)}
            className={
              tab === value
                ? "rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
                : "rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {loading && (
        <p className="text-sm text-slate-400">Crunching numbers… ⚙️</p>
      )}

      {!loading && error && (
        <div className={`${panel} border-rose-800 text-sm text-rose-300`}>
          ⚠️ {error}
        </div>
      )}

      {/* COMPANY OVERVIEW OR TEAM OVERVIEW */}
      {!loading && tab === "overview" && hasCurrentData && k && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KPI
              icon="👥"
              label={isTeamRole ? "Team members" : "Headcount"}
              value={k.headcount}
              sub={`${(k.growth ?? 0) >= 0 ? "📈" : "📉"} ${
                k.growth ?? 0
              }% vs prev month`}
            />

            <KPI
              icon="✅"
              label="Active"
              value={k.active}
              tone="text-emerald-300"
            />

            <KPI
              icon="⏸"
              label="Inactive"
              value={k.inactive}
              tone="text-slate-400"
            />

            <KPI
              icon="✨"
              label={isTeamRole ? "New team members" : "New hires"}
              value={k.newHires}
              tone="text-indigo-300"
            />

            {isTeamRole ? (
              <>
                <KPI
                  icon="🌴"
                  label="Team pending leaves"
                  value={k.pendingLeaves}
                  tone="text-amber-300"
                />

                <KPI icon="📁" label="Team projects" value={k.activeProjects} />
              </>
            ) : (
              <>
                <KPI
                  icon="🚪"
                  label="Exits"
                  value={k.exits}
                  tone="text-rose-300"
                />

                <KPI
                  icon="📉"
                  label="Attrition"
                  value={`${k.attritionRate ?? 0}%`}
                  sub="exits ÷ avg headcount"
                  tone="text-amber-300"
                />
              </>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                📈 {isTeamRole ? "Team headcount trend" : "Headcount trend"} (12
                months)
              </h3>
              <Trend
                data={data.headcountTrend || []}
                labelKey="label"
                valueKey="headcount"
              />
            </div>

            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                🏬{" "}
                {isTeamRole
                  ? "Team department distribution"
                  : "Department strength"}
              </h3>
              <Bars
                data={data.byDepartment || []}
                labelKey="name"
                valueKey="count"
                color="#38bdf8"
              />
            </div>

            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                🎖 {isTeamRole ? "Team by designation" : "By designation"}
              </h3>
              <Bars
                data={data.byDesignation || []}
                labelKey="name"
                valueKey="count"
                color="#a78bfa"
              />
            </div>

            {isHR && (
              <div className="grid grid-cols-2 gap-3">
                <KPI icon="🏬" label="Departments" value={k.departments} />
                <KPI
                  icon="🌴"
                  label="Pending leaves"
                  value={k.pendingLeaves}
                  tone="text-amber-300"
                />
                <KPI icon="🧲" label="Open jobs" value={k.openJobs} />
                <KPI
                  icon="📁"
                  label="Active projects"
                  value={k.activeProjects}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ATTENDANCE */}
      {!loading && tab === "attendance" && hasCurrentData && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KPI
              icon="✅"
              label="Present"
              value={data.counts?.present ?? 0}
              tone="text-emerald-300"
            />
            <KPI
              icon="❌"
              label="Absent"
              value={data.counts?.absent ?? 0}
              tone="text-rose-300"
            />
            <KPI
              icon="⏰"
              label="Late"
              value={data.counts?.late ?? 0}
              tone="text-amber-300"
            />
            <KPI icon="🌗" label="Half-day" value={data.counts?.halfDay ?? 0} />
            <KPI icon="🌴" label="On leave" value={data.counts?.leave ?? 0} />
            <KPI
              icon="📊"
              label="Attendance"
              value={`${data.counts?.attendancePct ?? 0}%`}
              sub="present ÷ (present+absent)"
              tone="text-indigo-300"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                📅 Daily presents trend
              </h3>
              <Trend
                data={data.dailyTrend || []}
                labelKey="d"
                valueKey="present"
              />
            </div>

            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                🥧 Status mix
              </h3>
              <Donut
                parts={(data.byStatusRaw || []).map((status) => ({
                  label: status?._id || "UNKNOWN",
                  value: status?.count || 0,
                }))}
              />
            </div>
          </div>
        </div>
      )}

      {/* LEAVES */}
      {!loading && tab === "leaves" && hasCurrentData && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPI
              icon="🌴"
              label="Total requests"
              value={data.counts?.total ?? 0}
            />
            <KPI
              icon="✅"
              label="Approved"
              value={data.counts?.approved ?? 0}
              tone="text-emerald-300"
            />
            <KPI
              icon="⏳"
              label="Pending"
              value={data.counts?.pending ?? 0}
              tone="text-amber-300"
            />
            <KPI
              icon="❌"
              label="Rejected"
              value={data.counts?.rejected ?? 0}
              tone="text-rose-300"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                🌴 Days used by type
              </h3>
              <Bars
                data={data.byType || []}
                labelKey="type"
                valueKey="days"
                color="#34d399"
              />
            </div>

            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                📈 Monthly trend
              </h3>
              <Trend
                data={data.monthlyTrend || []}
                labelKey="label"
                valueKey="count"
                color="#f59e0b"
              />
            </div>

            {(data.topUsers || []).length > 0 && (
              <div className={panel}>
                <h3 className="mb-2 text-sm font-semibold text-slate-300">
                  🏖 Highest leave usage
                </h3>

                <div className="space-y-1 text-sm">
                  {data.topUsers.map((topUser, index) => (
                    <div
                      key={`${topUser?.name || "user"}-${index}`}
                      className="flex justify-between text-slate-300"
                    >
                      <span>{topUser?.name || "Unknown employee"}</span>
                      <b>{topUser?.days || 0} days</b>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PAYROLL — HR/ADMIN ONLY */}
      {!loading && tab === "payroll" && hasCurrentData && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPI
              icon="💰"
              label="Total net paid"
              value={money(data.totals?.net)}
              tone="text-emerald-300"
            />
            <KPI icon="🧾" label="Gross" value={money(data.totals?.gross)} />
            <KPI
              icon="➖"
              label="Deductions"
              value={money(data.totals?.deductions)}
              tone="text-rose-300"
            />
            <KPI icon="📄" label="Payslips" value={data.totals?.slips ?? 0} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                📈 Net payroll trend
              </h3>
              <Trend
                data={data.monthly || []}
                labelKey="label"
                valueKey="net"
              />
            </div>

            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                🏬 Cost by department
              </h3>
              <Bars
                data={(data.byDepartment || []).map((department) => ({
                  name: department?.name || "Unassigned",
                  net: department?.net || 0,
                }))}
                labelKey="name"
                valueKey="net"
                color="#f472b6"
              />
            </div>
          </div>
        </div>
      )}

      {/* WORK */}
      {!loading && tab === "work" && hasCurrentData && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KPI
              icon="✅"
              label={isTeamRole ? "Team tasks done" : "Tasks done"}
              value={`${data.tasks?.done ?? 0}/${data.tasks?.total ?? 0}`}
              sub={`${data.tasks?.completionPct ?? 0}% complete`}
              tone="text-emerald-300"
            />
            <KPI
              icon="🔥"
              label={isTeamRole ? "Team overdue" : "Overdue"}
              value={data.tasks?.overdue ?? 0}
              tone="text-rose-300"
            />
            <KPI
              icon="📁"
              label={isTeamRole ? "Team projects" : "Projects"}
              value={`${data.projects?.active ?? 0}/${
                data.projects?.total ?? 0
              }`}
              sub="active / total"
            />
            <KPI
              icon="⏰"
              label="Delayed projects"
              value={data.projects?.delayed ?? 0}
              tone="text-amber-300"
            />
            <KPI
              icon="💸"
              label={
                isTeamRole ? "Team approved expenses" : "Approved expenses"
              }
              value={money(data.expenses?.approvedTotal)}
            />
            <KPI
              icon="⭐"
              label={isTeamRole ? "Team avg rating" : "Avg rating"}
              value={data.performance?.avgRating || "—"}
              sub={`goals ${data.performance?.goalCompletion ?? 0}%`}
              tone="text-indigo-300"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                👤 Tasks per teammate
              </h3>
              <Bars
                data={(data.tasks?.byUser || []).map((member) => ({
                  name: member?.name || "Unknown",
                  total: member?.total || 0,
                }))}
                labelKey="name"
                valueKey="total"
                color="#38bdf8"
              />
            </div>

            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                🥧 Task status mix
              </h3>
              <Donut
                parts={(data.tasks?.byStatusRaw || []).map((status) => ({
                  label: status?._id || "UNKNOWN",
                  value: status?.count || 0,
                }))}
              />
            </div>
          </div>
        </div>
      )}

      {/* RECRUITMENT — HR/ADMIN ONLY */}
      {!loading && tab === "recruitment" && hasCurrentData && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KPI
              icon="🧲"
              label="Jobs"
              value={data.jobs?.total ?? 0}
              sub={`${data.jobs?.open ?? 0} open`}
            />

            {data.applications ? (
              <>
                <KPI
                  icon="📨"
                  label="Applications"
                  value={data.applications?.total ?? 0}
                />
                <KPI
                  icon="🔍"
                  label="Screening"
                  value={data.applications?.screening ?? 0}
                  sub={`${
                    data.applications?.rates?.appToScreening ?? 0
                  }% of apps`}
                />
                <KPI
                  icon="⭐"
                  label="Shortlisted"
                  value={data.applications?.shortlisted ?? 0}
                  sub={`${
                    data.applications?.rates?.screeningToShortlist ?? 0
                  }% of screened`}
                />
                <KPI
                  icon="🎤"
                  label="Interviews"
                  value={data.applications?.interview ?? 0}
                  sub={`${
                    data.applications?.rates?.interviewToOffer ?? 0
                  }% → offer`}
                />
                <KPI
                  icon="🤝"
                  label="Hires"
                  value={data.applications?.hires ?? 0}
                  sub={`${
                    data.applications?.rates?.offerAcceptance ?? 0
                  }% acceptance`}
                  tone="text-emerald-300"
                />
              </>
            ) : (
              <KPI
                icon="📨"
                label="Applications"
                value="—"
                sub="No application model is available"
              />
            )}
          </div>

          {data.applications?.bySource?.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className={panel}>
                <h3 className="mb-2 text-sm font-semibold text-slate-300">
                  🌐 Applications by source
                </h3>
                <Bars
                  data={data.applications.bySource}
                  labelKey="source"
                  valueKey="applications"
                  color="#f59e0b"
                />
              </div>

              <div className={panel}>
                <h3 className="mb-2 text-sm font-semibold text-slate-300">
                  🤝 Hires by source
                </h3>
                <Bars
                  data={data.applications.bySource}
                  labelKey="source"
                  valueKey="hires"
                  color="#34d399"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* SUPER ADMIN PLATFORM */}
      {!loading && tab === "platform" && hasCurrentData && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KPI
              icon="🏢"
              label="Companies"
              value={data.companies?.total ?? 0}
              sub={`+${data.companies?.newThisMonth ?? 0} this month`}
            />
            <KPI
              icon="🧪"
              label="On trial"
              value={data.companies?.trial ?? 0}
              tone="text-amber-300"
            />
            <KPI
              icon="👤"
              label="Platform users"
              value={data.users?.total ?? 0}
              sub={`+${data.users?.newThisMonth ?? 0} new`}
            />
            <KPI
              icon="💳"
              label="Paying companies"
              value={data.revenue?.payingCompanies ?? 0}
              tone="text-emerald-300"
            />
            <KPI
              icon="📈"
              label="MRR"
              value={money(data.revenue?.mrr)}
              sub={`${(data.revenue?.mrrGrowthPct ?? 0) >= 0 ? "+" : ""}${
                data.revenue?.mrrGrowthPct ?? 0
              }% MoM`}
              tone="text-emerald-300"
            />
            <KPI
              icon="🗓"
              label="ARR"
              value={money(data.revenue?.arr)}
              tone="text-indigo-300"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                📦 Plan distribution
              </h3>
              <Donut
                parts={(data.companies?.byPlan || []).map((plan) => ({
                  label: plan?.name || "Unknown",
                  value: plan?.count || 0,
                }))}
              />
            </div>

            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                🚦 Status distribution
              </h3>
              <Donut
                parts={(data.companies?.byStatus || []).map((status) => ({
                  label: status?.name || "Unknown",
                  value: status?.count || 0,
                }))}
              />
            </div>

            <div className={panel}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">
                💰 MRR by plan
              </h3>
              <Bars
                data={data.revenue?.mrrByPlan || []}
                labelKey="plan"
                valueKey="mrr"
                color="#34d399"
              />
            </div>
          </div>
        </div>
      )}

      {/* EMPLOYEE MY STATS */}
      {!loading && tab === "my" && hasCurrentData && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPI
              icon="🕒"
              label="Days marked (month)"
              value={(data.attendance || []).reduce(
                (sum, row) => sum + Number(row?.count || 0),
                0,
              )}
            />

            <KPI
              icon="✅"
              label="Tasks done"
              value={
                (data.tasks || []).find((row) =>
                  ["COMPLETED", "DONE"].includes(
                    String(row?._id || "").toUpperCase(),
                  ),
                )?.count || 0
              }
            />

            <KPI
              icon="🌴"
              label="Leaves approved"
              value={
                (data.leaves || []).find(
                  (row) => String(row?._id || "").toUpperCase() === "APPROVED",
                )?.count || 0
              }
            />

            <KPI
              icon="🔀"
              label="My shift"
              value={
                data.roster?.shift
                  ? `${data.roster.shift.startTime}–${data.roster.shift.endTime}`
                  : "—"
              }
              sub={data.roster?.shift?.name || "no shift assigned"}
            />
          </div>

          <div className={panel}>
            <h3 className="mb-2 text-sm font-semibold text-slate-300">
              🎉 Upcoming holidays
            </h3>

            <div className="flex flex-wrap gap-2">
              {(data.upcomingHolidays || []).map((holiday, index) => (
                <span
                  key={`${
                    holiday?.id || holiday?._id || "holiday"
                  }-${holiday?.date || index}`}
                  className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-300"
                >
                  <b className="text-slate-100">{holiday?.name || "Holiday"}</b>{" "}
                  · {holiday?.date || "—"}
                </span>
              ))}

              {!data.upcomingHolidays?.length && (
                <span className="text-xs text-slate-500">
                  None in the next 45 days.
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AnalyticsHubPage;
