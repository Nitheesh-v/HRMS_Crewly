export const RESOURCES = [
  "EMPLOYEE",
  "USER",
  "ASSET",
  "LIFECYCLE",
  "DEPARTMENT",
  "ATTENDANCE",
  "LEAVE",
  "PAYROLL",
  "PAYSLIP",
  "RECRUITMENT",
  "REQUISITION",
  "CANDIDATE",
  "INTERVIEW",
  "INTERVIEW_FEEDBACK",
  "OFFER",
  "OFFER_TEMPLATE",
  "PRE_ONBOARDING",
  "PRE_ONBOARDING_DOCUMENT",
  "PRE_ONBOARDING_SETTINGS",
  "REPORT",
  "DOCUMENT",
  "PROJECT",
  "TASK",
  "MEETING",
  "EXPENSE",
  "PERFORMANCE",
  "SETTINGS",
  "ANNOUNCEMENT",
  "HOLIDAY",
  "SHIFT",
  "SUPPORT",
  "PROFILE",
  "RESIGNATION",
];

export const ACTIONS = [
  "READ",
  "CREATE",
  "UPDATE",
  "DELETE",
  "APPROVE",
  "REJECT",
  "EXPORT",
  "IMPORT",
  "MANAGE",
  "SUBMIT",
  "SEND_BACK",
  "FINAL_DECISION",
  "RETURN",
  "SEND",
  "WITHDRAW",
  "VERIFY",
  "READY",
  "CONVERT",
];

const actions = (resource, actionList, scope = "ALL") =>
  actionList.map((action) => ({
    name:
      scope === "ALL"
        ? `${resource}_${action}`
        : `${resource}_${action}_${scope}`,

    resource,
    action,
    scope,

    group: resource,

    description: `${action.toLowerCase()} ` + `${resource.toLowerCase()}`,
  }));

