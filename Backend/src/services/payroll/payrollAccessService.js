// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.1 RBAC UPDATE — PAYROLL SUBJECT ACCESS (Tenant → Role →
//  Permission → Scope)
//
//  Every payroll read that targets ANOTHER PERSON's data must pass through
//  this module. Order is fixed and non-negotiable:
//
//      1. TENANT     actor.companyId === subject.companyId
//      2. ROLE       the role must hold the permission
//      3. PERMISSION e.g. PAYSLIP_READ / EMPLOYEE_SALARY_READ
//      4. SCOPE      SELF | TEAM | DEPARTMENT | ASSIGNED_DEPARTMENTS | COMPANY
//
//  Backward compatibility: the legacy role allow-list that shipped with the
//  original payroll module (Company Admin / HR Manager) remains valid, so
//  no existing user loses access when this lands. The permission+scope path
//  is ADDITIVE — it is what lets a company delegate payroll to HR Head,
//  Payroll Admin or Finance without touching a role name.
//
//  Injected seams (hermetic tests): `hasPermissionFn`, `subtreeResolver`,
//  `roleLookup`.
// ═══════════════════════════════════════════════════════════════════════════

import { hasPermission as defaultHasPermission } from '../../utils/permissionService.js';
import { getSubtreeIds as defaultSubtreeResolver } from '../../utils/orgHelpers.js';
import CompanyRole from '../../models/CompanyRole.js';
import {
  PAYROLL_SCOPES,
  canAccessSubject,
  resolvePayrollScope,
} from '../../utils/payrollScope.js';
import { ROLES } from '../../utils/constants.js';

// Roles that could read employee payroll records before this update.
const LEGACY_PAYROLL_ROLES = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

const idOf = (value) => (value === null || value === undefined ? '' : String(value));

// actor:   { _id, companyId, role, roleRef, department }
// subject: { _id, companyId, department }
export const canReadEmployeePayroll = async ({
  actor,
  subject,
  permission = 'EMPLOYEE_SALARY_READ',
  hasPermissionFn = defaultHasPermission,
  subtreeResolver = defaultSubtreeResolver,
  roleLookup = null,
} = {}) => {
  if (!actor || !subject) return false;

  // 1. TENANT — never negotiable.
  if (!idOf(actor.companyId) || idOf(actor.companyId) !== idOf(subject.companyId)) return false;

  // 2. Self-service is always allowed for the record owner.
  if (idOf(actor._id) && idOf(actor._id) === idOf(subject._id)) return true;

  // 3. Legacy behaviour preserved (no existing user loses access).
  if (LEGACY_PAYROLL_ROLES.includes(actor.role)) return true;

  // 4. ROLE + PERMISSION.
  const allowed = await hasPermissionFn(actor, permission);
  if (!allowed) return false;

  // 5. SCOPE.
  const role = await loadRole(actor, roleLookup);
  const scope = resolvePayrollScope({
    roleCode: actor.role,
    permission,
    permissionScopes: role?.permissionScopes || [],
    customRoleDefaultScope: role?.payrollScope || null,
  });

  if (scope === PAYROLL_SCOPES.TEAM) {
    const teamIds = await subtreeResolver(actor.companyId, actor._id);
    return canAccessSubject({ actor, subject, scope, teamIds });
  }

  return canAccessSubject({ actor, subject, scope });
};

// Which employee ids an actor may SEE for a payroll permission.
// `null` means "the whole company" — every caller still filters by companyId,
// so a scope can only ever narrow, never widen.
export const resolvePayrollVisibility = async ({
  actor,
  permission = 'EMPLOYEE_SALARY_READ',
  roleLookup = null,
  subtreeResolver = defaultSubtreeResolver,
} = {}) => {
  if (!actor?.companyId) return { scope: PAYROLL_SCOPES.SELF, allowedEmployeeIds: [] };

  const role = await loadRole(actor, roleLookup);
  const scope = resolvePayrollScope({
    roleCode: actor.role,
    permission,
    permissionScopes: role?.permissionScopes || [],
    customRoleDefaultScope: role?.payrollScope || null,
  });

  if (scope === PAYROLL_SCOPES.COMPANY) {
    return { scope, allowedEmployeeIds: null };
  }

  if (scope === PAYROLL_SCOPES.TEAM) {
    const teamIds = (await subtreeResolver(actor.companyId, actor._id)) || [];
    return {
      scope,
      allowedEmployeeIds: [...new Set([...teamIds.map(String), String(actor._id)])],
    };
  }

  // ASSIGNED_DEPARTMENTS and SELF both narrow to the actor's own rows here;
  // list endpoints that need department expansion can extend this later.
  return { scope, allowedEmployeeIds: [String(actor._id)] };
};

// Payslip-specific entry: a payslip is an employee payroll record.
export const canReadPayslip = (args) =>
  canReadEmployeePayroll({ ...args, permission: args?.permission || 'PAYSLIP_READ' });

// Resolves the CompanyRole document (with scope config) for an actor.
const loadRole = async (actor, roleLookup) => {
  if (roleLookup) return roleLookup(actor);
  try {
    if (actor.roleRef) {
      return await CompanyRole.findOne({ _id: actor.roleRef, companyId: actor.companyId })
        .select('code payrollScope permissionScopes')
        .lean();
    }
    return await CompanyRole.findOne({ companyId: actor.companyId, code: actor.role })
      .select('code payrollScope permissionScopes')
      .lean();
  } catch {
    return null;
  }
};
