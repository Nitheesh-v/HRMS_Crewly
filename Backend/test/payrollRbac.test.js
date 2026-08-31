import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Hermetic suite: no MongoDB, no Redis, no network.
process.env.REDIS_ENABLED ||= 'false';

const [registry, templates, scope, auditRules, access, roleModel, actionAudit] = await Promise.all([
  import('../src/utils/permissionRegistry.js'),
  import('../src/utils/roleTemplates.js'),
  import('../src/utils/payrollScope.js'),
  import('../src/utils/payrollPermissionAudit.js'),
  import('../src/services/payroll/payrollAccessService.js'),
  import('../src/models/CompanyRole.js'),
  import('../src/utils/payrollActionAudit.js'),
]);

const { DEFAULT_PERMISSIONS, DEFAULT_ROLE_MATRIX, RESOURCES, ACTIONS } = registry;
const {
  ROLE_TEMPLATES,
  ROLE_TEMPLATE_KEYS,
  SEPARATION_OF_DUTIES_RULES,
  findRoleTemplate,
  serializeRoleTemplates,
  TEMPLATE_CONFLICTS_SYSTEM_ROLES,
} = templates;
const {
  PAYROLL_SCOPES,
  PAYROLL_SCOPE_LIST,
  canAccessSubject,
  defaultScopeForRole,
  resolvePayrollScope,
} = scope;
const { diffPermissionSets, isPayrollPermission } = auditRules;
const {
  PAYROLL_AUDIT_ACTIONS,
  maskAccountNumber,
  payrollActionAudit,
  redactPayrollContext,
} = actionAudit;

const ALL_NAMES = DEFAULT_PERMISSIONS.map((permission) => permission.name);
const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

// ═══════════════════════════════════════════════════════════════════════════
// §3 — Granular payroll permission catalogue
// ═══════════════════════════════════════════════════════════════════════════

test('every payroll permission from the brief exists in the registry', () => {
  const expected = [
    // Setup
    'PAYROLL_SETUP_READ',
    'PAYROLL_SETUP_UPDATE',
    'PAYROLL_SETUP_ACTIVATE',
    // Salary configuration
    'SALARY_COMPONENT_READ',
    'SALARY_COMPONENT_MANAGE',
    'SALARY_STRUCTURE_READ',
    'SALARY_STRUCTURE_MANAGE',
    'SALARY_STRUCTURE_ASSIGN',
    'EMPLOYEE_SALARY_READ',
    'EMPLOYEE_SALARY_MANAGE',
    'SALARY_REVISION_APPROVE',
    // Processing
    'PAYROLL_RUN_READ',
    'PAYROLL_RUN_PREPARE',
    'PAYROLL_RUN_EXECUTE',
    'PAYROLL_RUN_RECALCULATE',
    'PAYROLL_RUN_REVIEW',
    'PAYROLL_RUN_LOCK',
    'PAYROLL_RUN_REOPEN',
    // Approval
    'PAYROLL_RUN_APPROVE',
    'PAYROLL_RUN_REJECT',
    // Payment
    'PAYROLL_PAYMENT_GENERATE',
    'PAYROLL_PAYMENT_READ',
    'PAYROLL_PAYMENT_CONFIRM',
    'PAYROLL_PAYMENT_MARK_PAID',
    // Payslips
    'PAYSLIP_GENERATE',
    'PAYSLIP_RELEASE',
    'PAYSLIP_RERELEASE',
    'PAYSLIP_READ',
    'PAYSLIP_READ_SELF',
    // Compliance
    'PAYROLL_STATUTORY_MANAGE',
    'PAYROLL_STATUTORY_READ',
    'PAYROLL_STATUTORY_GENERATE',
    // Reports
    'PAYROLL_REPORT_READ',
    'PAYROLL_REPORT_EXPORT',
  ];

  for (const name of expected) {
    assert.ok(ALL_NAMES.includes(name), `${name} must exist`);
  }
});

