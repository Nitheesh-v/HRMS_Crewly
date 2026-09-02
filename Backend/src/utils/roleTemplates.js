// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.1 RBAC UPDATE — COMPANY ROLE TEMPLATES
//
//  These are TEMPLATES, not seeded roles.
//
//  Crewly is multi-tenant: a 12-person company does not want six payroll
//  roles appearing in its Roles list, and a 900-person company does.
//  Nothing here is auto-created for a company — the Company Admin opts in
//  from Settings → Roles & Permissions → "Create from template", which
//  produces an ordinary per-company CompanyRole (isSystemRole: false) that
//  can be edited and assigned like any custom role.
//
//  DESIGN RULES
//    · Separation of duties: no preset holds BOTH "run/prepare" and
//      "approve" for the same payroll run, and no preset holds both
//      "approve" and "confirm payment". The company can still override it.
//    · Templates only reference permissions that exist in the registry.
//    · Templates are DATA — no DB access, no side effects, fully hermetic.
// ═══════════════════════════════════════════════════════════════════════════

import { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX } from './permissionRegistry.js';
import { PAYROLL_SCOPES } from './payrollScope.js';

// Self-service block every role keeps, so a template never strips basic
// access from its holders.
const SELF_SERVICE = [
  'PROFILE_READ_SELF',
  'PROFILE_UPDATE_SELF',
  'LEAVE_READ_SELF',
  'LEAVE_CREATE_SELF',
  'LEAVE_UPDATE_SELF',
  'ATTENDANCE_READ_SELF',
  'ATTENDANCE_CREATE_SELF',
  'PAYSLIP_READ_SELF',
  'DOCUMENT_READ_SELF',
  'HOLIDAY_READ',
  'ANNOUNCEMENT_READ',
].filter((name) => DEFAULT_PERMISSIONS.some((permission) => permission.name === name));

// Shared HR operations every HR-flavoured template starts from.
const HR_BASE = [
  'EMPLOYEE_READ',
  'EMPLOYEE_CREATE',
  'EMPLOYEE_UPDATE',
  'ATTENDANCE_READ',
  'LEAVE_READ',
  'LEAVE_APPROVE',
  'LEAVE_REJECT',
  'DEPARTMENT_READ',
  'HOLIDAY_READ',
  'SHIFT_READ',
].filter((name) => DEFAULT_PERMISSIONS.some((permission) => permission.name === name));

