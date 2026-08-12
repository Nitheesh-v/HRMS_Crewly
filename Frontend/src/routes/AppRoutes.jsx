import { Routes, Route } from 'react-router-dom';
import PublicLayout from '../layout/PublicLayout.jsx';
import AppLayout from '../layout/AppLayout.jsx';
import RequireAuth from './RequireAuth.jsx';
import RequireRole from './RequireRole.jsx';
import LandingPage from '../pages/landing/LandingPage.jsx';
import LoginPage from '../pages/login/LoginPage.jsx';
import RegisterCompanyPage from '../pages/register/RegisterCompanyPage.jsx';
import DashboardPage from '../pages/dashboard/DashboardPage.jsx';
import DepartmentsPage from '../pages/departments/DepartmentsPage.jsx';
import UsersPage from '../pages/users/UsersPage.jsx';
import OrgChartPage from '../pages/org-chart/OrgChartPage.jsx';
import AttendancePage from '../pages/attendance/AttendancePage.jsx';
import AttendanceReportPage from '../pages/attendance/AttendanceReportPage.jsx';
import LeavesPage from '../pages/leaves/LeavesPage.jsx';
import LeaveApprovalsPage from '../pages/leaves/LeaveApprovalsPage.jsx';
import ProjectsPage from '../pages/projects/ProjectsPage.jsx';
import ProjectDetailPage from '../pages/projects/ProjectDetailPage.jsx';
import TasksPage from '../pages/tasks/TasksPage.jsx';
import PayrollPage from '../pages/payroll/PayrollPage.jsx';
import MyPayslipsPage from '../pages/payroll/MyPayslipsPage.jsx';
import RecruitmentPage from '../pages/recruitment/RecruitmentPage';
import ExitProcessPage from '../pages/exit/ExitProcessPage';
import CompanyProfilePage from '../pages/company/CompanyProfilePage';
import SuperAdminDashboard from '../pages/admin/SuperAdminDashboard.jsx';
import NotFoundPage from '../pages/not-found/NotFoundPage.jsx';
import BillingPage from "../pages/billing/billingPage.jsx" ;
import AnalyticsPage from '../pages/analytics/AnalyticsPage';
import GovernancePage from "../pages/governance/GovernancePage.jsx"
import MyProfilePage from "../pages/profile/MyProfilePage.jsx"
import MyDocumentsPage from '../pages/documents/MyDocumentsPage';
import MeetingsPage from '../pages/meetings/MeetingsPage';
import AnnouncementsPage from '../pages/announcements/AnnouncementsPage';
import SupportPage from '../pages/support/SupportPage';
import NotificationsPage from '../pages/notifications/NotificationsPage';
import NotificationSettingsPage from '../pages/notifications/NotificationSettingsPage.jsx';



const SENIORS = ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'];
const HR = ['COMPANY_ADMIN', 'HR_MANAGER'];

const AppRoutes = () => {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterCompanyPage />} />
      </Route>

      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="departments" element={<DepartmentsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="org-chart" element={<OrgChartPage />} />
        <Route path="attendance" element={<AttendancePage />} />
        <Route path="attendance/report" element={<RequireRole roles={SENIORS}><AttendanceReportPage /></RequireRole>} />
        <Route path="leaves" element={<LeavesPage />} />
        <Route path="leaves/approvals" element={<RequireRole roles={SENIORS}><LeaveApprovalsPage /></RequireRole>} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="payroll" element={<RequireRole roles={HR}><PayrollPage /></RequireRole>} />
        <Route path="payslips" element={<MyPayslipsPage />} />
        <Route path="company" element={<CompanyProfilePage />} />
        <Route path="recruitment" element={<RecruitmentPage />} />
<Route path="exit" element={<ExitProcessPage />} />
<Route path="billing" element={<BillingPage />} />
<Route path="analytics" element={<AnalyticsPage />} />
<Route path="governance" element={<GovernancePage />} />
<Route path="profile" element={<MyProfilePage />} />
<Route path="documents" element={<MyDocumentsPage />} />
<Route path="meetings" element={<MeetingsPage />} />
<Route path="announcements" element={<AnnouncementsPage />} />
<Route path="support" element={<SupportPage />} />
<Route path="notifications" element={<NotificationsPage />} />

<Route path="notification-settings" element={<NotificationSettingsPage />} />
      </Route>

      <Route
        path="/admin"
        element={
          <RequireAuth>
            <RequireRole roles={['SUPER_ADMIN']}>
              <SuperAdminDashboard />
            </RequireRole>
          </RequireAuth>
        }
      />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
};

export default AppRoutes;