import {
  Navigate,
  Route,
  Routes,
} from "react-router-dom";

import PublicLayout from "../layout/PublicLayout.jsx";
import AppLayout from "../layout/AppLayout.jsx";
import SuperAdminLayout from "../layout/SuperAdminLayout.jsx";
import CareerPublicLayout from "../layout/CareerPublicLayout.jsx";
import CareerLandingPage from "../pages/careers/CareerLandingPage.jsx";
import CareerJobsPage from "../pages/careers/CareerJobsPage.jsx";
import CareerJobDetailPage from "../pages/careers/CareerJobDetailPage.jsx";
import CareerApplyShellPage from "../pages/careers/CareerApplyShellPage.jsx";
import CandidateOfferPublicLayout from "../layout/CandidateOfferPublicLayout.jsx";
import CandidateOfferPortalPage from "../pages/candidate/CandidateOfferPortalPage.jsx";
import CandidatePreOnboardingPublicLayout from "../layout/CandidatePreOnboardingPublicLayout.jsx";
import CandidatePreOnboardingPortalPage from "../pages/candidate/CandidatePreOnboardingPortalPage.jsx";

import RequireAuth from "./RequireAuth.jsx";
import RequirePermission from "./RequirePermission.jsx";
import RequireRole from "./RequireRole.jsx";

import LandingPage from "../pages/landing/LandingPage.jsx";
import LoginPage from "../pages/login/LoginPage.jsx";
import RegisterCompanyPage from "../pages/register/RegisterCompanyPage.jsx";

import ForgotPasswordPage from "../pages/security/ForgotPasswordPage.jsx";
import ResetPasswordPage from "../pages/security/ResetPasswordPage.jsx";
import ActiveSessionsPage from "../pages/security/ActiveSessionsPage.jsx";
import SecurityDashboardPage from "../pages/security/SecurityDashboardPage.jsx";
import AuditLogsPage from "../pages/security/AuditLogsPage.jsx";
import SecuritySettingsPage from "../pages/security/SecuritySettingsPage.jsx";

import DashboardPage from "../pages/dashboard/DashboardPage.jsx";
import DepartmentsPage from "../pages/departments/DepartmentsPage.jsx";
import UsersPage from "../pages/users/UsersPage.jsx";
import OrgChartPage from "../pages/org-chart/OrgChartPage.jsx";

import AttendancePage from "../pages/attendance/AttendancePage.jsx";
import AttendanceReportPage from "../pages/attendance/AttendanceReportPage.jsx";

import LeavesPage from "../pages/leaves/LeavesPage.jsx";
import LeaveApprovalsPage from "../pages/leaves/LeaveApprovalsPage.jsx";

import ProjectsPage from "../pages/projects/ProjectsPage.jsx";
import ProjectDetailPage from "../pages/projects/ProjectDetailPage.jsx";
import TasksPage from "../pages/tasks/TasksPage.jsx";

import PayrollPage from "../pages/payroll/PayrollPage.jsx";
import PayrollSetupPage from "../pages/payroll/PayrollSetupPage.jsx";
import SalaryComponentsPage from "../pages/payroll/SalaryComponentsPage.jsx";
import SalaryStructuresPage from "../pages/payroll/SalaryStructuresPage.jsx";
import EmployeePayrollPage from "../pages/payroll/EmployeePayrollPage.jsx";
import MonthlyInputsPage from "../pages/payroll/MonthlyInputsPage.jsx";
import RunPayrollPage from "../pages/payroll/RunPayrollPage.jsx";
import ReviewPayrollPage from "../pages/payroll/ReviewPayrollPage.jsx";
import SalaryPaymentPage from "../pages/payroll/SalaryPaymentPage.jsx";
import PayslipsPage from "../pages/payroll/PayslipsPage.jsx";
import MyPayslipsPortalPage from "../pages/payroll/MyPayslipsPortalPage.jsx";
import StatutoryCompliancePage from "../pages/payroll/StatutoryCompliancePage.jsx";
import EmployeePayrollDetailPage from "../pages/payroll/EmployeePayrollDetailPage.jsx";
import MyPayslipsPage from "../pages/payroll/MyPayslipsPage.jsx";

