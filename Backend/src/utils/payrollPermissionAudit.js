// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.1 RBAC UPDATE — PAYROLL PERMISSION CHANGE AUDIT
//
//  The existing role controller already writes a generic
//  `ROLE_PERMISSIONS_UPDATED` row. This module writes the PAYROLL-SPECIFIC
//  view the brief asks for (§11):
//
//    · who granted / revoked a payroll permission
//    · which role was changed
//    · which permission changed, previous state, new state
//    · timestamp + tenant (AuditLog already carries all of these)
//
//  Nothing is written when no payroll-family permission changed, so the
//  audit log stays readable.
//
//  PURE + injected: `audit` is passed in by the caller, so this module is
//  unit-testable without MongoDB.
// ═══════════════════════════════════════════════════════════════════════════

const PAYROLL_PREFIXES = [
  'PAYROLL_',
  'PAYROLL_SETUP_',
  'SALARY_',
  'EMPLOYEE_SALARY_',
  'PAYSLIP_',
];

export const isPayrollPermission = (name) => {
  const key = String(name || '').trim().toUpperCase();
  return PAYROLL_PREFIXES.some((prefix) => key.startsWith(prefix));
};

export const diffPermissionSets = (previous = [], next = []) => {
  const before = new Set((previous || []).map((name) => String(name).trim().toUpperCase()));
  const after = new Set((next || []).map((name) => String(name).trim().toUpperCase()));

  return {
    granted: [...after].filter((name) => !before.has(name)).sort(),
    revoked: [...before].filter((name) => !after.has(name)).sort(),
    unchanged: [...after].filter((name) => before.has(name)).sort(),
  };
};

// Writes one audit row per direction (granted / revoked) when payroll
// permissions changed. Never throws — auditing must not break role admin.
export const payrollPermissionChangeAudit = async ({
  audit,
  req,
  targetId,
  previousPermissions = [],
  nextPermissions = [],
  roleName = '',
  extraMetadata = {},
} = {}) => {
  if (typeof audit !== 'function') return [];

  const { granted, revoked } = diffPermissionSets(previousPermissions, nextPermissions);
  const grantedPayroll = granted.filter(isPayrollPermission);
  const revokedPayroll = revoked.filter(isPayrollPermission);

  if (!grantedPayroll.length && !revokedPayroll.length) return [];

  const rows = [];

  if (grantedPayroll.length) {
    rows.push({
      action: 'Payroll permission granted',
      previousValue: { permissions: grantedPayroll.map((name) => ({ permission: name, state: 'ABSENT' })) },
      newValue: { permissions: grantedPayroll.map((name) => ({ permission: name, state: 'GRANTED' })) },
    });
  }

  if (revokedPayroll.length) {
    rows.push({
      action: 'Payroll permission revoked',
      previousValue: { permissions: revokedPayroll.map((name) => ({ permission: name, state: 'GRANTED' })) },
      newValue: { permissions: revokedPayroll.map((name) => ({ permission: name, state: 'REVOKED' })) },
    });
  }

  const written = [];
  for (const row of rows) {
    try {
      await audit({
        req,
        action: row.action,
        targetType: 'CompanyRole',
        targetId,
        previousState: {
          ...row.previousValue,
          role: roleName,
          ...extraMetadata,
        },
        newState: {
          ...row.newValue,
          role: roleName,
          ...extraMetadata,
        },
      });
      written.push(row.action);
    } catch {
      // Audit failure never blocks role administration.
    }
  }

  return written;
};
