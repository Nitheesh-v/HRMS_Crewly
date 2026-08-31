import { body, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import CompanyRole from '../models/CompanyRole.js';
import { ROLES } from '../utils/constants.js';
import { classifyRoleAssignment } from '../utils/roleAssignmentRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

// Roles creatable from the UI (never SUPER_ADMIN / COMPANY_ADMIN)
const CREATABLE = [ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE];

// Phase 29.1 company roles (HR Head, Payroll Admin, Payroll Executive, ...)
// are assignable too, so the check cannot be a fixed list any more. The role
// must exist on THIS company and the actor must be allowed to assign it.
const companyRoleCodes = async (companyId) => {
  if (!companyId) return [];
  const roles = await CompanyRole.find({ companyId }).select('code').lean();
  return roles.map((role) => role.code);
};

// Structural shape first, then the tenant-scoped existence check.
const roleAssignable = async (value, { req }) => {
  const code = String(value || '').trim().toUpperCase();
  if (!code) throw new Error('Role is required');

  const codes = await companyRoleCodes(req?.companyId);
  const verdict = classifyRoleAssignment({
    code,
    companyRoleCodes: codes,
    actorRole: req?.user?.role,
  });

  if (!verdict.allowed) {
    throw new Error(
      verdict.reason ||
        (CREATABLE.includes(code)
          ? 'Your role cannot assign this role'
          : 'Unknown role for this company'),
    );
  }
  return true;
};

// Optional payroll/statutory fields (validated only when filled)
const payrollFields = [
  body('employeeCode').optional({ values: 'falsy' }).trim().isLength({ max: 20 }).withMessage('Employee code too long'),
  body('designation').optional({ values: 'falsy' }).trim().isLength({ max: 80 }).withMessage('Designation too long'),
  body('dateOfBirth').optional({ values: 'falsy' }).isISO8601().withMessage('Date of birth must be a valid date'),
  body('dateOfJoining').optional({ values: 'falsy' }).isISO8601().withMessage('Date of joining must be a valid date'),
  body('pan').optional({ values: 'falsy' }).trim().matches(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/).withMessage('PAN must look like ABCDE1234F'),
  body('uan').optional({ values: 'falsy' }).trim().matches(/^[0-9]{12}$/).withMessage('UAN must be 12 digits'),
  body('esic').optional({ values: 'falsy' }).trim().matches(/^[0-9]{10,17}$/).withMessage('ESIC must be 10–17 digits'),
  body('bankAccount').optional({ values: 'falsy' }).trim().matches(/^[0-9]{9,18}$/).withMessage('Account number must be 9–18 digits'),
  body('ifsc').optional({ values: 'falsy' }).trim().matches(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/).withMessage('IFSC must look like KKBK0008655'),
];

export const createUserRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ min: 2, max: 60 }).withMessage('Name must be 2–60 characters'),
  body('email').trim().isEmail().withMessage('Enter a valid email').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role').isString().trim().custom(roleAssignable),
  body('department').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid department'),
  body('reportingTo').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid reporting manager'),
  ...payrollFields,
  validate,
];

export const updateUserRules = [
  body('name').optional({ values: 'falsy' }).trim().isLength({ min: 2, max: 60 }).withMessage('Name must be 2–60 characters'),
  body('role').optional({ values: 'falsy' }).isString().trim().custom(roleAssignable),
  body('status').optional({ values: 'falsy' }).isIn(['ACTIVE', 'INACTIVE']).withMessage('Invalid status'),
  body('department').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid department'),
  body('reportingTo').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid reporting manager'),
  ...payrollFields,
  validate,
];

export const resetPasswordRules = [
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  validate,
];