export const ROLE_TEMPLATES = Object.freeze([
  {
    key: 'HR_HEAD',
    name: 'HR Head',
    description:
      'Owns HR outcomes: salary structures, employee salary, payroll review and final payroll approval.',
    defaultScope: PAYROLL_SCOPES.COMPANY,
    permissions: [
      ...HR_BASE,
      'PAYROLL_SETUP_READ',
      'PAYROLL_RUN_READ',
      'PAYROLL_RUN_REVIEW',
      'PAYROLL_RUN_APPROVE',
      'PAYROLL_RUN_REJECT',
      'SALARY_COMPONENT_READ',
      'SALARY_COMPONENT_MANAGE',
      'SALARY_STRUCTURE_READ',
      'SALARY_STRUCTURE_MANAGE',
      'SALARY_STRUCTURE_ASSIGN',
      'EMPLOYEE_SALARY_READ',
      'EMPLOYEE_SALARY_MANAGE',
      'SALARY_REVISION_APPROVE',
      'PAYROLL_REPORT_READ',
      'PAYROLL_STATUTORY_READ',
      // Phase 29.11 §4 — HR reviews the settlement.
      'FINAL_SETTLEMENT_READ',
      'FINAL_SETTLEMENT_REVIEW',
    ],
  },
  {
    key: 'HR_EXECUTIVE',
    name: 'HR Executive',
    description:
      'Prepares payroll inputs: variable pay, adjustments and employee payroll data. Cannot approve payroll or touch bank files.',
    defaultScope: PAYROLL_SCOPES.ASSIGNED_DEPARTMENTS,
    permissions: [
      ...HR_BASE,
      'PAYROLL_RUN_READ',
      'PAYROLL_RUN_PREPARE',
      'SALARY_COMPONENT_READ',
      'EMPLOYEE_SALARY_READ',
      'SALARY_STRUCTURE_READ',
    ],
  },
  {
    key: 'PAYROLL_ADMIN',
    name: 'Payroll Admin',
    description:
      'Runs the payroll cycle end to end and releases payslips. Final approval stays with HR Head / Finance.',
    defaultScope: PAYROLL_SCOPES.COMPANY,
    permissions: [
      ...HR_BASE,
      'PAYROLL_SETUP_READ',
      'PAYROLL_SETUP_UPDATE',
      'PAYROLL_RUN_READ',
      'PAYROLL_RUN_PREPARE',
      'PAYROLL_RUN_EXECUTE',
      'PAYROLL_RUN_RECALCULATE',
      'PAYROLL_RUN_REVIEW',
      'PAYROLL_RUN_LOCK',
      'SALARY_COMPONENT_READ',
      'SALARY_COMPONENT_MANAGE',
      'SALARY_COMPONENT_ACTIVATE',
      // Phase 29.3 §4 — for the salary structure the Payroll Admin is treated
      // like the Company Admin: build, edit, clone AND activate.
      'SALARY_STRUCTURE_READ',
      'SALARY_STRUCTURE_MANAGE',
      'SALARY_STRUCTURE_ACTIVATE',
      'SALARY_STRUCTURE_ASSIGN',
      // Phase 29.4 §4 — the Payroll Admin creates, edits and revises payroll
      // profiles; the employee keeps read-only access to their own.
      'EMPLOYEE_SALARY_READ',
      'EMPLOYEE_SALARY_MANAGE',
      // Phase 29.5 §4 — the Payroll Admin owns the monthly input workspace,
      // including locking and reopening the month.
      'PAYROLL_INPUT_READ',
      'PAYROLL_INPUT_MANAGE',
      'PAYROLL_INPUT_LOCK',
      'PAYROLL_PAYMENT_READ',
      'PAYROLL_PAYMENT_GENERATE',
      'PAYSLIP_READ',
      'PAYSLIP_GENERATE',
      'PAYSLIP_RELEASE',
      'PAYSLIP_RERELEASE',
      'PAYROLL_STATUTORY_MANAGE',
      'PAYROLL_STATUTORY_READ',
      'PAYROLL_STATUTORY_GENERATE',
      // Phase 29.10 §4 — the Payroll Admin generates the statutory reports.
      // Filing stays with Finance: the person who produces a return is not
      // the person who attests that it was submitted.
      'PAYROLL_REPORT_READ',
      'PAYROLL_REPORT_EXPORT',
      // Phase 29.11 §4 — the Payroll Admin calculates the settlement, edits
      // the payable and recovery items and generates the statement. Approving
      // and paying it stays with Finance (separation of duties).
      'FINAL_SETTLEMENT_READ',
      'FINAL_SETTLEMENT_CALCULATE',
      'FINAL_SETTLEMENT_REVIEW',
    ],
  },
  {
    key: 'PAYROLL_EXECUTIVE',
    name: 'Payroll Executive',
    description:
      'Prepares and runs payroll and produces payslips. No approval, no payment confirmation.',
    defaultScope: PAYROLL_SCOPES.COMPANY,
    permissions: [
      ...HR_BASE,
      'PAYROLL_RUN_READ',
      'PAYROLL_RUN_PREPARE',
      'PAYROLL_RUN_EXECUTE',
      'PAYROLL_RUN_RECALCULATE',
      'PAYROLL_RUN_REVIEW',
      'SALARY_COMPONENT_READ',
      'SALARY_STRUCTURE_READ',
      'EMPLOYEE_SALARY_READ',
      'PAYSLIP_READ',
      'PAYSLIP_GENERATE',
      'PAYROLL_REPORT_READ',
    ],
  },
  {
    key: 'FINANCE_MANAGER',
    name: 'Finance Manager',
    description:
      'Reviews payroll totals, approves payment, handles the bank file and marks payroll paid. No salary editing.',
    // By design this role concentrates approval and payment duties: in most
    // companies finance owns the whole payment leg. The exception is declared
    // (not silent) so the UI can warn and the audit trail can show it.
    separationException: {
      rules: ['APPROVE_AND_CONFIRM_PAYMENT', 'BANK_FILE_AND_CONFIRM'],
      reason:
        'Finance owns the payment leg end to end. Split Confirm Payment into ' +
        'a Finance Executive role if your policy requires two people.',
    },
    defaultScope: PAYROLL_SCOPES.COMPANY,
    permissions: [
      ...HR_BASE,
      'PAYROLL_RUN_READ',
      'PAYROLL_RUN_REVIEW',
      'PAYROLL_RUN_APPROVE',
      // Phase 29.7 §14 — approval is a two-sided decision. A finance manager
      // who can approve must also be able to reject with a reason; otherwise
      // the only way to say no is to walk away and leave payroll stuck.
      'PAYROLL_RUN_REJECT',
      'SALARY_COMPONENT_READ',
      'PAYROLL_PAYMENT_READ',
      'PAYROLL_PAYMENT_GENERATE',
      'PAYROLL_PAYMENT_CONFIRM',
      'PAYROLL_PAYMENT_MARK_PAID',
      // Phase 29.9 §4 — Finance VIEW ONLY: no generation, no release, no
      // re-release. Those stay with the Payroll Admin.
      'PAYSLIP_READ',
      'PAYROLL_REPORT_READ',
      'PAYROLL_REPORT_EXPORT',
      // Phase 29.10 §4 — Finance reviews, exports and updates the filing
      // status. Generating the report stays with the Payroll Admin.
      'PAYROLL_STATUTORY_READ',
      'PAYROLL_STATUTORY_FILING',
      // Phase 29.11 §4 — Finance approves the settlement and marks it paid.
      // Finance does not calculate it and does not close it.
      'FINAL_SETTLEMENT_READ',
      'FINAL_SETTLEMENT_APPROVE',
      'FINAL_SETTLEMENT_PAY',
    ],
  },
  {
    key: 'FINANCE_EXECUTIVE',
    name: 'Finance Executive',
    description:
      'Downloads the approved payment batch and updates payment status. Read-only on payroll, no salary editing.',
    defaultScope: PAYROLL_SCOPES.COMPANY,
    permissions: [
      ...HR_BASE,
      'PAYROLL_RUN_READ',
      'SALARY_COMPONENT_READ',
      'PAYROLL_PAYMENT_READ',
      // Phase 29.9 §4 — Finance is VIEW ONLY on payslips.
      'PAYSLIP_READ',
      'PAYROLL_REPORT_READ',
      // Phase 29.11 §4 — the Finance Executive follows a settlement through
      // the workflow and pays it, but never calculates it and never closes
      // it: those are the Payroll Admin's and the Company Admin's duties.
      'FINAL_SETTLEMENT_READ',
    ],
  },
]);

