import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import useAuth from '../hooks/useAuth.jsx';
import { ROLES } from '../utils/roles.js';
import NotificationBell from '../components/NotificationBell';

const NAV_BY_ROLE = {
  [ROLES.COMPANY_ADMIN]: [
    { to: '/app', label: '🏠 Dashboard', end: true },
    { to: '/app/meetings', label: '📅 Meetings' },
    { to: '/app/org-chart', label: '🌳 Organization' },
    { to: '/app/users', label: '👥 User Management' },
    { to: '/app/departments', label: '🏬 Departments' },
    { to: '/app/analytics', label: '📊 Analytics' },
    { to: '/app/attendance', label: '🕒 Attendance' },
    { to: '/app/attendance/report', label: '📈 Attendance Reports' },
    { to: '/app/leaves', label: '🌴 My Leaves' },
    { to: '/app/leaves/approvals', label: '✅ Leave Management' },
    { to: '/app/payroll', label: '💰 Payroll' },
    { to: '/app/payslips', label: '🧾 My Payslips' },
    { label: '🔀 Shift Management', soon: true },
    { to: '/app/announcements', label: '📢 Announcements' },
    { label: '🥳 Celebrations', soon: true },
    { to: '/app/documents', label: '📄 Documents' },
    { to: '/app/projects', label: '📁 Projects' },
    { to: '/app/tasks', label: '📋 Tasks' },
    { to: '/app/recruitment', label: '🧲 Recruitment' },
    { to: '/app/support', label: '🎫 Support Tickets' },
    { label: '📑 Reports', soon: true },
    { to: '/app/exit', label: '🚪 Resignations & Exit' },
    { to: '/app/company', label: '⚙️ Company Settings' },
    { to: '/app/billing', label: '💳 Billing & Plans' },
    { to: '/app/governance', label: '🛡️ Audit & Roles' },
    { to: '/app/profile', label: '👤 My Profile' },
    { to: '/app/notifications', label: '🔔 Notifications' },
    //{ to: '/app/notification-settings', label: '⚙️ Notify Settings' },
  ],

  [ROLES.HR_MANAGER]: [
    { to: '/app', label: '🏠 Dashboard', end: true },
    { to: '/app/users', label: '👥 Employees' },
    { to: '/app/departments', label: '🏬 Departments' },
    { to: '/app/attendance', label: '🕒 Attendance' },
    { to: '/app/attendance/report', label: '📈 Attendance Reports' },
    { to: '/app/leaves', label: '🌴 My Leaves' },
    { to: '/app/leaves/approvals', label: '✅ Leave Management' },
    { to: '/app/payroll', label: '💰 Payroll' },
    { to: '/app/payslips', label: '🧾 My Payslips' },
    { label: '🔀 Shift Management', soon: true },
    { label: '🎉 Holidays', soon: true },
    { to: '/app/announcements', label: '📢 Announcements' },
    { label: '🥳 Celebrations', soon: true },
    { to: '/app/recruitment', label: '🧲 Recruitment · Job Posting' },
    { to: '/app/documents', label: '📄 Documents' },
    { to: '/app/support', label: '🎫 Support Tickets' },
    { label: '📑 Reports', soon: true },
    { to: '/app/analytics', label: '📉 HR Analytics' },
    { to: '/app/exit', label: '🚪 Resignations & Exit' },
    { label: '🗂 Employee Records', soon: true },
    { to: '/app/profile', label: '👤 My Profile' },
    { to: '/app/notifications', label: '🔔 Notifications' },
   // { to: '/app/notification-settings', label: '⚙️ Notify Settings' },
  ],

  // ══ Phase 10: MANAGER ─ department-scoped workspace ═══════════════════
  [ROLES.MANAGER]: [
    { to: '/app', label: '🏠 Dashboard', end: true },
    { to: '/app/meetings', label: '📅 Meetings' },
    { to: '/app/departments', label: '🏬 My Departments' },
    { to: '/app/org-chart', label: '🌳 My Team' },
    { to: '/app/users', label: '👥 Employees' },
    { to: '/app/attendance', label: '🕒 Attendance' },
    { to: '/app/attendance/report', label: '📈 Team Attendance' },
    { to: '/app/leaves', label: '🌴 Leave Requests' },
    { to: '/app/leaves/approvals', label: '✅ Leave Approvals' },
    { to: '/app/projects', label: '📁 Projects' },
    { to: '/app/tasks', label: '📋 Tasks' },
    { label: '📊 Performance', soon: true },
    { label: '📊 Daily Reports', soon: true },
    { label: '📑 Reports', soon: true },
    { to: '/app/payslips', label: '🧾 Payslips' },
    { to: '/app/documents', label: '📄 Documents' },
    { to: '/app/announcements', label: '📢 Announcements' },
    { to: '/app/support', label: '🎫 Support Tickets' },
    { label: '💬 Chat Hub', soon: true },
    { label: '⏱️ Time Tracking', soon: true },
    { to: '/app/exit', label: '🚪 Resignation' },
    { to: '/app/profile', label: '👤 My Profile' },
    { to: '/app/notifications', label: '🔔 Notifications' },
  //  { to: '/app/notification-settings', label: '⚙️ Notify Settings' },
  ],

  // ══ Phase 10: TEAM LEAD ─ team-scoped workspace ═══════════════════════
  [ROLES.TEAM_LEAD]: [
    { to: '/app', label: '🏠 Dashboard', end: true },
    { to: '/app/meetings', label: '📅 Meetings' },
    { to: '/app/org-chart', label: '🌳 My Team' },
    { to: '/app/users', label: '👥 Team Members' },
    { to: '/app/attendance', label: '🕒 Attendance' },
    { to: '/app/attendance/report', label: '📈 Team Attendance' },
    { to: '/app/leaves', label: '🌴 Leave Requests' },
    { to: '/app/leaves/approvals', label: '✅ Approvals' },
    { to: '/app/projects', label: '📁 Projects · Assign Tasks' },
    { to: '/app/tasks', label: '📋 Team Tasks' },
    { label: '📊 Team Performance', soon: true },
    { label: '📊 Daily Reports', soon: true },
    { to: '/app/payslips', label: '🧾 Payslips' },
    { to: '/app/documents', label: '📄 Documents' },
    { to: '/app/announcements', label: '📢 Announcements' },
    { label: '🎉 My Holidays', soon: true },
    { to: '/app/support', label: '🎫 Support Tickets' },
    { label: '💬 Chat Hub', soon: true },
    { label: '⏱️ Time Tracking', soon: true },
    { to: '/app/exit', label: '🚪 Resignation' },
    { to: '/app/profile', label: '👤 My Profile' },
    { to: '/app/notifications', label: '🔔 Notifications' },
   // { to: '/app/notification-settings', label: '⚙️ Notify Settings' },
  ],

  [ROLES.EMPLOYEE]: [
    { to: '/app', label: '🏠 Dashboard', end: true },
    { label: '💬 Chat Hub', soon: true },
    { to: '/app/meetings', label: '📅 Meetings' },
    { label: '⏱️ Time Tracking', soon: true },
    { to: '/app/profile', label: '👤 My Profile' },
    { to: '/app/notifications', label: '🔔 Notifications' },
  //  { to: '/app/notification-settings', label: '⚙️ Notify Settings' },
    { to: '/app/attendance', label: '🕒 My Attendance' },
    { to: '/app/leaves', label: '🌴 Leave Requests' },
    { to: '/app/payslips', label: '🧾 My Payslips' },
    { to: '/app/documents', label: '📄 My Documents' },
    { to: '/app/announcements', label: '📢 Announcements' },
    { to: '/app/support', label: '🎫 Support' },
    { to: '/app/exit', label: '🚪 Resignation' },
  ],
};

