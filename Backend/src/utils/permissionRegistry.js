export const RESOURCES = [
  "EMPLOYEE",
  "USER",
  "ASSET",
  "LIFECYCLE",
  "DEPARTMENT",
  "ATTENDANCE",
  "LEAVE",
  "PAYROLL",
  "PAYROLL_SETUP",
  "SALARY_COMPONENT",
  "SALARY_STRUCTURE",
  "EMPLOYEE_SALARY",
  "SALARY_REVISION",
  "PAYROLL_RUN",
  "PAYROLL_PAYMENT",
  "PAYROLL_STATUTORY",
  "PAYROLL_REPORT",
  "PAYSLIP",
  "FINAL_SETTLEMENT",
  "RECRUITMENT",
  "RECRUITMENT_ANALYTICS",
  "BACKGROUND_VERIFICATION",
  "BACKGROUND_VERIFICATION_SETTINGS",
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

  // Phase 29.1 — payroll setup activation (high-impact, audited)
  "ACTIVATE",

  // Phase 29.1 RBAC update — payroll operations verbs
  "PREPARE",
  "EXECUTE",
  "RECALCULATE",
  "REVIEW",
  "LOCK",
  "REOPEN",
  "ASSIGN",
  "GENERATE",
  "CONFIRM",
  "RELEASE",
  "RERELEASE",
  "MARK_PAID",

  // Phase 29.10 — filing a statutory return on the government portal is a
  // separate duty from producing the report that is filed.
  "FILING",
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

  // Phase 29.1 — Company Payroll Setup (configuration layer).
  // ACTIVATE is deliberately separate from UPDATE: activation is a
  // high-impact, audited transition (least privilege).
  ...actions("PAYROLL_SETUP", ["READ", "UPDATE", "ACTIVATE"]),

  // ── Phase 29.1 RBAC update — payroll permission catalogue ────────
  // Declared now so companies can configure HR / Payroll / Finance roles
  // today; the later payroll phases only add requirePermission(...) to
  // their routes. NOTHING below is enforced until its phase ships — see
  // docs/PHASE_29_1_COMPANY_PAYROLL_SETUP.md §RBAC.

  // Salary configuration (phase 33.2 / 33.3 / 33.4)
  ...actions("SALARY_COMPONENT", ["READ", "MANAGE", "ACTIVATE"]),
  // ACTIVATE (Phase 29.3 §14) is deliberately separate from MANAGE: building
  // a structure and switching it on are different duties, exactly as
  // PAYROLL_SETUP_ACTIVATE / SALARY_COMPONENT_ACTIVATE already are.
  ...actions("SALARY_STRUCTURE", ["READ", "MANAGE", "ACTIVATE", "ASSIGN"]),
  ...actions("EMPLOYEE_SALARY", ["READ", "MANAGE"]),

  // Phase 29.5 — monthly payroll inputs: preparing the month, and LOCKing it.
  // LOCK is separate from MANAGE because §20 lets only Company Admin / Payroll
  // Admin freeze or reopen a month, while HR may still collect and edit.
  ...actions("PAYROLL_INPUT", ["READ", "MANAGE", "LOCK"]),
  // Phase 29.4 — an employee may read their OWN payroll profile and nothing
  // else. It is deliberately NOT part of SELF_SERVICE_PERMISSIONS, because
  // that list is granted to Manager / Team Lead too and §4 gives them no
  // salary access at all.
  ...actions("EMPLOYEE_SALARY", ["READ"], "SELF"),
  ...actions("SALARY_REVISION", ["APPROVE"]),

  // Payroll processing (phase 33.6 / 33.7)
  ...actions("PAYROLL_RUN", [
    "READ",
    "PREPARE",
    "EXECUTE",
    "RECALCULATE",
    "REVIEW",
    "LOCK",
    "REOPEN",
    "APPROVE",
    "REJECT",
  ]),

  // Payment (phase 33.9)
  ...actions("PAYROLL_PAYMENT", ["GENERATE", "READ", "CONFIRM", "MARK_PAID"]),

  // Payslips (phase 33.10) — PAYSLIP_READ_SELF already exists below
  ...actions("PAYSLIP", ["GENERATE", "RELEASE", "RERELEASE", "READ"]),

  // Final settlement / F&F (phase 29.11 — this phase). One verb per duty:
  // the person who calculates a settlement is not the person who approves
  // its payment, and neither of them closes it.
  ...actions("FINAL_SETTLEMENT", ["READ", "CALCULATE", "REVIEW", "APPROVE", "PAY", "CLOSE", "REOPEN"]),

  // Statutory compliance (phase 29.10 — this phase).
  // GENERATE = produce the report; FILING = move it through
  // Draft / Reviewed / Ready / Filed / Reopened. Finance files, so finance
  // needs FILING without needing GENERATE (separation of duties, §4).
  ...actions("PAYROLL_STATUTORY", ["MANAGE", "READ", "GENERATE", "FILING"]),

  // Payroll reports (phase 33.14)
  ...actions("PAYROLL_REPORT", ["READ", "EXPORT"]),

  // Payroll analytics & reports (phase 29.12). READ/EXPORT already exist from
  // 29.8 and are reused for the general reports; the two new verbs are the
  // ones the brief reserves: FINANCIAL gates the money-only CTC report (§16)
  // and SCHEDULE gates standing instructions (§20 — Company Admin + Finance).
  ...actions("PAYROLL_ANALYTICS", ["FINANCIAL", "SCHEDULE"]),

  ...actions("RECRUITMENT", ["READ", "CREATE", "UPDATE", "DELETE", "APPROVE"]),

  ...actions("RECRUITMENT_ANALYTICS", ["READ"]),

  ...actions("BACKGROUND_VERIFICATION", ["READ", "CREATE", "UPDATE", "VERIFY", "MANAGE"]),

  ...actions("BACKGROUND_VERIFICATION_SETTINGS", ["READ", "MANAGE"]),

  // Phase 30.1.1 — BGV EXECUTION is Crewly-platform operated (see
  // superAdminAuth PLATFORM_PERMISSIONS: bgv:read / bgv:verify / bgv:assign
  // under /api/super-admin/bgv). Tenants keep only the 27.15 company
  // permissions: request, consent, progress view, case decision.
  // The six BGV_CHECK_*/BGV_EVIDENCE_* company permissions drafted in
  // 30.1 were retired here; scripts/migratePhase30BgvPermissions.js
  // revokes them from tenant roles that already received them.

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

  ...actions("FINAL_SETTLEMENT", ["READ"], "SELF"),

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

  // Phase 29.11 §18 — an employee reads their OWN final settlement.
  "FINAL_SETTLEMENT_READ_SELF",

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

    // HR Manager may read and edit the company payroll setup, but only a
    // Company Admin may ACTIVATE it (§3 least privilege).
    "PAYROLL_SETUP_READ",
    "PAYROLL_SETUP_UPDATE",

    // Payroll operations (Phase 29.1 RBAC update). HR runs the cycle but
    // must NOT approve it, confirm payment or release payslips — those are
    // separate duties held by HR Head / Finance (separation of duties).
    "PAYROLL_RUN_READ",
    "PAYROLL_RUN_PREPARE",
    "PAYROLL_RUN_EXECUTE",
    // Phase 29.6 §21 — recalculation belongs to the Payroll Admin and the
    // Company Admin. HR runs the month; only they may rewrite a snapshot.
    "PAYROLL_RUN_REVIEW",
    "SALARY_COMPONENT_READ",
    "SALARY_COMPONENT_MANAGE",
    "SALARY_STRUCTURE_READ",
    "SALARY_STRUCTURE_MANAGE",
    "SALARY_STRUCTURE_ASSIGN",
    "EMPLOYEE_SALARY_READ",
    "EMPLOYEE_SALARY_MANAGE",
    // Phase 29.5 §4 — HR collects and edits inputs; locking stays admin-only.
    "PAYROLL_INPUT_READ",
    "PAYROLL_INPUT_MANAGE",
    "PAYROLL_REPORT_READ",
    "PAYROLL_STATUTORY_READ",
    // Phase 29.11 §4 — HR verifies the exit (last working day, attendance,
    // leave, assets) and reviews the settlement. HR never approves a payment.
    "FINAL_SETTLEMENT_READ",
    "FINAL_SETTLEMENT_REVIEW",
    // Phase 29.8 §4 — HR may SEE payment status (who has been paid, what
    // failed) but must never create a batch, generate a bank file or confirm
    // a payment: those are finance duties.
    "PAYROLL_PAYMENT_READ",
    // Phase 29.9 §4 — HR may view and download employee payslips, but must
    // not generate or release them: that is the Payroll Admin's duty.
    "PAYSLIP_READ",

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
    "RECRUITMENT_ANALYTICS_READ",

    "BACKGROUND_VERIFICATION_READ",
    "BACKGROUND_VERIFICATION_CREATE",
    "BACKGROUND_VERIFICATION_UPDATE",
    "BACKGROUND_VERIFICATION_VERIFY",
    "BACKGROUND_VERIFICATION_MANAGE",
    "BACKGROUND_VERIFICATION_SETTINGS_READ",
    "BACKGROUND_VERIFICATION_SETTINGS_MANAGE",

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
    // Phase 29.5 §4 — view own team's monthly inputs only (TEAM scope).
    "PAYROLL_INPUT_READ",
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

    // Phase 29.4 §4 / §24 — own payroll profile, read-only.
    "EMPLOYEE_SALARY_READ_SELF",

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
