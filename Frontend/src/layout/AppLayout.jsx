import { Outlet, useNavigate } from "react-router-dom";
import useAuth from "../hooks/useAuth.jsx";
import usePermission from "../hooks/usePermission.js";

import { ROLES } from "../utils/roles.js";
import NotificationBell from "../components/NotificationBell";
import SubscriptionStatusBanner from "../components/SubscriptionStatusBanner.jsx";
import { Power, Menu, X } from "lucide-react";
import SidebarNav from "./SidebarNav.jsx";
import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { startRealtimeSession, stopRealtimeSession } from "../services/realtime/realtimeClient.js";
import { fetchMyPermissions } from "../redux/slices/PermissionSlices.js";



const NAV_BY_ROLE = {
  [ROLES.COMPANY_ADMIN]: [
    { to: "/app", label: "Dashboard", end: true },
    { to: "/app/chat", label: "Chat" },
    { to: "/app/meetings", label: "Meetings" },
    { to: "/app/org-chart", label: "Organization" },
    { to: "/app/users", label: "User Management" },
    { to: "/app/departments", label: "Departments" },
    { to: "/app/analytics", label: "Analytics" },
    { to: "/app/reports", label: "Report Builder" },
    { to: "/app/attendance", label: "Attendance" },
    { to: "/app/attendance/report", label: "Attendance Reports" },
    { to: "/app/leaves", label: "My Leaves" },
    { to: "/app/leaves/approvals", label: "Leave Management" },
    { to: "/app/payroll", label: "Payroll" },
    { to: "/app/payslips", label: "My Payslips" },
    { to: "/app/holidays", label: "Holidays" },
    { to: "/app/shifts", label: "Shifts" },
    { to: "/app/schedules", label: "Work Schedules" },
    { to: "/app/announcements", label: "Announcements" },
    { label: "Celebrations", soon: true },
    { to: "/app/documents", label: "Documents" },
    { to: "/app/employee-files", label: "Employee Files" },
    { to: "/app/lifecycle", label: "Lifecycle" },
    { to: "/app/performance", label: "Performance" },
    { to: "/app/expenses", label: "Expenses" },
    { to: "/app/assets", label: "Assets" },
    { to: "/app/projects", label: "Projects" },
    { to: "/app/tasks", label: "Tasks" },
    { to: "/app/recruitment", label: "Recruitment" },
    { to: "/app/support", label: "Support Tickets" },
    { to: "/app/exit", label: "Resignations & Exit" },
    { to: "/app/company", label: "Company Settings" },
    { to: "/app/billing", label: "Billing & Plans" },
    {
      to: "/app/subscription",
      label: "Subscription",
    },
    { to: "/app/governance", label: "Audit & Roles" },
    { to: "/app/roles-permissions", label: "Roles & Permissions" },
    { to: "/app/profile", label: "My Profile" },
    { to: "/app/notifications", label: "Notifications" },
    { to: "/app/notification-settings", label: "Notify Settings" },
  ],

  [ROLES.HR_MANAGER]: [
    { to: "/app", label: "Dashboard", end: true },
    { to: "/app/chat", label: "Chat" },
    { to: "/app/users", label: "Employees" },
    {
      to: "/app/subscription",
      label: "Plan & Usage",
    },
    { to: "/app/departments", label: "Departments" },
    { to: "/app/analytics", label: "HR Analytics" },
    { to: "/app/reports", label: "Report Builder" },
    { to: "/app/attendance", label: "Attendance" },
    { to: "/app/attendance/report", label: "Attendance Reports" },
    { to: "/app/leaves", label: "My Leaves" },
    { to: "/app/leaves/approvals", label: "Leave Management" },
    { to: "/app/payroll", label: "Payroll" },
    { to: "/app/payslips", label: "My Payslips" },
    { to: "/app/holidays", label: "Holidays" },
    { to: "/app/shifts", label: "Shifts" },
    { to: "/app/schedules", label: "Work Schedules" },
    { to: "/app/announcements", label: "Announcements" },
    { label: "Celebrations", soon: true },
    { to: "/app/recruitment", label: "Recruitment" },
    { to: "/app/documents", label: "Documents" },
    { to: "/app/employee-files", label: "Employee Files" },
    { to: "/app/lifecycle", label: "Lifecycle" },
    { to: "/app/performance", label: "Performance" },
    { to: "/app/expenses", label: "Expenses" },
    { to: "/app/assets", label: "Assets" },
    { to: "/app/support", label: "Support Tickets" },
    { to: "/app/exit", label: "Resignations & Exit" },
    { label: "Employee Records", soon: true },
    { to: "/app/profile", label: "My Profile" },
    { to: "/app/notifications", label: "Notifications" },
    { to: "/app/notification-settings", label: "Notify Settings" },
  ],

  // ══ Phase 10: MANAGER ─ department-scoped workspace ═══════════════════
  [ROLES.MANAGER]: [
    { to: "/app", label: "Dashboard", end: true },
    { to: "/app/chat", label: "Chat" },
    { to: "/app/meetings", label: "Meetings" },
    { to: "/app/departments", label: "My Departments" },
    { to: "/app/analytics", label: "Team Analytics" },
    { to: "/app/org-chart", label: "My Team" },
    { to: "/app/users", label: "Employees" },
    { to: "/app/attendance", label: "Attendance" },
    { to: "/app/attendance/report", label: "Team Attendance" },
    { to: "/app/leaves", label: "Leave Requests" },
    { to: "/app/leaves/approvals", label: "Leave Approvals" },
    { to: "/app/projects", label: "Projects" },
    { to: "/app/tasks", label: "Tasks" },
    { to: "/app/performance", label: "Performance" },
    { to: "/app/expenses", label: "Expenses" },
    { to: "/app/assets", label: "Assets" },
    { to: "/app/recruitment/requisitions", label: "Hiring Requisitions" },
    { label: "Daily Reports", soon: true },
    { to: "/app/reports", label: "Report Builder" },
    { to: "/app/payslips", label: "Payslips" },
    { to: "/app/documents", label: "Documents" },
    { to: "/app/lifecycle", label: "My Journey" },
    { to: "/app/holidays", label: "Holidays" },
    { to: "/app/shifts", label: "My Shift" },
    { to: "/app/announcements", label: "Announcements" },
    { to: "/app/support", label: "Support Tickets" },
    { label: "Chat Hub", soon: true },
    { label: "Time Tracking", soon: true },
    { to: "/app/exit", label: "Resignation" },
    { to: "/app/profile", label: "My Profile" },
    { to: "/app/notifications", label: "Notifications" },
    { to: "/app/notification-settings", label: "Notify Settings" },
  ],

  // ══ Phase 10: TEAM LEAD ─ team-scoped workspace ═══════════════════════
  [ROLES.TEAM_LEAD]: [
    { to: "/app", label: "Dashboard", end: true },
    { to: "/app/chat", label: "Chat" },
    { to: "/app/meetings", label: "Meetings" },
    { to: "/app/org-chart", label: "My Team" },
    { to: "/app/users", label: "Team Members" },
    { to: "/app/analytics", label: "Team Analytics" },
    { to: "/app/attendance", label: "Attendance" },
    { to: "/app/attendance/report", label: "Team Attendance" },
    { to: "/app/leaves", label: "Leave Requests" },
    { to: "/app/leaves/approvals", label: "Approvals" },
    { to: "/app/projects", label: "Projects · Assign Tasks" },
    { to: "/app/tasks", label: "Team Tasks" },
    { to: "/app/performance", label: "Performance" },
    { to: "/app/expenses", label: "Expenses" },
    { to: "/app/assets", label: "Assets" },
    { to: "/app/recruitment/requisitions", label: "Hiring Requisitions" },
    { label: "Daily Reports", soon: true },
    { to: "/app/payslips", label: "Payslips" },
    { to: "/app/documents", label: "Documents" },
    { to: "/app/lifecycle", label: "My Journey" },
    { to: "/app/announcements", label: "Announcements" },
    { to: "/app/holidays", label: "My Holidays" },
    { to: "/app/shifts", label: "My Shift" },
    { to: "/app/support", label: "Support Tickets" },
    { label: "Chat Hub", soon: true },
    { label: "Time Tracking", soon: true },
    { to: "/app/exit", label: "Resignation" },
    { to: "/app/profile", label: "My Profile" },
    { to: "/app/notifications", label: "Notifications" },
    { to: "/app/notification-settings", label: "Notify Settings" },
  ],

  [ROLES.EMPLOYEE]: [
    { to: "/app", label: "Dashboard", end: true },
    { to: "/app/chat", label: "Chat" },
    { label: "Chat Hub", soon: true },
    { to: "/app/meetings", label: "Meetings" },
    { label: "Time Tracking", soon: true },
    { to: "/app/profile", label: "My Profile" },
    { to: "/app/notifications", label: "Notifications" },
    { to: "/app/notification-settings", label: "Notify Settings" },
    { to: "/app/analytics", label: "My Stats" },
    { to: "/app/holidays", label: "Holidays" },
    { to: "/app/shifts", label: "My Shift" },
    { to: "/app/attendance", label: "My Attendance" },
    { to: "/app/leaves", label: "Leave Requests" },
    { to: "/app/payslips", label: "My Payslips" },
    { to: "/app/documents", label: "My Documents" },
    { to: "/app/lifecycle", label: "My Journey" },
    { to: "/app/performance", label: "My Performance" },
    { to: "/app/expenses", label: "Expenses" },
    { to: "/app/assets", label: "Assets" },
    { to: "/app/announcements", label: "Announcements" },
    { to: "/app/support", label: "Support" },
    { to: "/app/exit", label: "Resignation" },
  ],
};


