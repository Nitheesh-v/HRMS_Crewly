import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEmployeePayroll } from '../src/services/payroll/employeePayrollRules.js';
import { defaultEmployeePayroll } from '../src/services/payroll/employeePayrollRules.js';

// §23 — in-place edits must not collide with the profile's own version.
const SAME = new Date('2026-09-10T00:00:00.000Z');
const structure = { _id: 's1', status: 'ACTIVE', items: [] };
const base = {
  ...defaultEmployeePayroll(),
  structureId: 's1',
  annualCtc: 480000,
  monthlyGross: 40000,
  effectiveFrom: SAME,
  bank: { bankName: 'TMB', accountHolderName: 'jana', ifsc: 'HDFC0001234', accountType: 'SAVINGS' },
};
const opts = (versions, selfId) => ({
  statutory: {},
  structure,
  existingVersions: versions,
  selfEffectiveFrom: SAME,
  ...(selfId ? {} : {}),
  versions,
  selfId,
});

const effectiveErrors = (errors) =>
  errors.filter((error) => error.field === 'effectiveFrom').map((error) => error.message);

test('§23 an in-place edit keeps its own effective date without collision', () => {
  const errors = validateEmployeePayroll(
    { ...base, _id: 'p1' },
    {
      statutory: {},
      structure,
      existingVersions: [{ _id: 'p1', effectiveFrom: SAME }],
      selfEffectiveFrom: SAME,
    },
  );
  assert.deepEqual(effectiveErrors(errors), [], 'own version date is not a duplicate');
});

test('§23 a different version on the same date is still refused', () => {
  const errors = validateEmployeePayroll(
    { ...base, _id: 'p2' },
    {
      statutory: {},
      structure,
      existingVersions: [{ _id: 'p1', effectiveFrom: SAME }],
      selfEffectiveFrom: SAME,
    },
  );
  assert.ok(
    effectiveErrors(errors).includes('Another revision already starts on this date'),
    'distinct version same date refused',
  );
});

test('§23 an earlier date than the current version is still refused', () => {
  const errors = validateEmployeePayroll(
    { ...base, _id: 'p1', effectiveFrom: new Date('2026-09-01T00:00:00.000Z') },
    {
      statutory: {},
      structure,
      existingVersions: [{ _id: 'p1', effectiveFrom: SAME }],
      selfEffectiveFrom: SAME,
    },
  );
  assert.ok(
    effectiveErrors(errors).includes('A revision cannot start before the salary it replaces'),
  );
});
