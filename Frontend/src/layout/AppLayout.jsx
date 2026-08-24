import { Outlet, NavLink, useNavigate } from "react-router-dom";
import useAuth from "../hooks/useAuth.jsx";
import usePermission from "../hooks/usePermission.js";

import { ROLES } from "../utils/roles.js";
import NotificationBell from "../components/NotificationBell";
import SubscriptionStatusBanner from "../components/SubscriptionStatusBanner.jsx";
import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { fetchMyPermissions } from "../redux/slices/PermissionSlices.js";

import {
  BarChart3,
  Bell,
  BellRing,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  Clock,
  CreditCard,
  DoorOpen,
  FileText,
  Files,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  LifeBuoy,
  ListTodo,
  LockKeyhole,
  Megaphone,
  MessageCircle,
  Monitor,
  Network,
  PartyPopper,
  ReceiptText,
  ScrollText,
  Settings,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Target,
  Timer,
  UserCircle,
  Users,
  Wallet,
} from "lucide-react";

const NAV_BY_ROLE = {
  [ROLES.COMPANY_ADMIN]: [
    { to: "/app", label: "🏠 Dashboard", end: true },
    { to: "/app/meetings", label: "📅 Meetings" },
    { to: "/app/org-chart", label: "🌳 Organization" },
    { to: "/app/users", label: "👥 User Management" },
    { to: "/app/departments", label: "🏬 Departments" },
    { to: "/app/analytics", label: "📊 Analytics" },
    { to: "/app/reports", label: "📑 Report Builder" },
    { to: "/app/attendance", label: "🕒 Attendance" },
    { to: "/app/attendance/report", label: "📈 Attendance Reports" },
    { to: "/app/leaves", label: "🌴 My Leaves" },
    { to: "/app/leaves/approvals", label: "✅ Leave Management" },
    { to: "/app/payroll", label: "💰 Payroll" },
    { to: "/app/payslips", label: "🧾 My Payslips" },
    { to: "/app/holidays", label: "🎉 Holidays" },
    { to: "/app/shifts", label: "🔀 Shifts" },
    { to: "/app/schedules", label: "🗓 Work Schedules" },
    { to: "/app/announcements", label: "📢 Announcements" },
    { label: "🥳 Celebrations", soon: true },
    { to: "/app/documents", label: "📄 Documents" },
    { to: "/app/employee-files", label: "🗂 Employee Files" },
    { to: "/app/lifecycle", label: "🧬 Lifecycle" },
    { to: "/app/performance", label: "🎯 Performance" },
    { to: "/app/expenses", label: "💸 Expenses" },
    { to: "/app/assets", label: "🖥 Assets" },
    { to: "/app/projects", label: "📁 Projects" },
    { to: "/app/tasks", label: "📋 Tasks" },
    { to: "/app/recruitment/requisitions", label: "Recruitment" },
    { to: "/app/support", label: "🎫 Support Tickets" },
    { to: "/app/exit", label: "🚪 Resignations & Exit" },
    { to: "/app/company", label: "⚙️ Company Settings" },
    { to: "/app/billing", label: "💳 Billing & Plans" },
    {
      to: "/app/subscription",
      label: "💳 Subscription",
    },
    { to: "/app/governance", label: "🛡️ Audit & Roles" },
    { to: "/app/profile", label: "👤 My Profile" },
    { to: "/app/notifications", label: "🔔 Notifications" },
    { to: "/app/notification-settings", label: "⚙️ Notify Settings" },
  ],

  [ROLES.HR_MANAGER]: [
    { to: "/app", label: "🏠 Dashboard", end: true },
    { to: "/app/users", label: "👥 Employees" },
    {
      to: "/app/subscription",
      label: "💳 Plan & Usage",
    },
    { to: "/app/departments", label: "🏬 Departments" },
    { to: "/app/analytics", label: "📉 HR Analytics" },
    { to: "/app/reports", label: "📑 Report Builder" },
    { to: "/app/attendance", label: "🕒 Attendance" },
    { to: "/app/attendance/report", label: "📈 Attendance Reports" },
    { to: "/app/leaves", label: "🌴 My Leaves" },
    { to: "/app/leaves/approvals", label: "✅ Leave Management" },
    { to: "/app/payroll", label: "💰 Payroll" },
    { to: "/app/payslips", label: "🧾 My Payslips" },
    { to: "/app/holidays", label: "🎉 Holidays" },
    { to: "/app/shifts", label: "🔀 Shifts" },
    { to: "/app/schedules", label: "🗓 Work Schedules" },
    { to: "/app/announcements", label: "📢 Announcements" },
    { label: "🥳 Celebrations", soon: true },
    { to: "/app/recruitment/requisitions", label: "Recruitment" },
    { to: "/app/documents", label: "📄 Documents" },
    { to: "/app/employee-files", label: "🗂 Employee Files" },
    { to: "/app/lifecycle", label: "🧬 Lifecycle" },
    { to: "/app/performance", label: "🎯 Performance" },
    { to: "/app/expenses", label: "💸 Expenses" },
    { to: "/app/assets", label: "🖥 Assets" },
    { to: "/app/support", label: "🎫 Support Tickets" },
    { to: "/app/exit", label: "🚪 Resignations & Exit" },
    { label: "🗂 Employee Records", soon: true },
    { to: "/app/profile", label: "👤 My Profile" },
    { to: "/app/notifications", label: "🔔 Notifications" },
    { to: "/app/notification-settings", label: "⚙️ Notify Settings" },
  ],

  // ══ Phase 10: MANAGER ─ department-scoped workspace ═══════════════════
  [ROLES.MANAGER]: [
    { to: "/app", label: "🏠 Dashboard", end: true },
    { to: "/app/meetings", label: "📅 Meetings" },
    { to: "/app/departments", label: "🏬 My Departments" },
    { to: "/app/analytics", label: "📊 Team Analytics" },
    { to: "/app/org-chart", label: "🌳 My Team" },
    { to: "/app/users", label: "👥 Employees" },
    { to: "/app/attendance", label: "🕒 Attendance" },
    { to: "/app/attendance/report", label: "📈 Team Attendance" },
    { to: "/app/leaves", label: "🌴 Leave Requests" },
    { to: "/app/leaves/approvals", label: "✅ Leave Approvals" },
    { to: "/app/projects", label: "📁 Projects" },
    { to: "/app/tasks", label: "📋 Tasks" },
    { to: "/app/performance", label: "📊 Performance" },
    { to: "/app/expenses", label: "💸 Expenses" },
    { to: "/app/assets", label: "🖥 Assets" },
    { to: "/app/recruitment/requisitions", label: "Hiring Requisitions" },
    { label: "📊 Daily Reports", soon: true },
    { to: "/app/reports", label: "📑 Report Builder" },
    { to: "/app/payslips", label: "🧾 Payslips" },
    { to: "/app/documents", label: "📄 Documents" },
    { to: "/app/lifecycle", label: "🧬 My Journey" },
    { to: "/app/holidays", label: "🎉 Holidays" },
    { to: "/app/shifts", label: "🔀 My Shift" },
    { to: "/app/announcements", label: "📢 Announcements" },
    { to: "/app/support", label: "🎫 Support Tickets" },
    { label: "💬 Chat Hub", soon: true },
    { label: "⏱️ Time Tracking", soon: true },
    { to: "/app/exit", label: "🚪 Resignation" },
    { to: "/app/profile", label: "👤 My Profile" },
    { to: "/app/notifications", label: "🔔 Notifications" },
    { to: "/app/notification-settings", label: "⚙️ Notify Settings" },
  ],

  // ══ Phase 10: TEAM LEAD ─ team-scoped workspace ═══════════════════════
  [ROLES.TEAM_LEAD]: [
    { to: "/app", label: "🏠 Dashboard", end: true },
    { to: "/app/meetings", label: "📅 Meetings" },
    { to: "/app/org-chart", label: "🌳 My Team" },
    { to: "/app/users", label: "👥 Team Members" },
    { to: "/app/analytics", label: "📊 Team Analytics" },
    { to: "/app/attendance", label: "🕒 Attendance" },
    { to: "/app/attendance/report", label: "📈 Team Attendance" },
    { to: "/app/leaves", label: "🌴 Leave Requests" },
    { to: "/app/leaves/approvals", label: "✅ Approvals" },
    { to: "/app/projects", label: "📁 Projects · Assign Tasks" },
    { to: "/app/tasks", label: "📋 Team Tasks" },
    { to: "/app/performance", label: "📊 Performance" },
    { to: "/app/expenses", label: "💸 Expenses" },
    { to: "/app/assets", label: "🖥 Assets" },
    { to: "/app/recruitment/requisitions", label: "Hiring Requisitions" },
    { label: "📊 Daily Reports", soon: true },
    { to: "/app/payslips", label: "🧾 Payslips" },
    { to: "/app/documents", label: "📄 Documents" },
    { to: "/app/lifecycle", label: "🧬 My Journey" },
    { to: "/app/announcements", label: "📢 Announcements" },
    { to: "/app/holidays", label: "🎉 My Holidays" },
    { to: "/app/shifts", label: "🔀 My Shift" },
    { to: "/app/support", label: "🎫 Support Tickets" },
    { label: "💬 Chat Hub", soon: true },
    { label: "⏱️ Time Tracking", soon: true },
    { to: "/app/exit", label: "🚪 Resignation" },
    { to: "/app/profile", label: "👤 My Profile" },
    { to: "/app/notifications", label: "🔔 Notifications" },
    { to: "/app/notification-settings", label: "⚙️ Notify Settings" },
  ],

  [ROLES.EMPLOYEE]: [
    { to: "/app", label: "🏠 Dashboard", end: true },
    { label: "💬 Chat Hub", soon: true },
    { to: "/app/meetings", label: "📅 Meetings" },
    { label: "⏱️ Time Tracking", soon: true },
    { to: "/app/profile", label: "👤 My Profile" },
    { to: "/app/notifications", label: "🔔 Notifications" },
    { to: "/app/notification-settings", label: "⚙️ Notify Settings" },
    { to: "/app/analytics", label: "📊 My Stats" },
    { to: "/app/holidays", label: "🎉 Holidays" },
    { to: "/app/shifts", label: "🔀 My Shift" },
    { to: "/app/attendance", label: "🕒 My Attendance" },
    { to: "/app/leaves", label: "🌴 Leave Requests" },
    { to: "/app/payslips", label: "🧾 My Payslips" },
    { to: "/app/documents", label: "📄 My Documents" },
    { to: "/app/lifecycle", label: "🧬 My Journey" },
    { to: "/app/performance", label: "🎯 My Performance" },
    { to: "/app/expenses", label: "💸 Expenses" },
    { to: "/app/assets", label: "🖥 Assets" },
    { to: "/app/announcements", label: "📢 Announcements" },
    { to: "/app/support", label: "🎫 Support" },
    { to: "/app/exit", label: "🚪 Resignation" },
  ],
};


