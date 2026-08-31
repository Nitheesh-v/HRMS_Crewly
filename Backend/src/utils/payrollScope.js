// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.1 RBAC UPDATE — PAYROLL ORGANIZATIONAL SCOPE
//
//  Permission answers "MAY this role do this action?".
//  Scope answers "FOR WHICH PEOPLE may they do it?".
//
//  Both are required. A Manager with PAYROLL_RUN_READ must still only see
//  their own team's data, never the whole company's salary register.
//
//  This module is PURE (no Mongoose, no Redis): it decides scope from data
//  handed to it. Team resolution uses the EXISTING org helper
//  (utils/orgHelpers.getSubtreeIds → User.reportingTo subtree); the caller
//  passes the resulting id set in as `teamIds`.
//
//  TENANT ISOLATION IS NOT OPTIONAL HERE: canAccessSubject() returns false
//  the moment the actor and the subject belong to different companies,
//  regardless of scope. Company A can never read Company B payroll data.
// ═══════════════════════════════════════════════════════════════════════════

export const PAYROLL_SCOPES = Object.freeze({
  SELF: 'SELF',
  TEAM: 'TEAM',
  DEPARTMENT: 'DEPARTMENT',
  ASSIGNED_DEPARTMENTS: 'ASSIGNED_DEPARTMENTS',
  COMPANY: 'COMPANY',
});

export const PAYROLL_SCOPE_LIST = Object.freeze(Object.values(PAYROLL_SCOPES));

export const PAYROLL_SCOPE_LABELS = Object.freeze({
  SELF: 'Self only',
  TEAM: 'Own team',
  DEPARTMENT: 'Own department',
  ASSIGNED_DEPARTMENTS: 'Assigned departments',
  COMPANY: 'Entire company',
});

// Role → default scope. Used when a role has no explicit override for the
// permission being checked.
const ROLE_DEFAULT_SCOPE = Object.freeze({
  SUPER_ADMIN: PAYROLL_SCOPES.SELF, // platform staff have no tenant scope
  COMPANY_ADMIN: PAYROLL_SCOPES.COMPANY,
  HR_MANAGER: PAYROLL_SCOPES.COMPANY,
  HR_HEAD: PAYROLL_SCOPES.COMPANY,
  HR_EXECUTIVE: PAYROLL_SCOPES.ASSIGNED_DEPARTMENTS,
  PAYROLL_ADMIN: PAYROLL_SCOPES.COMPANY,
  PAYROLL_EXECUTIVE: PAYROLL_SCOPES.COMPANY,
  FINANCE_MANAGER: PAYROLL_SCOPES.COMPANY,
  FINANCE_EXECUTIVE: PAYROLL_SCOPES.COMPANY,
  MANAGER: PAYROLL_SCOPES.TEAM,
  TEAM_LEAD: PAYROLL_SCOPES.TEAM,
  EMPLOYEE: PAYROLL_SCOPES.SELF,
});

export const defaultScopeForRole = (roleCode) =>
  ROLE_DEFAULT_SCOPE[String(roleCode || '').trim().toUpperCase()] || PAYROLL_SCOPES.SELF;

// Resolve the effective scope for one actor + one permission.
// Precedence: explicit per-permission override → role default → SELF.
export const resolvePayrollScope = ({
  roleCode = '',
  permission = '',
  permissionScopes = [],
  customRoleDefaultScope = null,
} = {}) => {
  const key = String(permission || '').trim().toUpperCase();
  const override = Array.isArray(permissionScopes)
    ? permissionScopes.find((entry) => String(entry?.permission || '').trim().toUpperCase() === key)
    : null;

  if (override?.scope && PAYROLL_SCOPE_LIST.includes(override.scope)) return override.scope;
  if (customRoleDefaultScope && PAYROLL_SCOPE_LIST.includes(customRoleDefaultScope)) {
    return customRoleDefaultScope;
  }
  return defaultScopeForRole(roleCode);
};

const idOf = (value) => (value === null || value === undefined ? '' : String(value));
const sameId = (a, b) => idOf(a) && idOf(b) && idOf(a) === idOf(b);

// ── The one decision function every payroll read will call ─────────────────
//
// actor   : { _id, companyId, department, assignedDepartments? }
// subject : { _id, companyId, department, reportingTo? }
// scope   : one of PAYROLL_SCOPES
// teamIds : resolved reporting subtree for scope TEAM (from orgHelpers)
export const canAccessSubject = ({ actor = {}, subject = {}, scope, teamIds = null } = {}) => {
  if (!actor || !subject) return false;

  // TENANT FIRST — a scope can never widen across companies.
  if (!sameId(actor.companyId, subject.companyId)) return false;

  const resolved = PAYROLL_SCOPE_LIST.includes(scope) ? scope : PAYROLL_SCOPES.SELF;

  if (resolved === PAYROLL_SCOPES.SELF) return sameId(actor._id, subject._id);
  if (resolved === PAYROLL_SCOPES.COMPANY) return true;

  if (resolved === PAYROLL_SCOPES.TEAM) {
    if (sameId(actor._id, subject._id)) return true;
    if (!Array.isArray(teamIds)) return false; // caller must resolve the subtree
    return teamIds.map(idOf).includes(idOf(subject._id));
  }

  if (resolved === PAYROLL_SCOPES.DEPARTMENT) {
    return Boolean(actor.department) && sameId(actor.department, subject.department);
  }

  if (resolved === PAYROLL_SCOPES.ASSIGNED_DEPARTMENTS) {
    const assigned = Array.isArray(actor.assignedDepartments) ? actor.assignedDepartments : [];
    if (!assigned.length) return false;
    return assigned.map(idOf).includes(idOf(subject.department));
  }

  return false;
};

// Convenience wrapper for the common "self-service payslip" case: an
// employee may always see their own record, whatever their role scope is.
export const canAccessOwnRecord = ({ actor = {}, subject = {} } = {}) =>
  canAccessSubject({ actor, subject, scope: PAYROLL_SCOPES.SELF });

// Human-readable scope for the UI.
export const describeScope = (scope) =>
  PAYROLL_SCOPE_LABELS[scope] || PAYROLL_SCOPE_LABELS.SELF;
