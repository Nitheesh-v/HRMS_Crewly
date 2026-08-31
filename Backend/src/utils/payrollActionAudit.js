// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.1 RBAC UPDATE — SENSITIVE PAYROLL ACTION AUDIT (§11)
//
//  §11 asks for an audit trail on sensitive payroll actions:
//
//    · salary changed
//    · payroll calculated / locked / reopened / approved / rejected
//    · bank file generated
//    · payroll marked paid
//    · payslips released / re-released
//
//  Those ACTIONS do not exist yet — they arrive with the later payroll
//  phases (29.2+). This module is the HOOK they will call, so no future
//  phase has to invent its own audit shape:
//
//    await payrollActionAudit({ audit, req, action: PAYROLL_AUDIT_ACTIONS.PAYROLL_LOCKED, period, target });
//
//  Deliberately NOT implemented here: the actions themselves.
//
//  PURE + injected: `audit` is passed in, so this is unit-testable without
//  MongoDB. Never throws — a failed audit row must never block a payroll run
//  that has already been authorised by Tenant → Role → Permission → Scope.
//
//  BANK DATA RULE: full account numbers are never written to the audit log.
//  `redactPayrollContext` masks every sensitive key it recognises.
// ═══════════════════════════════════════════════════════════════════════════

// Every audited action maps to the permission that authorises it. A test
// asserts each permission exists in the registry, so a future phase cannot
// audit an action whose permission was never created.
export const PAYROLL_AUDIT_ACTIONS = {
  SALARY_CHANGED: { action: 'Payroll salary changed', permission: 'EMPLOYEE_SALARY_MANAGE' },
  SALARY_REVISION_APPROVED: { action: 'Payroll salary revision approved', permission: 'SALARY_REVISION_APPROVE' },
  PAYROLL_PREPARED: { action: 'Payroll prepared', permission: 'PAYROLL_RUN_PREPARE' },
  PAYROLL_CALCULATED: { action: 'Payroll calculated', permission: 'PAYROLL_RUN_EXECUTE' },
  PAYROLL_RECALCULATED: { action: 'Payroll recalculated', permission: 'PAYROLL_RUN_RECALCULATE' },
  PAYROLL_REVIEWED: { action: 'Payroll reviewed', permission: 'PAYROLL_RUN_REVIEW' },
  PAYROLL_APPROVED: { action: 'Payroll approved', permission: 'PAYROLL_RUN_APPROVE' },
  PAYROLL_REJECTED: { action: 'Payroll rejected', permission: 'PAYROLL_RUN_REJECT' },
  PAYROLL_LOCKED: { action: 'Payroll locked', permission: 'PAYROLL_RUN_LOCK' },
  PAYROLL_REOPENED: { action: 'Payroll reopened', permission: 'PAYROLL_RUN_REOPEN' },
  BANK_FILE_GENERATED: { action: 'Payroll bank file generated', permission: 'PAYROLL_PAYMENT_GENERATE' },
  PAYMENT_CONFIRMED: { action: 'Payroll payment confirmed', permission: 'PAYROLL_PAYMENT_CONFIRM' },
  PAYROLL_MARKED_PAID: { action: 'Payroll marked paid', permission: 'PAYROLL_PAYMENT_MARK_PAID' },
  PAYSLIPS_GENERATED: { action: 'Payslips generated', permission: 'PAYSLIP_GENERATE' },
  PAYSLIPS_RELEASED: { action: 'Payslips released', permission: 'PAYSLIP_RELEASE' },
  PAYSLIP_RERELEASED: { action: 'Corrected payslip re-released', permission: 'PAYSLIP_RERELEASE' },
};

// "123456789012" → "XXXXXXXX9012" (last 4 only)
export const maskAccountNumber = (value) => {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';

  const tail = text.replace(/\s+/g, '').slice(-4);
  return `XXXXXXXX${tail}`;
};

const redactValue = (key, value) => {
  const keyName = String(key || '').toLowerCase();

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return redactPayrollContext(value);
  }

  if (keyName.includes('account')) return maskAccountNumber(value);

  // Statutory identifiers are recorded as present-or-absent, never in full.
  if (['pan', 'uan', 'esi'].some((token) => keyName.includes(token))) {
    return value ? '[REDACTED]' : '';
  }

  // Amounts stay visible — finance needs the totals to reconcile — but are
  // rounded to whole units so the log carries no paisa-level salary data.
  if (typeof value === 'number' && ['salary', 'ctc', 'amount', 'total'].some((token) => keyName.includes(token))) {
    return Math.round(value);
  }

  return value;
};

// Recursively masks sensitive payroll context before it reaches the log.
export const redactPayrollContext = (context = {}) => {
  if (!context || typeof context !== 'object') return {};

  return Object.entries(context).reduce((safe, [key, value]) => {
    safe[key] = redactValue(key, value);
    return safe;
  }, {});
};

// Writes one audit row for a sensitive payroll action.
// Returns the row (or null) — callers can ignore it.
export const payrollActionAudit = async ({
  audit,
  req,
  action,
  targetId = '',
  targetType = 'PayrollRun',
  period = '',
  context = {},
  actorId = '',
  companyId = '',
} = {}) => {
  if (typeof audit !== 'function') return null;

  const definition = PAYROLL_AUDIT_ACTIONS[action];
  const actionName = definition ? definition.action : action;

  const row = {
    req,
    action: actionName,
    targetType,
    targetId,
    previousState: {
      permission: definition ? definition.permission : '',
      period,
      actor: actorId || req?.user?._id || '',
      companyId: companyId || req?.companyId || '',
    },
    newState: {
      permission: definition ? definition.permission : '',
      period,
      actor: actorId || req?.user?._id || '',
      companyId: companyId || req?.companyId || '',
      // Bank data is masked before it is ever written (§10 / bank data rule).
      ...redactPayrollContext(context),
    },
  };

  try {
    await audit(row);
    return row;
  } catch {
    // Audit failure never blocks an authorised payroll action.
    return null;
  }
};