const NAV_ICON_BY_PATH = {
  "/app":
    LayoutDashboard,

  "/app/meetings":
    CalendarDays,

  "/app/org-chart":
    Network,

  "/app/users":
    Users,

  "/app/departments":
    Building2,

  "/app/analytics":
    BarChart3,

  "/app/reports":
    FileText,

  "/app/attendance":
    Clock,

  "/app/attendance/report":
    BarChart3,

  "/app/leaves":
    CalendarOff,

  "/app/leaves/approvals":
    CheckCircle2,

  "/app/payroll":
    Wallet,

  "/app/payslips":
    ReceiptText,

  "/app/holidays":
    PartyPopper,

  "/app/shifts":
    Shuffle,

  "/app/schedules":
    CalendarRange,

  "/app/announcements":
    Megaphone,

  "/app/documents":
    FileText,

  "/app/employee-files":
    Files,

  "/app/lifecycle":
    GitBranch,

  "/app/performance":
    Target,

  "/app/expenses":
    Wallet,

  "/app/assets":
    Monitor,

  "/app/projects":
    FolderOpen,

  "/app/tasks":
    ListTodo,

  "/app/recruitment":
    ClipboardList,

  "/app/recruitment/requisitions":
    ClipboardList,

  "/app/recruitment/candidates":
    Users,

  "/app/recruitment/interviews":
    CalendarClock,

  "/app/recruitment/my-interviews":
    CalendarClock,

  "/app/support":
    LifeBuoy,

  "/app/exit":
    DoorOpen,

  "/app/company":
    Settings,

  "/app/billing":
    CreditCard,

  "/app/subscription":
    CreditCard,

  "/app/governance":
    ShieldCheck,

  "/app/roles-permissions":
    ShieldCheck,

  "/app/profile":
    UserCircle,

  "/app/notifications":
    Bell,

  "/app/notification-settings":
    BellRing,

  "/app/security/sessions":
    LockKeyhole,

  "/app/security":
    ShieldCheck,

  "/app/audit-logs":
    ScrollText,

  "/app/security/settings":
    Settings,
};