export const ROLE_TEMPLATE_KEYS = Object.freeze(ROLE_TEMPLATES.map((template) => template.key));

export const findRoleTemplate = (key) =>
  ROLE_TEMPLATES.find((template) => template.key === String(key || '').trim().toUpperCase()) || null;

// Public shape for the Roles & Permissions UI: only permission names that
// actually exist in the registry are returned, so a template can never
// reference a permission the plan does not know about.
export const serializeRoleTemplates = ({ availablePermissions = null } = {}) =>
  ROLE_TEMPLATES.map((template) => {
    const permissions = [...SELF_SERVICE, ...template.permissions].filter((name) =>
      DEFAULT_PERMISSIONS.some((permission) => permission.name === name),
    );
    return {
      key: template.key,
      name: template.name,
      description: template.description,
      defaultScope: template.defaultScope,
      permissions: availablePermissions
        ? permissions.filter((name) => availablePermissions.includes(name))
        : permissions,
    };
  });

// Guard rails used by tests and by the controller: a template must never
// collapse separation of duties by itself.
export const SEPARATION_OF_DUTIES_RULES = Object.freeze([
  {
    id: 'RUN_AND_APPROVE',
    run: 'PAYROLL_RUN_EXECUTE',
    approve: 'PAYROLL_RUN_APPROVE',
    message: 'A template must not both execute a payroll run and approve it',
  },
  {
    id: 'APPROVE_AND_CONFIRM_PAYMENT',
    run: 'PAYROLL_PAYMENT_CONFIRM',
    approve: 'PAYROLL_RUN_APPROVE',
    message: 'A template must not both approve payroll and confirm its payment',
  },
  {
    id: 'BANK_FILE_AND_CONFIRM',
    run: 'PAYROLL_PAYMENT_GENERATE',
    approve: 'PAYROLL_PAYMENT_CONFIRM',
    message: 'A template must not both generate the bank file and confirm the payment',
  },
]);

// Templates are additive: they must never claim a protected system role key.
export const TEMPLATE_CONFLICTS_SYSTEM_ROLES = () =>
  ROLE_TEMPLATE_KEYS.filter((key) => Object.keys(DEFAULT_ROLE_MATRIX).includes(key));