export const DEFAULT_PERMISSIONS = [
  ...actions("EMPLOYEE", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("USER", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("DEPARTMENT", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("ATTENDANCE", ["READ", "CREATE", "UPDATE", "APPROVE"]),

  ...actions("LEAVE", ["READ", "CREATE", "UPDATE", "APPROVE", "REJECT"]),

  ...actions("PAYROLL", ["READ", "CREATE", "UPDATE", "APPROVE", "MANAGE"]),

  ...actions("RECRUITMENT", ["READ", "CREATE", "UPDATE", "DELETE", "APPROVE"]),

  ...actions("REQUISITION", [
    "READ",
    "CREATE",
    "UPDATE",
    "SUBMIT",
    "APPROVE",
    "REJECT",
    "SEND_BACK",
  ]),

  ...actions("REQUISITION", ["READ", "UPDATE", "SUBMIT"], "SELF"),

  ...actions("CANDIDATE", [
    "READ",
    "CREATE",
    "UPDATE",
    "DELETE",
    "FINAL_DECISION",
    "CONVERT",
  ]),

  ...actions("INTERVIEW", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("INTERVIEW", ["READ", "UPDATE"], "SELF"),

  ...actions("INTERVIEW_FEEDBACK", ["READ"]),

  ...actions("INTERVIEW_FEEDBACK", ["READ", "SUBMIT"], "SELF"),

  ...actions("OFFER", [
    "READ",
    "CREATE",
    "UPDATE",
    "SUBMIT",
    "APPROVE",
    "RETURN",
    "SEND",
    "WITHDRAW",
  ]),

  ...actions("OFFER_TEMPLATE", ["READ", "CREATE", "UPDATE"]),

  ...actions("PRE_ONBOARDING", [
    "READ",
    "CREATE",
    "UPDATE",
    "SEND",
    "READY",
    "WITHDRAW",
  ]),

  ...actions("PRE_ONBOARDING_DOCUMENT", ["READ", "VERIFY"]),

  ...actions("PRE_ONBOARDING_SETTINGS", ["READ", "MANAGE"]),

  ...actions("REPORT", ["READ", "EXPORT"]),

  ...actions("DOCUMENT", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("PROJECT", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("TASK", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("MEETING", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("EXPENSE", ["READ", "CREATE", "UPDATE", "APPROVE"]),

  ...actions("PERFORMANCE", ["READ", "CREATE", "UPDATE", "APPROVE"]),

  ...actions("SETTINGS", ["READ", "UPDATE", "MANAGE"]),

  ...actions("ANNOUNCEMENT", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("HOLIDAY", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("SHIFT", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("SUPPORT", ["READ", "CREATE", "UPDATE", "MANAGE"]),

  ...actions("DOCUMENT", ["CREATE", "DELETE"], "SELF"),

  ...actions("EXPENSE", ["READ", "CREATE", "UPDATE"], "SELF"),

  ...actions("PERFORMANCE", ["READ", "UPDATE"], "SELF"),

  ...actions("ASSET", ["READ"], "SELF"),

  ...actions("LIFECYCLE", ["READ"], "SELF"),

  ...actions("SUPPORT", ["READ"], "SELF"),

  // Scope-aware permissions.
  ...actions("EMPLOYEE", ["READ"], "DEPARTMENT"),

  ...actions("EMPLOYEE", ["READ"], "TEAM"),

  ...actions("EMPLOYEE", ["READ"], "SELF"),

  ...actions("ATTENDANCE", ["READ", "CREATE"], "SELF"),

  ...actions("LEAVE", ["UPDATE"], "SELF"),

  ...actions("LEAVE", ["READ", "CREATE"], "SELF"),

  ...actions("PAYSLIP", ["READ"], "SELF"),

  ...actions("DOCUMENT", ["READ"], "SELF"),

  ...actions("TASK", ["READ", "UPDATE"], "SELF"),

  ...actions("MEETING", ["READ"], "SELF"),

  ...actions("PROFILE", ["READ", "UPDATE"], "SELF"),

  ...actions("RESIGNATION", ["CREATE"], "SELF"),

  ...actions("ASSET", ["READ", "CREATE", "UPDATE", "DELETE"]),

  ...actions("LIFECYCLE", ["READ", "CREATE", "UPDATE"]),
];

const permissions = (...names) => names.flat();

const allCompanyPermissions = DEFAULT_PERMISSIONS.filter(
  (permission) => permission.scope === "ALL",
).map((permission) => permission.name);

const SELF_SERVICE_PERMISSIONS = [
  "EMPLOYEE_READ_SELF",

  "ATTENDANCE_READ_SELF",
  "ATTENDANCE_CREATE_SELF",

  "LEAVE_READ_SELF",
  "LEAVE_CREATE_SELF",
  "LEAVE_UPDATE_SELF",

  "PAYSLIP_READ_SELF",

  "DOCUMENT_READ_SELF",
  "DOCUMENT_CREATE_SELF",
  "DOCUMENT_DELETE_SELF",

  "TASK_READ_SELF",
  "TASK_UPDATE_SELF",

  "MEETING_READ_SELF",

  "INTERVIEW_READ_SELF",
  "INTERVIEW_UPDATE_SELF",
  "INTERVIEW_FEEDBACK_READ_SELF",
  "INTERVIEW_FEEDBACK_SUBMIT_SELF",

  "PROFILE_READ_SELF",
  "PROFILE_UPDATE_SELF",

  "RESIGNATION_CREATE_SELF",

  "EXPENSE_READ_SELF",
  "EXPENSE_CREATE_SELF",
  "EXPENSE_UPDATE_SELF",

  "PERFORMANCE_READ_SELF",
  "PERFORMANCE_UPDATE_SELF",

  "ASSET_READ_SELF",
  "LIFECYCLE_READ_SELF",

  "SUPPORT_READ_SELF",
  "SUPPORT_CREATE",
  "SUPPORT_UPDATE_SELF",

  "ANNOUNCEMENT_READ",
  "HOLIDAY_READ",
  "SHIFT_READ",
];

export const DEFAULT_ROLE_MATRIX = {
  COMPANY_ADMIN: [...allCompanyPermissions, ...SELF_SERVICE_PERMISSIONS],

  HR_MANAGER: permissions(
    ...SELF_SERVICE_PERMISSIONS,
    "EMPLOYEE_READ",
    "EMPLOYEE_CREATE",
    "EMPLOYEE_UPDATE",

    "PAYROLL_READ",
    "PAYROLL_CREATE",
    "PAYROLL_UPDATE",
    "PAYROLL_APPROVE",
    "PAYROLL_MANAGE",

    "USER_READ",
    "USER_CREATE",
    "USER_UPDATE",

    "DEPARTMENT_READ",
    "DEPARTMENT_CREATE",
    "DEPARTMENT_UPDATE",

    "ATTENDANCE_READ",

    "LEAVE_READ",
    "LEAVE_APPROVE",
    "LEAVE_REJECT",

    "RECRUITMENT_READ",
    "RECRUITMENT_CREATE",
    "RECRUITMENT_UPDATE",

    "REQUISITION_READ",
    "REQUISITION_CREATE",
    "REQUISITION_UPDATE",
    "REQUISITION_SUBMIT",
    "REQUISITION_APPROVE",
    "REQUISITION_REJECT",
    "REQUISITION_SEND_BACK",

    "CANDIDATE_READ",
    "CANDIDATE_CREATE",
    "CANDIDATE_UPDATE",
    "CANDIDATE_FINAL_DECISION",
    "CANDIDATE_CONVERT",

    "OFFER_READ",
    "OFFER_CREATE",
    "OFFER_UPDATE",
    "OFFER_SUBMIT",
    "OFFER_APPROVE",
    "OFFER_RETURN",
    "OFFER_SEND",
    "OFFER_WITHDRAW",
    "OFFER_TEMPLATE_READ",
    "OFFER_TEMPLATE_CREATE",
    "OFFER_TEMPLATE_UPDATE",

    "PRE_ONBOARDING_READ",
    "PRE_ONBOARDING_CREATE",
    "PRE_ONBOARDING_UPDATE",
    "PRE_ONBOARDING_SEND",
    "PRE_ONBOARDING_READY",
    "PRE_ONBOARDING_WITHDRAW",
    "PRE_ONBOARDING_DOCUMENT_READ",
    "PRE_ONBOARDING_DOCUMENT_VERIFY",
    "PRE_ONBOARDING_SETTINGS_READ",
    "PRE_ONBOARDING_SETTINGS_MANAGE",

    "INTERVIEW_READ",
    "INTERVIEW_CREATE",
    "INTERVIEW_UPDATE",
    "INTERVIEW_FEEDBACK_READ",

    "DOCUMENT_READ",
    "DOCUMENT_CREATE",

    "ANNOUNCEMENT_READ",
    "ANNOUNCEMENT_CREATE",

    "HOLIDAY_READ",
    "HOLIDAY_CREATE",

    "PERFORMANCE_READ",

    "REPORT_READ",
    "REPORT_EXPORT",

    "SUPPORT_READ",
    "SUPPORT_MANAGE",
    "ASSET_READ",
    "ASSET_CREATE",
    "ASSET_UPDATE",

    "LIFECYCLE_READ",
    "LIFECYCLE_CREATE",
    "LIFECYCLE_UPDATE",
  ),

  MANAGER: permissions(
    ...SELF_SERVICE_PERMISSIONS,
    "EMPLOYEE_READ_TEAM",
    "ATTENDANCE_READ",
    "LEAVE_READ",
    "LEAVE_APPROVE",

    "REQUISITION_CREATE",
    "REQUISITION_READ_SELF",
    "REQUISITION_UPDATE_SELF",
    "REQUISITION_SUBMIT_SELF",

    "PROJECT_READ",
    "PROJECT_CREATE",
    "PROJECT_UPDATE",

    "TASK_READ",
    "TASK_CREATE",
    "TASK_UPDATE",

    "MEETING_READ",
    "MEETING_CREATE",
    "MEETING_UPDATE",

    "PERFORMANCE_READ",
    "EXPENSE_READ",
    "EXPENSE_APPROVE",
  ),

  TEAM_LEAD: permissions(
    ...SELF_SERVICE_PERMISSIONS,
    "EMPLOYEE_READ_TEAM",
    "ATTENDANCE_READ",
    "LEAVE_READ",

    "REQUISITION_CREATE",
    "REQUISITION_READ_SELF",
    "REQUISITION_UPDATE_SELF",
    "REQUISITION_SUBMIT_SELF",

    "TASK_READ",
    "TASK_CREATE",
    "TASK_UPDATE",

    "PROJECT_READ",

    "MEETING_READ",
    "MEETING_CREATE",
    "MEETING_UPDATE",

    "PERFORMANCE_READ",
    "DOCUMENT_CREATE_SELF",
    "DOCUMENT_DELETE_SELF",

    "EXPENSE_READ_SELF",
    "EXPENSE_CREATE_SELF",
    "EXPENSE_UPDATE_SELF",

    "PERFORMANCE_READ_SELF",
    "PERFORMANCE_UPDATE_SELF",

    "ASSET_READ_SELF",
    "LIFECYCLE_READ_SELF",
    "SUPPORT_READ_SELF",
  ),

  EMPLOYEE: permissions(
    ...SELF_SERVICE_PERMISSIONS,
    "EMPLOYEE_READ_SELF",
    "LEAVE_UPDATE_SELF",
    "ATTENDANCE_READ_SELF",
    "ATTENDANCE_CREATE_SELF",

    "LEAVE_READ_SELF",
    "LEAVE_CREATE_SELF",

    "ANNOUNCEMENT_READ",
    "HOLIDAY_READ",
    "SHIFT_READ",

    "PAYSLIP_READ_SELF",

    "DOCUMENT_READ_SELF",

    "TASK_READ_SELF",
    "TASK_UPDATE_SELF",

    "MEETING_READ_SELF",

    "PROFILE_READ_SELF",
    "PROFILE_UPDATE_SELF",

    "RESIGNATION_CREATE_SELF",

    "SUPPORT_CREATE",
  ),
};

export const ROLE_LABELS = {
  COMPANY_ADMIN: "Company Admin",
  HR_MANAGER: "HR Manager",
  MANAGER: "Manager",
  TEAM_LEAD: "Team Lead",
  EMPLOYEE: "Employee",
};