const AppLayout = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const linkClass = ({ isActive }) =>
    `block rounded-lg px-4 py-2.5 text-sm transition ${
      isActive ? 'bg-crewly-green/10 text-crewly-green' : 'text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text'
    }`;

  const menu = NAV_BY_ROLE[user?.role] || NAV_BY_ROLE[ROLES.EMPLOYEE];

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-crewly-border bg-crewly-card px-4 py-5">
        <div className="text-lg font-extrabold tracking-wide text-crewly-green">
          Crewly <span className="text-crewly-orange">HRMS</span>
        </div>

        <nav className="mt-5 flex-1 space-y-0.5 overflow-y-auto pr-1">
          {menu.map((item) =>
            item.soon ? (
              <span
                key={item.label}
                title="Coming in an upcoming phase"
                className="block cursor-not-allowed rounded-lg px-4 py-2.5 text-sm text-crewly-dim/40"
              >
                {item.label} <span className="text-[10px]">· soon</span>
              </span>
            ) : (
              <NavLink key={item.label} to={item.to} end={item.end} className={linkClass}>
                {item.label}
              </NavLink>
            )
          )}
        </nav>

        <p className="pt-3 text-[11px] text-crewly-dim/60">Crewly HRMS · Phase 10</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-crewly-border bg-crewly-card px-7 py-3">
          <div className="flex items-center gap-3">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover ring-2 ring-crewly-border" />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-crewly-green/15 text-sm font-bold text-crewly-green">
                {user?.name?.[0]?.toUpperCase() || '?'}
              </div>
            )}
            <span className="text-crewly-dim">
              {user?.name}{' '}
              <span className="badge ml-1 bg-crewly-green/15 text-crewly-green">
                {user?.role?.replace('_', ' ')}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-4">
            <NotificationBell />
            <button onClick={handleLogout} className="btn-ghost px-4 py-2 text-sm">
              ⏻ Logout
            </button>
          </div>
        </header>
        <main className="flex-1 p-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default AppLayout;