test('new payroll permissions keep the existing RESOURCE_ACTION convention', () => {
  const payrollResources = [
    'PAYROLL_SETUP',
    'SALARY_COMPONENT',
    'SALARY_STRUCTURE',
    'EMPLOYEE_SALARY',
    'SALARY_REVISION',
    'PAYROLL_RUN',
    'PAYROLL_PAYMENT',
    'PAYROLL_STATUTORY',
    'PAYROLL_REPORT',
    'PAYSLIP',
  ];

  for (const resource of payrollResources) {
    assert.ok(RESOURCES.includes(resource), `${resource} must be a registered resource`);
  }
  for (const action of [
    'PREPARE', 'EXECUTE', 'RECALCULATE', 'REVIEW', 'LOCK', 'REOPEN',
    'ASSIGN', 'GENERATE', 'CONFIRM', 'RELEASE', 'RERELEASE', 'MARK_PAID',
  ]) {
    assert.ok(ACTIONS.includes(action), `${action} must be a registered action`);
  }

  // Every payroll permission resolves to "<RESOURCE>_<ACTION>" with both
  // halves registered — no free-text permission names.
  for (const permission of DEFAULT_PERMISSIONS) {
    if (!payrollResources.includes(permission.resource)) continue;
    assert.ok(ACTIONS.includes(permission.action), `${permission.name} uses an unregistered action`);
    // Existing convention: RESOURCE_ACTION, or RESOURCE_ACTION_SCOPE for
    // self-scoped permissions (PAYSLIP_READ_SELF).
    const expected =
      permission.scope === 'ALL'
        ? `${permission.resource}_${permission.action}`
        : `${permission.resource}_${permission.action}_${permission.scope}`;
    assert.equal(permission.name, expected);
  }
});

test('every payroll permission is gated by the payroll subscription feature', async () => {
  const source = await readFile(new URL('../src/utils/permissionService.js', import.meta.url), 'utf8');
  for (const key of [
    'PAYROLL_SETUP',
    'SALARY_COMPONENT',
    'SALARY_STRUCTURE',
    'EMPLOYEE_SALARY',
    'SALARY_REVISION',
    'PAYROLL_RUN',
    'PAYROLL_PAYMENT',
    'PAYROLL_STATUTORY',
    'PAYROLL_REPORT',
    'PAYSLIP',
  ]) {
    assert.match(source, new RegExp(`${key}:\\s*"payroll"`), `${key} must map to the payroll feature`);
  }
});