import RecruitmentPage from "../pages/recruitment/RecruitmentPage.jsx";
import RecruitmentDashboardPage from "../pages/recruitment/RecruitmentDashboardPage.jsx";
import BackgroundVerificationPage from "../pages/recruitment/BackgroundVerificationPage.jsx";
import BackgroundVerificationDetailPage from "../pages/recruitment/BackgroundVerificationDetailPage.jsx";
import BackgroundVerificationSettingsPage from "../pages/recruitment/BackgroundVerificationSettingsPage.jsx";
import CandidateDetailPage from "../pages/recruitment/CandidateDetailPage.jsx";
import CandidateInboxPage from "../pages/recruitment/CandidateInboxPage.jsx";
import RequisitionApprovalsPage from "../pages/recruitment/RequisitionApprovalsPage.jsx";
import RequisitionsPage from "../pages/recruitment/RequisitionsPage.jsx";
import InterviewsPage from "../pages/recruitment/InterviewsPage.jsx";
import MyInterviewsPage from "../pages/recruitment/MyInterviewsPage.jsx";
import OffersPage from "../pages/recruitment/OffersPage.jsx";
import OfferDetailPage from "../pages/recruitment/OfferDetailPage.jsx";
import OfferTemplatesPage from "../pages/recruitment/OfferTemplatesPage.jsx";
import PreOnboardingPage from "../pages/recruitment/PreOnboardingPage.jsx";
import PreOnboardingDetailPage from "../pages/recruitment/PreOnboardingDetailPage.jsx";
import PreOnboardingRequirementsPage from "../pages/recruitment/PreOnboardingRequirementsPage.jsx";
import ConvertToEmployeePage from "../pages/recruitment/ConvertToEmployeePage.jsx";
import ExitProcessPage from "../pages/exit/ExitProcessPage.jsx";

import CompanyProfilePage from "../pages/company/CompanyProfilePage.jsx";

import BillingPage from  "../pages/billing/BillingPage.jsx"
import SubscriptionPage from "../pages/billing/SubscriptionPage.jsx";

import GovernancePage from "../pages/governance/GovernancePage.jsx";
import RolesPermissionsPage from "../pages/settings/RolesPermissionsPage.jsx";

import MyProfilePage from "../pages/profile/MyProfilePage.jsx";
import MyDocumentsPage from "../pages/documents/MyDocumentsPage.jsx";
import EmployeeFilesPage from "../pages/documents/EmployeeFilesPage.jsx";

import MeetingsPage from "../pages/meetings/MeetingsPage.jsx";
import AnnouncementsPage from "../pages/announcements/AnnouncementsPage.jsx";
import SupportPage from "../pages/support/SupportPage.jsx";

import NotificationsPage from "../pages/notifications/NotificationsPage.jsx";
import NotificationSettingsPage from "../pages/notifications/NotificationSettingsPage.jsx";

import LifecyclePage from "../pages/lifecycle/LifecyclePage.jsx";
import PerformancePage from "../pages/performance/PerformancePage.jsx";
import ExpensesPage from "../pages/expenses/ExpensesPage.jsx";
import AssetsPage from "../pages/assets/AssetsPage.jsx";

import HolidaysPage from "../pages/schedule/HolidaysPage.jsx";
import ShiftsPage from "../pages/schedule/ShiftsPage.jsx";
import SchedulesPage from "../pages/schedule/SchedulesPage.jsx";

import AnalyticsHubPage from "../pages/analytics/AnalyticsHubPage.jsx";
import ReportBuilderPage from "../pages/analytics/ReportBuilderPage.jsx";

import SuperAdminAuthPage from "../pages/admin/SuperAdminAuthPage.jsx";
import SuperAdminDashboardPage from "../pages/admin/SuperAdminDashboardPage.jsx";
import SuperAdminCompaniesPage from "../pages/admin/SuperAdminCompaniesPage.jsx";
import SuperAdminCompanyDetailPage from "../pages/admin/SuperAdminCompanyDetailPage.jsx";
import SuperAdminCommercePage from "../pages/admin/SuperAdminCommercePage.jsx";
import SuperAdminOperationsPage from "../pages/admin/SuperAdminOperationsPage.jsx";
import SuperAdminBackgroundOperationsPage from "../pages/admin/SuperAdminBackgroundOperationsPage.jsx";

import NotFoundPage from "../pages/not-found/NotFoundPage.jsx";

const PLATFORM_ROLES = [
  "SUPER_ADMIN",
  "PLATFORM_ADMIN",
  "SUPPORT_ADMIN",
  "BILLING_ADMIN",
];

const TENANT_ROLES = [
  "COMPANY_ADMIN",
  "HR_MANAGER",
  "MANAGER",
  "TEAM_LEAD",
  "EMPLOYEE",
];

const SENIORS = [
  "COMPANY_ADMIN",
  "HR_MANAGER",
  "MANAGER",
  "TEAM_LEAD",
];

