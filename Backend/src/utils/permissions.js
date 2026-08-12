// ─────────────────────────────────────────────────────────────
// Role permission matrix — mirrors REAL backend enforcement.
// Rendered as a checkmark grid on the Governance page.
// ─────────────────────────────────────────────────────────────
import { ROLES } from './constants.js';

const ALL = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE];
const SENIORS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD];
const HR = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

export const PERMISSION_MATRIX = [
  { feature: 'Dashboard & own widgets', roles: ALL },
  { feature: 'Punch in / out & own attendance', roles: ALL },
  { feature: 'Attendance reports (team/company)', roles: SENIORS },
  { feature: 'Apply & cancel own leave', roles: ALL },
  { feature: 'Approve / reject leaves', roles: SENIORS },
  { feature: 'Departments management', roles: HR },
  { feature: 'Create users (per creation rights)', roles: SENIORS },
  { feature: 'Reset user passwords', roles: SENIORS },
  { feature: 'Projects & tasks', roles: SENIORS },
  { feature: 'Salary structures & payroll run', roles: HR },
  { feature: 'View own payslips', roles: ALL },
  { feature: 'Recruitment (jobs & pipeline)', roles: HR },
  { feature: 'Submit own resignation', roles: ALL },
  { feature: 'Exit approvals', roles: HR },
  { feature: 'Analytics', roles: HR },
  { feature: 'Audit logs & this matrix', roles: HR },
  { feature: 'Company profile & billing', roles: [ROLES.COMPANY_ADMIN] },
];