test('permission version is at least the current payroll baseline', async () => {
  const source = await readFile(new URL('../src/utils/permissionService.js', import.meta.url), 'utf8');
  const version = Number(source.match(/SYSTEM_PERMISSION_VERSION\s*=\s*(\d+)/)?.[1]);
  // 14 = 29.1 payroll setup, 15 = 29.1 RBAC update, 16 = 29.2 components.
  assert.ok(version >= 15, `expected migration version >= 15, got ${version}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 / §13 — Company Admin is not the payroll manager: delegation
// ═══════════════════════════════════════════════════════════════════════════

test('Company Admin still holds every payroll permission (default policy)', () => {
  const payrollNames = ALL_NAMES.filter(
    (name) => /^(PAYROLL|SALARY|EMPLOYEE_SALARY|PAYSLIP)/.test(name) && !name.endsWith('_SELF'),
  );
  for (const name of payrollNames) {
    assert.ok(
      DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(name),
      `Company Admin default must include ${name}`,
    );
  }
});

test('HR Manager can run payroll but cannot approve it or move money', () => {
  const hr = DEFAULT_ROLE_MATRIX.HR_MANAGER;
  for (const name of [
    'PAYROLL_RUN_READ',
    'PAYROLL_RUN_PREPARE',
    'PAYROLL_RUN_EXECUTE',
    'PAYROLL_RUN_RECALCULATE',
    'PAYROLL_RUN_REVIEW',
    'SALARY_STRUCTURE_MANAGE',
    'EMPLOYEE_SALARY_MANAGE',
    'PAYROLL_REPORT_READ',
  ]) {
    assert.ok(hr.includes(name), `HR Manager should hold ${name}`);
  }
  for (const name of [
    'PAYROLL_RUN_APPROVE',
    'PAYROLL_PAYMENT_CONFIRM',
    'PAYROLL_PAYMENT_MARK_PAID',
    'PAYSLIP_RELEASE',
    'PAYROLL_SETUP_ACTIVATE',
  ]) {
    assert.equal(hr.includes(name), false, `HR Manager must not hold ${name} by default`);
  }
});

test('Manager, Team Lead and Employee hold no company-wide payroll permission', () => {
  const forbidden = [
    'PAYROLL_RUN_READ',
    'PAYROLL_RUN_EXECUTE',
    'PAYROLL_RUN_APPROVE',
    'EMPLOYEE_SALARY_READ',
    'EMPLOYEE_SALARY_MANAGE',
    'PAYROLL_PAYMENT_GENERATE',
    'PAYROLL_PAYMENT_CONFIRM',
    'PAYSLIP_READ',
    'PAYSLIP_RELEASE',
    'PAYROLL_REPORT_READ',
  ];
  for (const role of ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE']) {
    for (const name of forbidden) {
      assert.equal(
        DEFAULT_ROLE_MATRIX[role].includes(name),
        false,
        `${role} must never hold ${name}`,
      );
    }
  }
  // Employees keep self-service only.
  assert.ok(DEFAULT_ROLE_MATRIX.EMPLOYEE.includes('PAYSLIP_READ_SELF'));
});

// ═══════════════════════════════════════════════════════════════════════════
// §13 — Role templates are data, never seeded
// ═══════════════════════════════════════════════════════════════════════════

test('six payroll role templates exist and are not seeded system roles', () => {
  assert.deepEqual([...ROLE_TEMPLATE_KEYS], [
    'HR_HEAD',
    'HR_EXECUTIVE',
    'PAYROLL_ADMIN',
    'PAYROLL_EXECUTIVE',
    'FINANCE_MANAGER',
    'FINANCE_EXECUTIVE',
  ]);

  // Not part of the seeded role matrix and not a protected system role.
  for (const key of ROLE_TEMPLATE_KEYS) {
    assert.equal(key in DEFAULT_ROLE_MATRIX, false, `${key} must not be seeded`);
  }
  assert.deepEqual(TEMPLATE_CONFLICTS_SYSTEM_ROLES(), []);
  assert.ok(!roleModel.SYSTEM_COMPANY_ROLES.includes('HR_HEAD'));
  assert.deepEqual(roleModel.SYSTEM_COMPANY_ROLES, [
    'COMPANY_ADMIN',
    'HR_MANAGER',
    'MANAGER',
    'TEAM_LEAD',
    'EMPLOYEE',
  ]);
});

test('templates only reference permissions that exist', () => {
  for (const template of ROLE_TEMPLATES) {
    for (const permission of template.permissions) {
      assert.ok(ALL_NAMES.includes(permission), `${template.key} references unknown ${permission}`);
    }
  }
  for (const template of serializeRoleTemplates()) {
    assert.ok(template.permissions.length > 0);
    assert.ok(template.defaultScope in PAYROLL_SCOPES);
    for (const permission of template.permissions) {
      assert.ok(ALL_NAMES.includes(permission));
    }
  }
});

test('separation of duties holds, or is explicitly declared, in every preset', () => {
  for (const template of ROLE_TEMPLATES) {
    const has = (name) => template.permissions.includes(name);
    const excused = template.separationException?.rules || [];
    for (const rule of SEPARATION_OF_DUTIES_RULES) {
      const concentrated = has(rule.run) && has(rule.approve);
      if (!concentrated) continue;
      assert.ok(
        excused.includes(rule.id),
        `${template.key} concentrates duties without declaring it: ${rule.message}`,
      );
      assert.ok(
        template.separationException.reason,
        `${template.key} must document why it concentrates ${rule.id}`,
      );
    }
    // A declared exception must always name a real rule.
    for (const id of excused) {
      assert.ok(
        SEPARATION_OF_DUTIES_RULES.some((rule) => rule.id === id),
        `${template.key} declares an unknown rule ${id}`,
      );
    }
  }
  // Explicit expectations from the brief.
  const payrollExec = findRoleTemplate('PAYROLL_EXECUTIVE');
  assert.ok(payrollExec.permissions.includes('PAYROLL_RUN_EXECUTE'));
  assert.ok(payrollExec.permissions.includes('PAYSLIP_GENERATE'));
  assert.equal(payrollExec.permissions.includes('PAYROLL_RUN_APPROVE'), false);
  assert.equal(payrollExec.permissions.includes('PAYROLL_PAYMENT_CONFIRM'), false);

  const finance = findRoleTemplate('FINANCE_MANAGER');
  assert.ok(finance.permissions.includes('PAYROLL_RUN_APPROVE'));
  assert.ok(finance.separationException, 'Finance Manager must declare its duty concentration');
  assert.ok(finance.permissions.includes('PAYROLL_PAYMENT_CONFIRM'));
  assert.ok(finance.permissions.includes('PAYROLL_PAYMENT_MARK_PAID'));
  assert.equal(finance.permissions.includes('EMPLOYEE_SALARY_MANAGE'), false);

  const hrExec = findRoleTemplate('HR_EXECUTIVE');
  assert.ok(hrExec.permissions.includes('PAYROLL_RUN_PREPARE'));
  assert.equal(hrExec.permissions.includes('PAYROLL_RUN_APPROVE'), false);
  assert.equal(hrExec.permissions.includes('PAYROLL_PAYMENT_GENERATE'), false);
  assert.equal(hrExec.defaultScope, PAYROLL_SCOPES.ASSIGNED_DEPARTMENTS);

  const hrHead = findRoleTemplate('HR_HEAD');
  assert.ok(hrHead.permissions.includes('PAYROLL_RUN_APPROVE'));
  assert.ok(hrHead.permissions.includes('SALARY_REVISION_APPROVE'));
  assert.equal(hrHead.permissions.includes('PAYROLL_PAYMENT_CONFIRM'), false);
});

test('unknown templates resolve to null', () => {
  assert.equal(findRoleTemplate('NOT_A_TEMPLATE'), null);
  assert.equal(findRoleTemplate(''), null);
  assert.ok(findRoleTemplate('payroll_admin'), 'template lookup is case-insensitive');
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 — Organizational scope
// ═══════════════════════════════════════════════════════════════════════════

test('scope vocabulary covers the required reach levels', () => {
  assert.deepEqual([...PAYROLL_SCOPE_LIST], [
    'SELF',
    'TEAM',
    'DEPARTMENT',
    'ASSIGNED_DEPARTMENTS',
    'COMPANY',
  ]);
});

test('role defaults match the organizational model', () => {
  assert.equal(defaultScopeForRole('COMPANY_ADMIN'), 'COMPANY');
  assert.equal(defaultScopeForRole('HR_MANAGER'), 'COMPANY');
  assert.equal(defaultScopeForRole('HR_HEAD'), 'COMPANY');
  assert.equal(defaultScopeForRole('PAYROLL_ADMIN'), 'COMPANY');
  assert.equal(defaultScopeForRole('PAYROLL_EXECUTIVE'), 'COMPANY');
  assert.equal(defaultScopeForRole('FINANCE_MANAGER'), 'COMPANY');
  assert.equal(defaultScopeForRole('HR_EXECUTIVE'), 'ASSIGNED_DEPARTMENTS');
  assert.equal(defaultScopeForRole('MANAGER'), 'TEAM');
  assert.equal(defaultScopeForRole('TEAM_LEAD'), 'TEAM');
  assert.equal(defaultScopeForRole('EMPLOYEE'), 'SELF');
  assert.equal(defaultScopeForRole('UNKNOWN_ROLE'), 'SELF', 'unknown roles default to least privilege');
});

test('scope resolution: role default → role override → per-permission override', () => {
  const base = resolvePayrollScope({ roleCode: 'MANAGER', permission: 'PAYROLL_RUN_READ' });
  assert.equal(base, 'TEAM');

  const roleOverride = resolvePayrollScope({
    roleCode: 'MANAGER',
    permission: 'PAYROLL_RUN_READ',
    customRoleDefaultScope: 'DEPARTMENT',
  });
  assert.equal(roleOverride, 'DEPARTMENT');

  const permissionOverride = resolvePayrollScope({
    roleCode: 'HR_MANAGER',
    permission: 'EMPLOYEE_SALARY_READ',
    permissionScopes: [{ permission: 'EMPLOYEE_SALARY_READ', scope: 'ASSIGNED_DEPARTMENTS' }],
  });
  assert.equal(permissionOverride, 'ASSIGNED_DEPARTMENTS');

  // The override only applies to the permission it names.
  const other = resolvePayrollScope({
    roleCode: 'HR_MANAGER',
    permission: 'PAYROLL_RUN_READ',
    permissionScopes: [{ permission: 'EMPLOYEE_SALARY_READ', scope: 'ASSIGNED_DEPARTMENTS' }],
  });
  assert.equal(other, 'COMPANY');

  // Invalid values never widen the scope.
  const bogus = resolvePayrollScope({
    roleCode: 'EMPLOYEE',
    permission: 'EMPLOYEE_SALARY_READ',
    permissionScopes: [{ permission: 'EMPLOYEE_SALARY_READ', scope: 'WHOLE_INTERNET' }],
  });
  assert.equal(bogus, 'SELF');
});

test('scope enforcement: SELF, DEPARTMENT, ASSIGNED_DEPARTMENTS, COMPANY', () => {
  const actor = { _id: 'u1', companyId: COMPANY_A, department: 'd1', assignedDepartments: ['d9'] };
  const teammate = { _id: 'u2', companyId: COMPANY_A, department: 'd1' };
  const stranger = { _id: 'u3', companyId: COMPANY_A, department: 'd7' };

  assert.equal(canAccessSubject({ actor, subject: actor, scope: 'SELF' }), true);
  assert.equal(canAccessSubject({ actor, subject: teammate, scope: 'SELF' }), false);

  assert.equal(canAccessSubject({ actor, subject: teammate, scope: 'DEPARTMENT' }), true);
  assert.equal(canAccessSubject({ actor, subject: stranger, scope: 'DEPARTMENT' }), false);

  assert.equal(
    canAccessSubject({ actor, subject: { _id: 'u4', companyId: COMPANY_A, department: 'd9' }, scope: 'ASSIGNED_DEPARTMENTS' }),
    true,
  );
  assert.equal(canAccessSubject({ actor, subject: stranger, scope: 'ASSIGNED_DEPARTMENTS' }), false);

  assert.equal(canAccessSubject({ actor, subject: stranger, scope: 'COMPANY' }), true);
});

test('scope enforcement: TEAM needs the reporting subtree', () => {
  const actor = { _id: 'manager1', companyId: COMPANY_A };
  const report = { _id: 'emp1', companyId: COMPANY_A };
  const unrelated = { _id: 'emp2', companyId: COMPANY_A };

  assert.equal(canAccessSubject({ actor, subject: report, scope: 'TEAM', teamIds: ['emp1'] }), true);
  assert.equal(canAccessSubject({ actor, subject: unrelated, scope: 'TEAM', teamIds: ['emp1'] }), false);
  assert.equal(
    canAccessSubject({ actor, subject: report, scope: 'TEAM', teamIds: null }),
    false,
    'without a resolved subtree TEAM grants nothing',
  );
  assert.equal(canAccessSubject({ actor, subject: actor, scope: 'TEAM', teamIds: [] }), true);
});

test('cross-tenant access is refused even with COMPANY scope', () => {
  const actor = { _id: 'u1', companyId: COMPANY_A };
  const foreign = { _id: 'u9', companyId: COMPANY_B };
  assert.equal(canAccessSubject({ actor, subject: foreign, scope: 'COMPANY' }), false);
  assert.equal(canAccessSubject({ actor, subject: foreign, scope: 'SELF' }), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 / §11 — Full-chain access decision + permission change audit
// ═══════════════════════════════════════════════════════════════════════════

test('payroll record access follows tenant → role → permission → scope', async () => {
  const subject = { _id: 'emp1', companyId: COMPANY_A, department: 'd1' };

  // Tenant breach first: COMPANY scope cannot cross companies.
  assert.equal(
    await access.canReadEmployeePayroll({
      actor: { _id: 'admin', companyId: COMPANY_B, role: 'COMPANY_ADMIN' },
      subject: { _id: 'emp1', companyId: COMPANY_A },
      hasPermissionFn: async () => true,
    }),
    false,
  );

  // Employee: own record yes, colleague no.
  const employee = { _id: 'emp2', companyId: COMPANY_A, role: 'EMPLOYEE', department: 'd1' };
  assert.equal(
    await access.canReadEmployeePayroll({
      actor: employee,
      subject: { _id: 'emp2', companyId: COMPANY_A },
      hasPermissionFn: async () => false,
    }),
    true,
  );
  assert.equal(
    await access.canReadEmployeePayroll({
      actor: employee,
      subject,
      hasPermissionFn: async () => false,
    }),
    false,
  );

  // Delegated Payroll Admin: permission + COMPANY scope → allowed.
  assert.equal(
    await access.canReadEmployeePayroll({
      actor: { _id: 'pa', companyId: COMPANY_A, role: 'PAYROLL_ADMIN' },
      subject,
      hasPermissionFn: async (_user, name) => name === 'EMPLOYEE_SALARY_READ',
      roleLookup: async () => ({ code: 'PAYROLL_ADMIN', payrollScope: 'COMPANY', permissionScopes: [] }),
    }),
    true,
  );

  // Same role without the permission → refused.
  assert.equal(
    await access.canReadEmployeePayroll({
      actor: { _id: 'pa', companyId: COMPANY_A, role: 'PAYROLL_ADMIN' },
      subject,
      hasPermissionFn: async () => false,
      roleLookup: async () => ({ code: 'PAYROLL_ADMIN', payrollScope: 'COMPANY', permissionScopes: [] }),
    }),
    false,
  );

  // Manager with TEAM scope: in-subtree yes, out-of-subtree no.
  const manager = { _id: 'mgr', companyId: COMPANY_A, role: 'MANAGER', department: 'd1' };
  assert.equal(
    await access.canReadEmployeePayroll({
      actor: manager,
      subject,
      hasPermissionFn: async () => true,
      roleLookup: async () => ({ code: 'MANAGER', payrollScope: '', permissionScopes: [] }),
      subtreeResolver: async () => ['emp1'],
    }),
    true,
  );
  assert.equal(
    await access.canReadEmployeePayroll({
      actor: manager,
      subject: { _id: 'other', companyId: COMPANY_A, department: 'd1' },
      hasPermissionFn: async () => true,
      roleLookup: async () => ({ code: 'MANAGER', payrollScope: '', permissionScopes: [] }),
      subtreeResolver: async () => ['emp1'],
    }),
    false,
  );

  // Legacy HR Manager keeps access even without the new permission.
  assert.equal(
    await access.canReadEmployeePayroll({
      actor: { _id: 'hr', companyId: COMPANY_A, role: 'HR_MANAGER' },
      subject,
      hasPermissionFn: async () => false,
      roleLookup: async () => null,
    }),
    true,
  );
});

test('payslip access reuses the same chain with PAYSLIP_READ', async () => {
  const subject = { _id: 'emp1', companyId: COMPANY_A };
  assert.equal(
    await access.canReadPayslip({
      actor: { _id: 'pa', companyId: COMPANY_A, role: 'PAYROLL_ADMIN' },
      subject,
      hasPermissionFn: async (_user, name) => name === 'PAYSLIP_READ',
      roleLookup: async () => ({ code: 'PAYROLL_ADMIN', payrollScope: 'COMPANY', permissionScopes: [] }),
    }),
    true,
  );
  assert.equal(
    await access.canReadPayslip({
      actor: { _id: 'pa', companyId: COMPANY_A, role: 'PAYROLL_ADMIN' },
      subject,
      hasPermissionFn: async () => false,
      roleLookup: async () => ({ code: 'PAYROLL_ADMIN', payrollScope: 'COMPANY', permissionScopes: [] }),
    }),
    false,
  );
});

test('permission changes are diffed into granted/revoked sets', () => {
  assert.equal(isPayrollPermission('PAYROLL_RUN_APPROVE'), true);
  assert.equal(isPayrollPermission('EMPLOYEE_SALARY_READ'), true);
  assert.equal(isPayrollPermission('PAYSLIP_READ_SELF'), true);
  assert.equal(isPayrollPermission('LEAVE_APPROVE'), false);

  const diff = diffPermissionSets(
    ['PAYROLL_RUN_READ', 'PAYROLL_RUN_APPROVE', 'LEAVE_READ'],
    ['PAYROLL_RUN_READ', 'PAYROLL_PAYMENT_CONFIRM', 'LEAVE_READ'],
  );
  assert.deepEqual(diff.granted, ['PAYROLL_PAYMENT_CONFIRM']);
  assert.deepEqual(diff.revoked, ['PAYROLL_RUN_APPROVE']);
  assert.deepEqual(diff.unchanged, ['LEAVE_READ', 'PAYROLL_RUN_READ']);
});

test('payroll audit rows are written only when payroll permissions changed', async () => {
  const rows = [];
  const audit = async (entry) => {
    rows.push(entry);
    return null;
  };

  // Non-payroll change → no extra audit rows.
  const none = await auditRules.payrollPermissionChangeAudit({
    audit,
    req: { companyId: COMPANY_A, user: { _id: 'u1', name: 'Admin', role: 'COMPANY_ADMIN' } },
    targetId: 'role1',
    previousPermissions: ['LEAVE_READ'],
    nextPermissions: ['LEAVE_READ', 'LEAVE_APPROVE'],
    roleName: 'HR Executive',
  });
  assert.deepEqual(none, []);
  assert.equal(rows.length, 0);

  // Payroll grant + revoke in one save → two rows, both naming the role.
  const written = await auditRules.payrollPermissionChangeAudit({
    audit,
    req: { companyId: COMPANY_A, user: { _id: 'u1', name: 'Admin', role: 'COMPANY_ADMIN' } },
    targetId: 'role1',
    previousPermissions: ['PAYROLL_RUN_APPROVE'],
    nextPermissions: ['PAYROLL_PAYMENT_CONFIRM'],
    roleName: 'Finance Manager',
  });
  assert.deepEqual(written, ['Payroll permission granted', 'Payroll permission revoked']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].newState.role, 'Finance Manager');
  assert.equal(rows[0].newState.permissions[0].state, 'GRANTED');
  assert.equal(rows[1].newState.permissions[0].state, 'REVOKED');
  assert.equal(rows[1].previousState.permissions[0].state, 'GRANTED');
  assert.equal(rows[0].targetType, 'CompanyRole');
});

test('audit failures never break role administration', async () => {
  const result = await auditRules.payrollPermissionChangeAudit({
    audit: async () => {
      throw new Error('audit down');
    },
    req: { companyId: COMPANY_A, user: { _id: 'u1' } },
    targetId: 'role1',
    previousPermissions: [],
    nextPermissions: ['PAYROLL_RUN_APPROVE'],
    roleName: 'HR Head',
  });
  assert.deepEqual(result, []);
});

// ── §11 — sensitive payroll action audit hooks (29.2+ will call these) ──────

test('every sensitive payroll action maps to a permission that exists', () => {
  const known = new Set(DEFAULT_PERMISSIONS.map((permission) => permission.name));

  for (const [key, definition] of Object.entries(PAYROLL_AUDIT_ACTIONS)) {
    assert.ok(known.has(definition.permission), `${key} maps to unknown permission ${definition.permission}`);
  }

  // The actions §11 explicitly lists must all be covered.
  for (const action of [
    'SALARY_CHANGED',
    'PAYROLL_CALCULATED',
    'PAYROLL_LOCKED',
    'PAYROLL_APPROVED',
    'BANK_FILE_GENERATED',
    'PAYROLL_MARKED_PAID',
    'PAYSLIPS_RELEASED',
  ]) {
    assert.ok(PAYROLL_AUDIT_ACTIONS[action], `missing audit hook for ${action}`);
  }
});

test('bank account numbers are masked before they reach the audit log', () => {
  assert.equal(maskAccountNumber('123456789012'), 'XXXXXXXX9012');
  assert.equal(maskAccountNumber(''), '');
  assert.equal(maskAccountNumber(null), '');

  const safe = redactPayrollContext({
    bankAccountNumber: '123456789012',
    employeeName: 'John',
    panNumber: 'ABCPD1234K',
    netSalary: 84520.75,
  });

  assert.equal(safe.bankAccountNumber, 'XXXXXXXX9012');
  assert.equal(safe.employeeName, 'John', 'non-sensitive context is preserved');
  assert.equal(safe.panNumber, '[REDACTED]');
  assert.equal(safe.netSalary, 84521, 'amounts are rounded to whole units');
  assert.ok(!JSON.stringify(safe).includes('123456789012'));
  assert.ok(!JSON.stringify(safe).includes('ABCPD1234K'));
});

test('sensitive payroll actions are audited with actor, tenant and period', async () => {
  const rows = [];
  const audit = async (row) => rows.push(row);

  const written = await payrollActionAudit({
    audit,
    req: { user: { _id: 'actor-1' }, companyId: 'company-a' },
    action: 'PAYROLL_LOCKED',
    targetId: 'run-42',
    period: '2026-08',
    context: { bankAccountNumber: '123456789012', totalNetPay: 4821500.4 },
  });

  assert.ok(written);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'Payroll locked');
  assert.equal(rows[0].targetId, 'run-42');
  assert.equal(rows[0].previousState.actor, 'actor-1');
  assert.equal(rows[0].previousState.companyId, 'company-a');
  assert.equal(rows[0].previousState.period, '2026-08');
  assert.equal(rows[0].newState.permission, 'PAYROLL_RUN_LOCK');
  assert.equal(rows[0].newState.bankAccountNumber, 'XXXXXXXX9012');
  assert.ok(!JSON.stringify(rows[0]).includes('123456789012'));
});

test('a failing action audit never blocks an authorised payroll action', async () => {
  const written = await payrollActionAudit({
    audit: async () => {
      throw new Error('audit store offline');
    },
    req: { user: { _id: 'actor-1' }, companyId: 'company-a' },
    action: 'PAYSLIPS_RELEASED',
  });

  assert.equal(written, null);
});

test('action audit is a no-op without an audit function', async () => {
  assert.equal(await payrollActionAudit({ action: 'PAYROLL_APPROVED' }), null);
});