const AppLayout = () => {
  const { user, secureLogout } = useAuth();
  const { hasPermission, hasAnyPermission } = usePermission();
  const dispatch = useDispatch();
  const [loggingOut, setLoggingOut] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
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
  const baseMenu = NAV_BY_ROLE[user?.role] || NAV_BY_ROLE[ROLES.EMPLOYEE];

  const securityMenu = [
    {
      to: "/app/security/sessions",
      label: "Account Security",
    },

    ...([ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(user?.role)
      ? [
          {
            to: "/app/security",
            label: "Security Dashboard",
          },
          {
            to: "/app/audit-logs",
            label: "Audit Logs",
          },
        ]
      : []),

    ...(user?.role === ROLES.COMPANY_ADMIN
      ? [
          {
            to: "/app/security/settings",
            label: "Security Settings",
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

  const recruitmentDashboardMenu = hasPermission('RECRUITMENT_ANALYTICS_READ')
    ? [
        {
          to: '/app/recruitment',
          label: 'Recruitment Dashboard',
        },
      ]
    : [];

  const preOnboardingMenu = hasPermission('PRE_ONBOARDING_READ')
    ? [
        {
          to: '/app/recruitment/pre-onboarding',
          label: 'Pre-Onboarding',
        },
      ]
    : [];

  const bgvMenu = hasPermission('BACKGROUND_VERIFICATION_READ')
    ? [
        {
          to: '/app/recruitment/background-verification',
          label: 'Background Verification',
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

  const payrollMenu = [
    ...(hasAnyPermission(['PAYROLL_SETUP_READ', 'PAYROLL_SETUP_UPDATE', 'PAYROLL_SETUP_ACTIVATE'])
      ? [{ to: '/app/payroll/setup', label: 'Payroll Setup' }]
      : []),
    ...(hasAnyPermission([
      'SALARY_COMPONENT_READ',
      'SALARY_COMPONENT_MANAGE',
      'SALARY_COMPONENT_ACTIVATE',
    ])
      ? [{ to: '/app/payroll/components', label: 'Salary Components' }]
      : []),
    ...(hasAnyPermission([
      'SALARY_STRUCTURE_READ',
      'SALARY_STRUCTURE_MANAGE',
      'SALARY_STRUCTURE_ACTIVATE',
    ])
      ? [{ to: '/app/payroll/structures', label: 'Salary Structures' }]
      : []),
    ...(hasAnyPermission(['PAYROLL_INPUT_READ', 'PAYROLL_INPUT_MANAGE', 'PAYROLL_INPUT_LOCK'])
      ? [{ to: '/app/payroll/inputs', label: 'Monthly Inputs' }]
      : []),
    ...(hasAnyPermission([
      'PAYROLL_RUN_READ',
      'PAYROLL_RUN_PREPARE',
      'PAYROLL_RUN_EXECUTE',
      'PAYROLL_RUN_RECALCULATE',
    ])
      ? [{ to: '/app/payroll/run', label: 'Run Payroll' }]
      : []),
    ...(hasAnyPermission([
      'PAYROLL_RUN_READ',
      'PAYROLL_RUN_PREPARE',
      'PAYROLL_RUN_REVIEW',
      'PAYROLL_RUN_LOCK',
      'PAYROLL_RUN_REOPEN',
      'PAYROLL_RUN_APPROVE',
      'PAYROLL_RUN_REJECT',
    ])
      ? [{ to: '/app/payroll/review', label: 'Review Payroll' }]
      : []),
    ...(hasAnyPermission([
      'PAYROLL_PAYMENT_READ',
      'PAYROLL_PAYMENT_GENERATE',
      'PAYROLL_PAYMENT_CONFIRM',
      'PAYROLL_PAYMENT_MARK_PAID',
    ])
      ? [{ to: '/app/payroll/salary-payment', label: 'Salary Payment' }]
      : []),
    ...(hasAnyPermission([
      'PAYSLIP_READ',
      'PAYSLIP_GENERATE',
      'PAYSLIP_RELEASE',
      'PAYSLIP_RERELEASE',
    ])
      ? [{ to: '/app/payroll/payslips', label: 'Payslips' }]
      : []),
    ...(hasAnyPermission([
      'PAYROLL_STATUTORY_READ',
      'PAYROLL_STATUTORY_GENERATE',
      'PAYROLL_STATUTORY_MANAGE',
      'PAYROLL_STATUTORY_FILING',
    ])
      ? [{ to: '/app/payroll/statutory', label: 'Statutory Compliance' }]
      : []),
    ...(hasAnyPermission(['PAYSLIP_READ_SELF'])
      ? [{ to: '/app/payroll/my-payslips', label: 'My Payroll' }]
      : []),
    ...(hasAnyPermission([
      'FINAL_SETTLEMENT_READ',
      'FINAL_SETTLEMENT_CALCULATE',
      'FINAL_SETTLEMENT_REVIEW',
      'FINAL_SETTLEMENT_APPROVE',
      'FINAL_SETTLEMENT_PAY',
      'FINAL_SETTLEMENT_CLOSE',
      'FINAL_SETTLEMENT_REOPEN',
    ])
      ? [{ to: '/app/payroll/final-settlement', label: 'Final Settlement' }]
      : []),
    ...(hasAnyPermission(['FINAL_SETTLEMENT_READ_SELF'])
      ? [{ to: '/app/payroll/my-final-settlement', label: 'My Final Settlement' }]
      : []),
    ...(hasAnyPermission([
      'PAYROLL_REPORT_READ',
      'PAYROLL_REPORT_EXPORT',
      'PAYROLL_ANALYTICS_FINANCIAL',
      'PAYROLL_ANALYTICS_SCHEDULE',
    ])
      ? [{ to: '/app/payroll/analytics', label: 'Analytics & Reports' }]
      : []),
  ];

  const attendancePolicyMenu = hasAnyPermission([
    'ATTENDANCE_POLICY_READ',
    'ATTENDANCE_POLICY_MANAGE',
    'ATTENDANCE_POLICY_ACTIVATE',
  ])
    ? [{ to: '/app/attendance/policy', label: 'Attendance Policy' }]
    : [];

  const workModeMenu = hasAnyPermission([
    'ATTENDANCE_WORK_MODE_REQUEST',
    'ATTENDANCE_WORK_MODE_REVIEW',
  ])
    ? [{ to: '/app/attendance/work-modes', label: 'Work Mode Requests' }]
    : [];

  const regularizationMenu = hasAnyPermission([
    'ATTENDANCE_REGULARIZATION_REQUEST',
    'ATTENDANCE_REGULARIZATION_REVIEW',
  ])
    ? [{ to: '/app/attendance/regularizations', label: 'Regularizations' }]
    : [];

  const overtimeMenu = hasAnyPermission([
    'ATTENDANCE_OVERTIME_REQUEST',
    'ATTENDANCE_OVERTIME_REVIEW',
  ])
    ? [{ to: '/app/attendance/overtime', label: 'Overtime & Comp-Off' }]
    : [];

  const teamMenu = hasAnyPermission(['ATTENDANCE_READ'])
    ? [{ to: '/app/attendance/team', label: "Who's Working" }]
    : [];

  const timesheetMenu = hasAnyPermission(['ATTENDANCE_READ_SELF', 'ATTENDANCE_READ'])
    ? [{ to: '/app/attendance/timesheet', label: 'My Timesheet' }]
    : [];
  const teamTimesheetsMenu = hasAnyPermission(['ATTENDANCE_READ'])
    ? [{ to: '/app/attendance/team-timesheets', label: 'Team Timesheets' }]
    : [];

  const operationsMenu = hasAnyPermission(['ATTENDANCE_OPERATIONS_READ'])
    ? [{ to: '/app/attendance/operations', label: 'Attendance Operations' }]
    : [];

  const analyticsMenu = hasAnyPermission(['ATTENDANCE_ANALYTICS_READ', 'ATTENDANCE_READ_SELF'])
    ? [{ to: '/app/attendance/analytics', label: 'Attendance Analytics' }]
    : [];

  const captureMenu = hasAnyPermission(['ATTENDANCE_CAPTURE_MANAGE'])
    ? [
        { to: '/app/attendance/kiosks', label: 'Kiosk Stations' },
        { to: '/app/attendance/qr', label: 'QR Challenges' },
        { to: '/app/attendance/imports', label: 'Attendance Import' },
      ]
    : [];

  const menu = [
    ...baseMenu,
    ...attendancePolicyMenu,
    ...workModeMenu,
    ...regularizationMenu,
    ...overtimeMenu,
    ...teamMenu,
    ...timesheetMenu,
    ...teamTimesheetsMenu,
    ...operationsMenu,
    ...analyticsMenu,
    ...captureMenu,
    ...payrollMenu,
    ...recruitmentDashboardMenu,
    ...candidateMenu,
    ...offerMenu,
    ...preOnboardingMenu,
    ...bgvMenu,
    ...interviewMenu,
    ...securityMenu,
  ];

  return (
    <div className="flex min-h-screen bg-crewly-bg">
      {/* Desktop sidebar — hidden on mobile */}
      <div className="hidden lg:block">
        <SidebarNav menu={menu} />
      </div>

      {/* Mobile drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="w-[85vw] max-w-[300px] shrink-0 overflow-hidden">
            <SidebarNav menu={menu} mobile onClose={() => setMobileNavOpen(false)} />
          </div>
          <button
            type="button"
            aria-label="Close menu"
            className="flex-1 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileNavOpen(false)}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Responsive header: stacks on sm, tighter on mobile */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-crewly-border bg-crewly-card px-3 py-2.5 sm:px-4 lg:px-6 xl:px-7 sm:py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            {/* Hamburger — visible only on <lg */}
            <button
              type="button"
              onClick={() => setMobileNavOpen((v) => !v)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-crewly-border bg-crewly-bg text-crewly-text transition hover:border-crewly-green lg:hidden"
              aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileNavOpen}
            >
              {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>

            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="h-8 w-8 sm:h-9 sm:w-9 rounded-full object-cover ring-2 ring-crewly-border shrink-0"
                />
              ) : (
                <div className="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full bg-crewly-green/15 text-xs sm:text-sm font-bold text-crewly-green">
                  {user?.name?.[0]?.toUpperCase() || "?"}
                </div>
              )}
              <div className="min-w-0">
                <span className="block truncate text-xs sm:text-sm text-crewly-dim">
                  <span className="font-medium text-crewly-text">{user?.name}</span>
                </span>
                <span className="badge mt-0.5 hidden bg-crewly-green/15 text-crewly-green sm:inline-block">
                  {user?.role?.replace("_", " ")}
                </span>
                <span className="block text-[11px] text-crewly-green sm:hidden">
                  {user?.role?.replace("_", " ")}
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-3 lg:gap-4">
            <NotificationBell />
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="btn-ghost hidden px-3 py-2 text-xs sm:inline-flex sm:px-4 sm:text-sm"
            >
              {loggingOut ? "Logging out…" : <><Power className="mr-1 hidden h-4 w-4 sm:inline" />Logout</>}
            </button>
            {/* Mobile logout icon only */}
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-crewly-border bg-crewly-bg text-crewly-red transition hover:bg-crewly-red/10 sm:hidden"
              aria-label="Logout"
              title="Logout"
            >
              <Power className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Responsive main: tight on mobile, generous on desktop */}
        <main className="flex-1 p-3 sm:p-4 md:p-6 lg:p-7">
          <div className="mx-auto w-full max-w-[1600px]">
            <SubscriptionStatusBanner />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
