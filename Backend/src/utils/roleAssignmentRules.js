// ═══════════════════════════════════════════════════════════════════════════
//  ROLE ASSIGNMENT RULES (pure)
//
//  Before Phase 29.1, only the five built-in system roles existed, so the
//  Users page could hardcode them and the validator could use
//  `isIn([HR_MANAGER, MANAGER, TEAM_LEAD, EMPLOYEE])`.
//
//  29.1 introduced company roles created from templates (HR Head, Payroll
//  Admin, Payroll Executive, ...). Those are ordinary company roles, so they
//  must be assignable from the Users page too — otherwise a company can
//  CREATE a Payroll Admin role but never give it to anybody there.
//
//  This module decides, without touching the database, whether an actor may
//  assign a role and what kind of role it is. It is pure so it can be tested
//  hermetically and reused by the validator, createUser and updateUser.
// ═══════════════════════════════════════════════════════════════════════════

import { CREATION_RIGHTS, ROLES } from './constants.js';

export const normalizeRoleCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');

// The five protected roles every company gets (never SUPER_ADMIN etc.).
export const COMPANY_SCOPED_SYSTEM_ROLES = [
  ROLES.COMPANY_ADMIN,
  ROLES.HR_MANAGER,
  ROLES.MANAGER,
  ROLES.TEAM_LEAD,
  ROLES.EMPLOYEE,
];

const SYSTEM_SET = new Set(Object.values(ROLES).map(normalizeRoleCode));

// Who may hand out a company role created from a template: the two roles
// that already administer roles and permissions.
export const ROLE_ASSIGNERS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

export const classifyRoleAssignment = ({
  code,
  companyRoleCodes = [],
  actorRole = '',
  creationRights = CREATION_RIGHTS,
} = {}) => {
  const wanted = normalizeRoleCode(code);
  if (!wanted) {
    return { allowed: false, kind: 'NONE', reason: 'Role is required' };
  }

  const actor = normalizeRoleCode(actorRole);
  const companyRoles = new Set((companyRoleCodes || []).map(normalizeRoleCode).filter(Boolean));
  const isSystemRole = SYSTEM_SET.has(wanted);

  // A role that is NOT built in but exists on this company is a company role
  // (created from a template or blank). Assigning it is role administration,
  // so only the role administrators may do it.
  if (!isSystemRole && companyRoles.has(wanted)) {
    const allowed = ROLE_ASSIGNERS.includes(actor);
    return {
      allowed,
      kind: allowed ? 'COMPANY' : 'NONE',
      reason: allowed ? '' : 'Only Company Admin or HR Manager can assign this role',
    };
  }

  // Built-in roles keep the existing rules exactly as they were.
  const allowed = (creationRights?.[actor] || []).includes(wanted);
  return {
    allowed,
    kind: isSystemRole ? 'SYSTEM' : 'NONE',
    reason: allowed ? '' : 'Your role cannot assign this role',
  };
};

// ── deactivating a role that still has members ─────────────────────────────
//
// A custom role cannot simply be switched off while people hold it: their
// permissions resolve through `roleRef`, so they would be stranded on an
// inactive role. The company has two honest choices: move the members to
// another role first, or ask for the move and the deactivation in one step.
//
// Pure — the caller supplies what it read from the database.
export const planRoleDeactivation = ({
  roleCode = '',
  memberCount = 0,
  reassignTo = '',
  companyRoleCodes = [],
  actorRole = '',
  creationRights = CREATION_RIGHTS,
} = {}) => {
  const count = Number(memberCount) || 0;
  if (count <= 0) return { action: 'DEACTIVATE', memberCount: 0 };

  const target = normalizeRoleCode(reassignTo);
  if (!target) {
    return {
      action: 'BLOCK',
      memberCount: count,
      reason: `${count} user(s) still hold this role. Move them to another role first, or reassign them while deactivating.`,
    };
  }

  // Reassigning into the role being deleted would be a no-op.
  if (target === normalizeRoleCode(roleCode)) {
    return {
      action: 'BLOCK',
      memberCount: count,
      reason: 'Choose a different role to move these users to.',
    };
  }

  // The role being deleted must not be offered as a destination either.
  const destinations = (companyRoleCodes || [])
    .map(normalizeRoleCode)
    .filter((code) => code && code !== normalizeRoleCode(roleCode));

  const verdict = classifyRoleAssignment({
    code: target,
    companyRoleCodes: destinations,
    actorRole,
    creationRights,
  });

  if (!verdict.allowed) {
    return {
      action: 'BLOCK',
      memberCount: count,
      reason: verdict.reason || 'You cannot move these users to that role',
    };
  }

  return {
    action: 'REASSIGN_AND_DEACTIVATE',
    memberCount: count,
    target: { code: target, kind: verdict.kind },
  };
};