const HR = [
  "COMPANY_ADMIN",
  "HR_MANAGER",
];

const COMPANY_ADMIN = [
  "COMPANY_ADMIN",
];

const AppRoutes = () => (
  <Routes>
    {/* Public customer routes */}
    <Route element={<PublicLayout />}>
      <Route
        path="/"
        element={<LandingPage />}
      />

      <Route
        path="/login"
        element={<LoginPage />}
      />

      <Route
        path="/register"
        element={<RegisterCompanyPage />}
      />

      <Route
        path="/forgot-password"
        element={<ForgotPasswordPage />}
      />

      <Route
        path="/reset-password"
        element={<ResetPasswordPage />}
      />

      <Route
        path="/setup-account"
        element={<ResetPasswordPage />}
      />
    </Route>

    {/* Public company career portal — no tenant auth or application layout */}
    <Route
      path="/careers/:companySlug"
      element={<CareerPublicLayout />}
    >
      <Route
        index
        element={<CareerLandingPage />}
      />
      <Route
        path="jobs"
        element={<CareerJobsPage />}
      />
      <Route
        path="jobs/:jobCode"
        element={<CareerJobDetailPage />}
      />
      <Route
        path="jobs/:jobCode/apply"
        element={<CareerApplyShellPage />}
      />
    </Route>

    {/* Public candidate offer portal — secure token authority, no employee session */}
    <Route path="/candidate/offer" element={<CandidateOfferPublicLayout />}>
      <Route path=":secureToken" element={<CandidateOfferPortalPage />} />
    </Route>

    {/* Public candidate pre-onboarding portal — secure token authority only */}
    <Route
      path="/candidate/pre-onboarding"
      element={<CandidatePreOnboardingPublicLayout />}
    >
      <Route path=":secureToken" element={<CandidatePreOnboardingPortalPage />} />
    </Route>

    {/* Public Super Admin authentication */}
    <Route
      path="/super-admin/login"
      element={<SuperAdminAuthPage />}
    />

    <Route
      path="/super-admin/forgot-password"
      element={<SuperAdminAuthPage />}
    />

    <Route
      path="/super-admin/reset-password"
      element={<SuperAdminAuthPage />}
    />

    {/* Tenant application */}
    <Route
      path="/app"
      element={
        <RequireAuth>
          <RequireRole roles={TENANT_ROLES}>
            <AppLayout />
          </RequireRole>
        </RequireAuth>
      }
    >
      <Route
        index
        element={<DashboardPage />}
      />

      {/* Phase 22 — account security */}
      <Route
        path="security/sessions"
        element={<ActiveSessionsPage />}
      />

      <Route
        path="security"
        element={
          <RequireRole roles={HR}>
            <SecurityDashboardPage />
          </RequireRole>
        }
      />

      <Route
        path="audit-logs"
        element={
          <RequireRole roles={HR}>
            <AuditLogsPage />
          </RequireRole>
        }
      />

      <Route
        path="security/settings"
        element={
          <RequireRole roles={COMPANY_ADMIN}>
            <SecuritySettingsPage />
          </RequireRole>
        }
      />

      {/* Organization */}
      <Route
        path="departments"
        element={<DepartmentsPage />}
      />

      <Route
        path="users"
        element={<UsersPage />}
      />

      <Route
        path="org-chart"
        element={<OrgChartPage />}
      />

      {/* Attendance */}
      <Route
        path="attendance"
        element={<AttendancePage />}
      />

      <Route
        path="attendance/report"
        element={
          <RequireRole roles={SENIORS}>
            <AttendanceReportPage />
          </RequireRole>
        }
      />

      {/* Leave management */}
      <Route
        path="leaves"
        element={<LeavesPage />}
      />

      <Route
        path="leaves/approvals"
        element={
          <RequireRole roles={SENIORS}>
            <LeaveApprovalsPage />
          </RequireRole>
        }
      />

      {/* Projects and tasks */}
      <Route
        path="projects"
        element={<ProjectsPage />}
      />

      <Route
        path="projects/:id"
        element={<ProjectDetailPage />}
      />

      <Route
        path="tasks"
        element={<TasksPage />}
      />

      {/* Payroll */}
      <Route
        path="payroll"
        element={
          <RequireRole roles={HR}>
            <PayrollPage />
          </RequireRole>
        }
      />

      {/* Phase 29.1 — Company Payroll Setup.
          Access follows PERMISSIONS (PAYROLL_SETUP_*), not the Company Admin
          role: the page shows its own permission message and the backend
          enforces the same rule. A role-name gate here would lock out every
          delegated payroll role the company creates. */}
      <Route path="payroll/setup" element={<PayrollSetupPage />} />
      {/* Phase 29.2 — Salary Components (permission-gated inside the page) */}
      <Route path="payroll/components" element={<SalaryComponentsPage />} />
      <Route path="payroll/structures" element={<SalaryStructuresPage />} />
      {/* Phase 29.5 — Monthly Payroll Inputs (permission-gated inside the page) */}
      <Route path="payroll/inputs" element={<MonthlyInputsPage />} />
      {/* Phase 29.6 — Payroll Calculation Engine (permission-gated inside the page) */}
      <Route path="payroll/run" element={<RunPayrollPage />} />
      {/* Phase 29.7 — Payroll Review & Approval (permission-gated inside the page) */}
      <Route path="payroll/review" element={<ReviewPayrollPage />} />
      {/* Phase 29.8 — Salary Payment: prepare the bank transfer file. */}
      <Route path="payroll/salary-payment" element={<SalaryPaymentPage />} />
      {/* Phase 29.9 — Payslips: admin workspace + employee salary portal. */}
      <Route path="payroll/payslips" element={<PayslipsPage />} />
      <Route path="payroll/my-payslips" element={<MyPayslipsPortalPage />} />
      <Route path="payroll/statutory" element={<StatutoryCompliancePage />} />
      <Route path="payroll/employees" element={<EmployeePayrollPage />} />
      <Route path="payroll/employees/:employeeId" element={<EmployeePayrollDetailPage />} />

      <Route
        path="payslips"
        element={<MyPayslipsPage />}
      />

      {/* Company and subscription */}
      <Route
        path="company"
        element={<CompanyProfilePage />}
      />

      <Route
        path="billing"
        element={<BillingPage />}
      />

      <Route
        path="subscription"
        element={
          <RequireRole roles={HR}>
            <SubscriptionPage />
          </RequireRole>
        }
      />

      {/* Recruitment and exit */}
      <Route
        path="recruitment"
        element={
          <RequirePermission permission="RECRUITMENT_ANALYTICS_READ">
            <RecruitmentDashboardPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/requisitions"
        element={
          <RequireRole roles={SENIORS}>
            <RequisitionsPage />
          </RequireRole>
        }
      />

      <Route
        path="recruitment/approvals"
        element={
          <RequireRole roles={HR}>
            <RequirePermission
              any={[
                "REQUISITION_APPROVE",
                "REQUISITION_REJECT",
                "REQUISITION_SEND_BACK",
              ]}
            >
              <RequisitionApprovalsPage />
            </RequirePermission>
          </RequireRole>
        }
      />

      <Route
        path="recruitment/candidates"
        element={
          <RequirePermission permission="CANDIDATE_READ">
            <CandidateInboxPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/candidates/:candidateRef"
        element={
          <RequirePermission permission="CANDIDATE_READ">
            <CandidateDetailPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/candidates/:candidateRef/convert"
        element={
          <RequirePermission permission="CANDIDATE_CONVERT">
            <ConvertToEmployeePage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/offers"
        element={
          <RequirePermission permission="OFFER_READ">
            <OffersPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/offers/:offerId"
        element={
          <RequirePermission permission="OFFER_READ">
            <OfferDetailPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/offer-templates"
        element={
          <RequirePermission permission="OFFER_TEMPLATE_READ">
            <OfferTemplatesPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/pre-onboarding"
        element={
          <RequirePermission permission="PRE_ONBOARDING_READ">
            <PreOnboardingPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/pre-onboarding/requirements"
        element={
          <RequirePermission permission="PRE_ONBOARDING_SETTINGS_READ">
            <PreOnboardingRequirementsPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/pre-onboarding/:preOnboardingId"
        element={
          <RequirePermission permission="PRE_ONBOARDING_READ">
            <PreOnboardingDetailPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/background-verification"
        element={
          <RequirePermission permission="BACKGROUND_VERIFICATION_READ">
            <BackgroundVerificationPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/background-verification/settings"
        element={
          <RequirePermission permission="BACKGROUND_VERIFICATION_SETTINGS_READ">
            <BackgroundVerificationSettingsPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/background-verification/:caseId"
        element={
          <RequirePermission permission="BACKGROUND_VERIFICATION_READ">
            <BackgroundVerificationDetailPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/interviews"
        element={
          <RequirePermission permission="INTERVIEW_READ">
            <InterviewsPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/my-interviews"
        element={
          <RequirePermission permission="INTERVIEW_READ_SELF">
            <MyInterviewsPage />
          </RequirePermission>
        }
      />

      <Route
        path="recruitment/legacy"
        element={
          <RequireRole roles={HR}>
            <RecruitmentPage />
          </RequireRole>
        }
      />

      <Route
        path="exit"
        element={<ExitProcessPage />}
      />

      {/* Analytics */}
      <Route
        path="analytics"
        element={<AnalyticsHubPage />}
      />

      <Route
        path="reports"
        element={
          <RequireRole roles={SENIORS}>
            <ReportBuilderPage />
          </RequireRole>
        }
      />

      {/* Governance and RBAC */}
      <Route
        path="governance"
        element={<GovernancePage />}
      />

      <Route
        path="roles-permissions"
        element={
          <RequireRole roles={COMPANY_ADMIN}>
            <RolesPermissionsPage />
          </RequireRole>
        }
      />

      {/* Employee profile and documents */}
      <Route
        path="profile"
        element={<MyProfilePage />}
      />

      <Route
        path="documents"
        element={<MyDocumentsPage />}
      />

      <Route
        path="employee-files"
        element={
          <RequireRole roles={HR}>
            <EmployeeFilesPage />
          </RequireRole>
        }
      />

      {/* HR operations */}
      <Route
        path="lifecycle"
        element={<LifecyclePage />}
      />

      <Route
        path="performance"
        element={<PerformancePage />}
      />

      <Route
        path="expenses"
        element={<ExpensesPage />}
      />

      <Route
        path="assets"
        element={<AssetsPage />}
      />

      {/* Scheduling */}
      <Route
        path="holidays"
        element={<HolidaysPage />}
      />

      <Route
        path="shifts"
        element={<ShiftsPage />}
      />

      <Route
        path="schedules"
        element={
          <RequireRole roles={HR}>
            <SchedulesPage />
          </RequireRole>
        }
      />

      {/* Collaboration */}
      <Route
        path="meetings"
        element={<MeetingsPage />}
      />

      <Route
        path="announcements"
        element={<AnnouncementsPage />}
      />

      <Route
        path="support"
        element={<SupportPage />}
      />

      <Route
        path="notifications"
        element={<NotificationsPage />}
      />

      <Route
        path="notification-settings"
        element={<NotificationSettingsPage />}
      />
    </Route>

    {/* Super Admin application */}
    <Route
      path="/super-admin"
      element={
        <RequireAuth redirectTo="/super-admin/login">
          <RequireRole roles={PLATFORM_ROLES}>
            <SuperAdminLayout />
          </RequireRole>
        </RequireAuth>
      }
    >
      <Route
        index
        element={
          <Navigate
            to="dashboard"
            replace
          />
        }
      />

      <Route
        path="dashboard"
        element={<SuperAdminDashboardPage />}
      />

      <Route
        path="companies"
        element={<SuperAdminCompaniesPage />}
      />

      <Route
        path="companies/:companyId"
        element={<SuperAdminCompanyDetailPage />}
      />

      <Route
        path="users"
        element={
          <SuperAdminOperationsPage mode="users" />
        }
      />

      <Route
        path="subscriptions"
        element={
          <SuperAdminCommercePage mode="subscriptions" />
        }
      />

      <Route
        path="plans"
        element={
          <SuperAdminCommercePage mode="plans" />
        }
      />

      <Route
        path="billing"
        element={
          <SuperAdminCommercePage mode="billing" />
        }
      />

      <Route
        path="revenue"
        element={
          <SuperAdminCommercePage mode="revenue" />
        }
      />

      <Route
        path="usage"
        element={
          <SuperAdminOperationsPage mode="usage" />
        }
      />

      <Route
        path="support"
        element={
          <SuperAdminOperationsPage mode="support" />
        }
      />

      <Route
        path="system-health"
        element={
          <SuperAdminOperationsPage mode="system-health" />
        }
      />

      <Route
        path="background-operations"
        element={<SuperAdminBackgroundOperationsPage />}
      />

      <Route
        path="audit-logs"
        element={
          <SuperAdminOperationsPage mode="audit-logs" />
        }
      />

      <Route
        path="settings"
        element={
          <SuperAdminOperationsPage mode="settings" />
        }
      />
    </Route>

    {/* Legacy redirects */}
    <Route
      path="/admin"
      element={
        <Navigate
          to="/super-admin/dashboard"
          replace
        />
      }
    />

    <Route
      path="/admin/analytics"
      element={
        <Navigate
          to="/super-admin/dashboard"
          replace
        />
      }
    />

    {/* Global fallback */}
    <Route
      path="*"
      element={<NotFoundPage />}
    />
  </Routes>
);

export default AppRoutes;