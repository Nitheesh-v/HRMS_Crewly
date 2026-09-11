import {
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import { Suspense, lazy } from "react";

import PublicLayout from "../layout/PublicLayout.jsx";
import AppLayout from "../layout/AppLayout.jsx";
import SuperAdminLayout from "../layout/SuperAdminLayout.jsx";
import CareerPublicLayout from "../layout/CareerPublicLayout.jsx";
const CareerLandingPage = lazy(() => import("../pages/careers/CareerLandingPage.jsx"));
const CareerJobsPage = lazy(() => import("../pages/careers/CareerJobsPage.jsx"));
const CareerJobDetailPage = lazy(() => import("../pages/careers/CareerJobDetailPage.jsx"));
const CareerApplyShellPage = lazy(() => import("../pages/careers/CareerApplyShellPage.jsx"));
import CandidateOfferPublicLayout from "../layout/CandidateOfferPublicLayout.jsx";
import CandidateBgvConsentPublicLayout from "../layout/CandidateBgvConsentPublicLayout.jsx";
const BgvVerifierLoginPage = lazy(() => import("../pages/bgvVerifier/BgvVerifierLoginPage.jsx"));
const BgvVerifierSetupPage = lazy(() => import("../pages/bgvVerifier/BgvVerifierSetupPage.jsx"));
const BgvVerifierForgotPage = lazy(() => import("../pages/bgvVerifier/BgvVerifierForgotPage.jsx"));
const BgvVerifierResetPage = lazy(() => import("../pages/bgvVerifier/BgvVerifierResetPage.jsx"));
const BgvVerifierDashboardPage = lazy(() => import("../pages/bgvVerifier/BgvVerifierDashboardPage.jsx"));
const BgvVerifierWorkPage = lazy(() => import("../pages/bgvVerifier/BgvVerifierWorkPage.jsx"));
const BgvVerifierCheckDetailPage = lazy(() => import("../pages/bgvVerifier/BgvVerifierCheckDetailPage.jsx"));
const CandidateBgvConsentPortalPage = lazy(() => import("../pages/candidate/CandidateBgvConsentPortalPage.jsx"));
const CandidateOfferPortalPage = lazy(() => import("../pages/candidate/CandidateOfferPortalPage.jsx"));
import CandidatePreOnboardingPublicLayout from "../layout/CandidatePreOnboardingPublicLayout.jsx";
const CandidatePreOnboardingPortalPage = lazy(() => import("../pages/candidate/CandidatePreOnboardingPortalPage.jsx"));

import RequireAuth from "./RequireAuth.jsx";
import RequireVerifierAuth from "./RequireVerifierAuth.jsx";
import RequirePermission from "./RequirePermission.jsx";
import RequireRole from "./RequireRole.jsx";

const LandingPage = lazy(() => import("../pages/landing/LandingPage.jsx"));
const LoginPage = lazy(() => import("../pages/login/LoginPage.jsx"));
const RegisterCompanyPage = lazy(() => import("../pages/register/RegisterCompanyPage.jsx"));

const ForgotPasswordPage = lazy(() => import("../pages/security/ForgotPasswordPage.jsx"));
const ResetPasswordPage = lazy(() => import("../pages/security/ResetPasswordPage.jsx"));
const ActiveSessionsPage = lazy(() => import("../pages/security/ActiveSessionsPage.jsx"));
const SecurityDashboardPage = lazy(() => import("../pages/security/SecurityDashboardPage.jsx"));
const AuditLogsPage = lazy(() => import("../pages/security/AuditLogsPage.jsx"));
const SecuritySettingsPage = lazy(() => import("../pages/security/SecuritySettingsPage.jsx"));

const DashboardPage = lazy(() => import("../pages/dashboard/DashboardPage.jsx"));
const DepartmentsPage = lazy(() => import("../pages/departments/DepartmentsPage.jsx"));
const UsersPage = lazy(() => import("../pages/users/UsersPage.jsx"));
const OrgChartPage = lazy(() => import("../pages/org-chart/OrgChartPage.jsx"));

const AttendancePage = lazy(() => import("../pages/attendance/AttendancePage.jsx"));
const AttendanceReportPage = lazy(() => import("../pages/attendance/AttendanceReportPage.jsx"));
const AttendancePolicyPage = lazy(() => import("../pages/attendance/AttendancePolicyPage.jsx"));

const LeavesPage = lazy(() => import("../pages/leaves/LeavesPage.jsx"));
const LeaveApprovalsPage = lazy(() => import("../pages/leaves/LeaveApprovalsPage.jsx"));

const ProjectsPage = lazy(() => import("../pages/projects/ProjectsPage.jsx"));
const ProjectDetailPage = lazy(() => import("../pages/projects/ProjectDetailPage.jsx"));
const TasksPage = lazy(() => import("../pages/tasks/TasksPage.jsx"));

const PayrollPage = lazy(() => import("../pages/payroll/PayrollPage.jsx"));
const PayrollSetupPage = lazy(() => import("../pages/payroll/PayrollSetupPage.jsx"));
const SalaryComponentsPage = lazy(() => import("../pages/payroll/SalaryComponentsPage.jsx"));
const SalaryStructuresPage = lazy(() => import("../pages/payroll/SalaryStructuresPage.jsx"));
const EmployeePayrollPage = lazy(() => import("../pages/payroll/EmployeePayrollPage.jsx"));
const MonthlyInputsPage = lazy(() => import("../pages/payroll/MonthlyInputsPage.jsx"));
const RunPayrollPage = lazy(() => import("../pages/payroll/RunPayrollPage.jsx"));
const ReviewPayrollPage = lazy(() => import("../pages/payroll/ReviewPayrollPage.jsx"));
const SalaryPaymentPage = lazy(() => import("../pages/payroll/SalaryPaymentPage.jsx"));
const PayslipsPage = lazy(() => import("../pages/payroll/PayslipsPage.jsx"));
const MyPayslipsPortalPage = lazy(() => import("../pages/payroll/MyPayslipsPortalPage.jsx"));
const StatutoryCompliancePage = lazy(() => import("../pages/payroll/StatutoryCompliancePage.jsx"));
// Phase 29.12 — Payroll Analytics & Reports (§26 — ten pages).
const ExecutiveDashboardPage = lazy(() => import("../pages/payroll/analytics/ExecutiveDashboardPage.jsx"));
const PayrollOverviewPage = lazy(() => import("../pages/payroll/analytics/PayrollOverviewPage.jsx"));
const DepartmentAnalyticsPage = lazy(() => import("../pages/payroll/analytics/DepartmentAnalyticsPage.jsx"));
const SalaryDistributionPage = lazy(() => import("../pages/payroll/analytics/SalaryDistributionPage.jsx"));
const PayrollTrendsPage = lazy(() => import("../pages/payroll/analytics/PayrollTrendsPage.jsx"));
const BonusReportPage = lazy(() => import("../pages/payroll/analytics/BonusReportPage.jsx"));
const OvertimeReportPage = lazy(() => import("../pages/payroll/analytics/OvertimeReportPage.jsx"));
const StatutorySummaryPage = lazy(() => import("../pages/payroll/analytics/StatutorySummaryPage.jsx"));
const EarningsReportPage = lazy(() => import("../pages/payroll/analytics/EarningsReportPage.jsx"));
const DeductionsReportPage = lazy(() => import("../pages/payroll/analytics/DeductionsReportPage.jsx"));
const EmployerContributionPage = lazy(() => import("../pages/payroll/analytics/EmployerContributionPage.jsx"));
const ReimbursementReportPage = lazy(() => import("../pages/payroll/analytics/ReimbursementReportPage.jsx"));
const FnfAnalyticsPage = lazy(() => import("../pages/payroll/analytics/FnfAnalyticsPage.jsx"));
const PayrollVariancePage = lazy(() => import("../pages/payroll/analytics/PayrollVariancePage.jsx"));
const SalaryHistoryPage = lazy(() => import("../pages/payroll/analytics/SalaryHistoryPage.jsx"));
const PayrollRegisterPage = lazy(() => import("../pages/payroll/analytics/PayrollRegisterPage.jsx"));
const ScheduledReportsPage = lazy(() => import("../pages/payroll/analytics/ScheduledReportsPage.jsx"));
const FinalSettlementPage = lazy(() => import("../pages/payroll/FinalSettlementPage.jsx"));
const MyFinalSettlementPage = lazy(() => import("../pages/payroll/MyFinalSettlementPage.jsx"));
const EmployeePayrollDetailPage = lazy(() => import("../pages/payroll/EmployeePayrollDetailPage.jsx"));
const MyPayslipsPage = lazy(() => import("../pages/payroll/MyPayslipsPage.jsx"));

const RecruitmentPage = lazy(() => import("../pages/recruitment/RecruitmentPage.jsx"));
const RecruitmentDashboardPage = lazy(() => import("../pages/recruitment/RecruitmentDashboardPage.jsx"));
const BackgroundVerificationPage = lazy(() => import("../pages/recruitment/BackgroundVerificationPage.jsx"));
const BackgroundVerificationDetailPage = lazy(() => import("../pages/recruitment/BackgroundVerificationDetailPage.jsx"));
const BackgroundVerificationSettingsPage = lazy(() => import("../pages/recruitment/BackgroundVerificationSettingsPage.jsx"));
const CandidateDetailPage = lazy(() => import("../pages/recruitment/CandidateDetailPage.jsx"));
const CandidateInboxPage = lazy(() => import("../pages/recruitment/CandidateInboxPage.jsx"));
const RequisitionApprovalsPage = lazy(() => import("../pages/recruitment/RequisitionApprovalsPage.jsx"));
const RequisitionsPage = lazy(() => import("../pages/recruitment/RequisitionsPage.jsx"));
const InterviewsPage = lazy(() => import("../pages/recruitment/InterviewsPage.jsx"));
const MyInterviewsPage = lazy(() => import("../pages/recruitment/MyInterviewsPage.jsx"));
const OffersPage = lazy(() => import("../pages/recruitment/OffersPage.jsx"));
const OfferDetailPage = lazy(() => import("../pages/recruitment/OfferDetailPage.jsx"));
const OfferTemplatesPage = lazy(() => import("../pages/recruitment/OfferTemplatesPage.jsx"));
const PreOnboardingPage = lazy(() => import("../pages/recruitment/PreOnboardingPage.jsx"));
const PreOnboardingDetailPage = lazy(() => import("../pages/recruitment/PreOnboardingDetailPage.jsx"));
const PreOnboardingRequirementsPage = lazy(() => import("../pages/recruitment/PreOnboardingRequirementsPage.jsx"));
const ConvertToEmployeePage = lazy(() => import("../pages/recruitment/ConvertToEmployeePage.jsx"));
const ExitProcessPage = lazy(() => import("../pages/exit/ExitProcessPage.jsx"));

const CompanyProfilePage = lazy(() => import("../pages/company/CompanyProfilePage.jsx"));

import BillingPage from  "../pages/billing/BillingPage.jsx"
const SubscriptionPage = lazy(() => import("../pages/billing/SubscriptionPage.jsx"));

const GovernancePage = lazy(() => import("../pages/governance/GovernancePage.jsx"));
const RolesPermissionsPage = lazy(() => import("../pages/settings/RolesPermissionsPage.jsx"));

const MyProfilePage = lazy(() => import("../pages/profile/MyProfilePage.jsx"));
const MyDocumentsPage = lazy(() => import("../pages/documents/MyDocumentsPage.jsx"));
const EmployeeFilesPage = lazy(() => import("../pages/documents/EmployeeFilesPage.jsx"));

const MeetingsPage = lazy(() => import("../pages/meetings/MeetingsPage.jsx"));
const AnnouncementsPage = lazy(() => import("../pages/announcements/AnnouncementsPage.jsx"));
const SupportPage = lazy(() => import("../pages/support/SupportPage.jsx"));

const NotificationsPage = lazy(() => import("../pages/notifications/NotificationsPage.jsx"));
const NotificationSettingsPage = lazy(() => import("../pages/notifications/NotificationSettingsPage.jsx"));

const LifecyclePage = lazy(() => import("../pages/lifecycle/LifecyclePage.jsx"));
const PerformancePage = lazy(() => import("../pages/performance/PerformancePage.jsx"));
const ExpensesPage = lazy(() => import("../pages/expenses/ExpensesPage.jsx"));
const AssetsPage = lazy(() => import("../pages/assets/AssetsPage.jsx"));

const HolidaysPage = lazy(() => import("../pages/schedule/HolidaysPage.jsx"));
const ShiftsPage = lazy(() => import("../pages/schedule/ShiftsPage.jsx"));
const SchedulesPage = lazy(() => import("../pages/schedule/SchedulesPage.jsx"));

const AnalyticsHubPage = lazy(() => import("../pages/analytics/AnalyticsHubPage.jsx"));
const ReportBuilderPage = lazy(() => import("../pages/analytics/ReportBuilderPage.jsx"));

const SuperAdminAuthPage = lazy(() => import("../pages/admin/SuperAdminAuthPage.jsx"));
const SuperAdminDashboardPage = lazy(() => import("../pages/admin/SuperAdminDashboardPage.jsx"));
const SuperAdminCompaniesPage = lazy(() => import("../pages/admin/SuperAdminCompaniesPage.jsx"));
const SuperAdminCompanyDetailPage = lazy(() => import("../pages/admin/SuperAdminCompanyDetailPage.jsx"));
const SuperAdminCommercePage = lazy(() => import("../pages/admin/SuperAdminCommercePage.jsx"));
const SuperAdminOperationsPage = lazy(() => import("../pages/admin/SuperAdminOperationsPage.jsx"));
const SuperAdminBackgroundOperationsPage = lazy(() => import("../pages/admin/SuperAdminBackgroundOperationsPage.jsx"));
const SuperAdminBgvVerifiersPage = lazy(() => import("../pages/admin/SuperAdminBgvVerifiersPage.jsx"));
const SuperAdminBgvOperationsPage = lazy(() => import("../pages/admin/SuperAdminBgvOperationsPage.jsx"));
const SuperAdminBgvQaPage = lazy(() => import("../pages/admin/SuperAdminBgvQaPage.jsx"));
const SuperAdminBgvBillingPage = lazy(() => import("../pages/admin/SuperAdminBgvBillingPage.jsx"));
const SuperAdminBgvOpsDashboardPage = lazy(() => import("../pages/admin/SuperAdminBgvOpsDashboardPage.jsx"));
const SuperAdminBgvCataloguePage = lazy(() => import("../pages/admin/SuperAdminBgvCataloguePage.jsx"));

const NotFoundPage = lazy(() => import("../pages/not-found/NotFoundPage.jsx"));

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
  <Suspense fallback={<div className="p-6 text-crewly-dim">Loading…</div>}>
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

    {/* Phase 30.6 — dedicated internal BGV verifier portal (separate
        security domain: not tenant HRMS, not Super Admin). */}
    <Route path="/bgv-verifier/login" element={<BgvVerifierLoginPage />} />
    <Route path="/bgv-verifier/setup/:setupToken" element={<BgvVerifierSetupPage />} />
    <Route path="/bgv-verifier/forgot-password" element={<BgvVerifierForgotPage />} />
    <Route path="/bgv-verifier/reset-password/:resetToken" element={<BgvVerifierResetPage />} />
    <Route
      path="/bgv-verifier/work/:orderId/:checkType"
      element={
        <RequireVerifierAuth>
          <BgvVerifierCheckDetailPage />
        </RequireVerifierAuth>
      }
    />
    <Route
      path="/bgv-verifier/work"
      element={
        <RequireVerifierAuth>
          <BgvVerifierWorkPage />
        </RequireVerifierAuth>
      }
    />
    <Route
      path="/bgv-verifier"
      element={
        <RequireVerifierAuth>
          <BgvVerifierDashboardPage />
        </RequireVerifierAuth>
      }
    />

    {/* Public candidate BGV consent portal — secure token authority only */}
    <Route path="/candidate/bgv-consent" element={<CandidateBgvConsentPublicLayout />}>
      <Route path=":secureToken" element={<CandidateBgvConsentPortalPage />} />
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

      {/* Phase 31.1 — Attendance Policy (permission-gated inside the page,
          like the payroll setup pages: no role-name gate here) */}
      <Route
        path="attendance/policy"
        element={<AttendancePolicyPage />}
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
      {/* Phase 29.11 — Final Settlement (F&F): HR/Finance workspace + employee portal. */}
      <Route path="payroll/final-settlement" element={<FinalSettlementPage />} />
      <Route path="payroll/my-final-settlement" element={<MyFinalSettlementPage />} />
      {/* Phase 29.12 — Payroll Analytics & Reports. Each page gates itself
          on the payroll report permissions (§4 / §25); the CTC block is
          additionally gated on PAYROLL_ANALYTICS_FINANCIAL (§16). */}
      <Route path="payroll/analytics" element={<ExecutiveDashboardPage />} />
      <Route path="payroll/analytics/overview" element={<PayrollOverviewPage />} />
      <Route path="payroll/analytics/department" element={<DepartmentAnalyticsPage />} />
      <Route path="payroll/analytics/salary-distribution" element={<SalaryDistributionPage />} />
      <Route path="payroll/analytics/trends" element={<PayrollTrendsPage />} />
      <Route path="payroll/analytics/bonus" element={<BonusReportPage />} />
      <Route path="payroll/analytics/overtime" element={<OvertimeReportPage />} />
      <Route path="payroll/analytics/statutory" element={<StatutorySummaryPage />} />
      {/* 29.13 — the six reports added in this phase (§11, §12, §13, §18, §20,
          §21) and the employee salary history (§23). */}
      <Route path="payroll/analytics/earnings" element={<EarningsReportPage />} />
      <Route path="payroll/analytics/deductions" element={<DeductionsReportPage />} />
      <Route path="payroll/analytics/employer" element={<EmployerContributionPage />} />
      <Route path="payroll/analytics/reimbursement" element={<ReimbursementReportPage />} />
      <Route path="payroll/analytics/fnf" element={<FnfAnalyticsPage />} />
      <Route path="payroll/analytics/variance" element={<PayrollVariancePage />} />
      <Route path="payroll/analytics/salary-history/:employeeId" element={<SalaryHistoryPage />} />
      <Route path="payroll/analytics/register" element={<PayrollRegisterPage />} />
      <Route path="payroll/analytics/scheduled" element={<ScheduledReportsPage />} />
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

      {/* Phase 30.2 — platform BGV catalogue & pricing. */}
      <Route
        path="bgv-services"
        element={
          <SuperAdminBgvCataloguePage />
        }
      />

      {/* Phase 30.6 — internal BGV verifier account management. */}
      <Route
        path="bgv-verifiers"
        element={
          <SuperAdminBgvVerifiersPage />
        }
      />

      {/* Phase 30.7 — BGV check assignment operations (platform-only). */}
      <Route
        path="bgv-operations"
        element={
          <SuperAdminBgvOperationsPage />
        }
      />

      {/* Phase 30.12 — BGV billing reporting (read-only snapshots). */}
      <Route
        path="bgv-billing"
        element={
          <SuperAdminBgvBillingPage />
        }
      />

      {/* Phase 30.10 — internal BGV QA review + final report release. */}
      <Route
        path="bgv-qa"
        element={
          <SuperAdminBgvQaPage />
        }
      />

      {/* Phase 30.11 — internal BGV operations dashboard (derived counts,
          drill-down queues, verifier workload, SLA configuration). */}
      <Route
        path="bgv-ops"
        element={
          <SuperAdminBgvOpsDashboardPage />
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
  </Suspense>
);

export default AppRoutes;