/*
 * Removes the existing emoji prefix from labels.
 * Example: "🏠 Dashboard" becomes "Dashboard".
 */
const cleanNavLabel = (label = "") =>
  String(label)
    .replace(
      /^[^A-Za-z0-9]+/,
      "",
    )
    .trim();

const getSoonIcon = (label = "") => {
  const cleanLabel =
    cleanNavLabel(label);

  if (
    cleanLabel.includes(
      "Celebrations",
    )
  ) {
    return PartyPopper;
  }

  if (
    cleanLabel.includes(
      "Chat",
    )
  ) {
    return MessageCircle;
  }

  if (
    cleanLabel.includes(
      "Time Tracking",
    )
  ) {
    return Timer;
  }

  if (
    cleanLabel.includes(
      "Daily Reports",
    )
  ) {
    return BarChart3;
  }

  if (
    cleanLabel.includes(
      "Employee Records",
    )
  ) {
    return Files;
  }

  return Sparkles;
};

const getNavIcon = (item) =>
  NAV_ICON_BY_PATH[
    item.to
  ] ||
  getSoonIcon(item.label);

const AppLayout = () => {
  const { user, secureLogout } = useAuth();
  const { hasPermission } = usePermission();
  const dispatch = useDispatch();
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const userId = user?.id || user?._id;

  useEffect(() => {
    if (userId) {
      dispatch(fetchMyPermissions());
    }
  }, [dispatch, userId]);

  const handleLogout = async () => {
    setLoggingOut(true);

    await secureLogout();

    navigate("/login", {
      replace: true,
    });
  };
  const linkClass = ({ isActive }) =>
  `flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm transition ${
      isActive
        ? "bg-crewly-green/10 text-crewly-green"
        : "text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text"
    }`;

  const baseMenu = NAV_BY_ROLE[user?.role] || NAV_BY_ROLE[ROLES.EMPLOYEE];

  const securityMenu = [
    {
      to: "/app/security/sessions",
      label: "🔐 Account Security",
    },

    ...([ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(user?.role)
      ? [
          {
            to: "/app/security",
            label: "🛡 Security Dashboard",
          },
          {
            to: "/app/audit-logs",
            label: "📜 Audit Logs",
          },
        ]
      : []),

    ...(user?.role === ROLES.COMPANY_ADMIN
      ? [
          {
            to: "/app/security/settings",
            label: "⚙ Security Settings",
          },
        ]
      : []),
  ];

  const candidateMenu = hasPermission('CANDIDATE_READ')
    ? [
        {
          to: '/app/recruitment/candidates',
          label: 'Candidates',
        },
      ]
    : [];

  const offerMenu = hasPermission('OFFER_READ')
    ? [
        {
          to: '/app/recruitment/offers',
          label: 'Offers',
        },
      ]
    : [];

  const interviewMenu = [
    ...(hasPermission('INTERVIEW_READ')
      ? [
          {
            to: '/app/recruitment/interviews',
            label: 'Interviews',
          },
        ]
      : []),
    ...(hasPermission('INTERVIEW_READ_SELF')
      ? [
          {
            to: '/app/recruitment/my-interviews',
            label: 'My Interviews',
          },
        ]
      : []),
  ];

  const menu = [
    ...baseMenu,
    ...candidateMenu,
    ...offerMenu,
    ...interviewMenu,
    ...securityMenu,
  ];

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-crewly-border bg-crewly-card px-4 py-5">
        <div className="text-lg font-extrabold tracking-wide text-crewly-green">
          Crewly <span className="text-crewly-orange">HRMS</span>
        </div>

        <nav className="mt-5 flex-1 space-y-0.5 overflow-y-auto pr-1">
    {menu.map((item) => {
  const Icon =
    getNavIcon(item);

  const label =
    cleanNavLabel(
      item.label,
    );

  const key =
    `${item.to || "soon"}-${label}`;

  if (item.soon) {
    return (
      <span
        key={key}
        title="Coming in an upcoming phase"
        className="flex cursor-not-allowed items-center gap-3 rounded-lg px-4 py-2.5 text-sm text-crewly-dim/40"
      >
        <Icon
          aria-hidden="true"
          className="h-[17px] w-[17px] shrink-0"
          strokeWidth={1.8}
        />

        <span className="min-w-0 flex-1">
          {label}
        </span>

        <span className="text-[10px]">
          soon
        </span>
      </span>
    );
  }

  return (
    <NavLink
      key={key}
      to={item.to}
      end={item.end}
      className={linkClass}
    >
      <Icon
        aria-hidden="true"
        className="h-[17px] w-[17px] shrink-0"
        strokeWidth={1.8}
      />

      <span className="min-w-0 flex-1">
        {label}
      </span>
    </NavLink>
  );
})}
        </nav>

        <p className="pt-3 text-[11px] text-crewly-dim/60">
          Crewly HRMS · Phase 27.10
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-crewly-border bg-crewly-card px-7 py-3">
          <div className="flex items-center gap-3">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                className="h-9 w-9 rounded-full object-cover ring-2 ring-crewly-border"
              />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-crewly-green/15 text-sm font-bold text-crewly-green">
                {user?.name?.[0]?.toUpperCase() || "?"}
              </div>
            )}
            <span className="text-crewly-dim">
              {user?.name}{" "}
              <span className="badge ml-1 bg-crewly-green/15 text-crewly-green">
                {user?.role?.replace("_", " ")}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-4">
            <NotificationBell />
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="btn-ghost px-4 py-2 text-sm"
            >
              {loggingOut ? "Logging out…" : "⏻ Logout"}
            </button>
          </div>
        </header>
        <main className="flex-1 p-7">
          <SubscriptionStatusBanner />
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
