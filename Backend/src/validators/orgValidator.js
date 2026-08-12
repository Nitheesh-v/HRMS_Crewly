import { body } from 'express-validator';
import { ROLES } from '../utils/constants.js';

export const createDepartmentValidator = [
  body('name').trim().notEmpty().withMessage('Department name is required').isLength({ max: 60 }),
  body('description').optional().trim().isLength({ max: 200 }).withMessage('Description max 200 characters'),
];

export const updateDepartmentValidator = [
  body('name').optional().trim().notEmpty().isLength({ max: 60 }),
  body('description').optional().trim().isLength({ max: 200 }),
  body('status').optional().isIn(['ACTIVE', 'INACTIVE']).withMessage('Invalid status'),
];

const orgRoles = [ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE];

export const createUserValidator = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').trim().isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').isIn(orgRoles).withMessage(`Role must be one of: ${orgRoles.join(', ')}`),
  body('department').optional({ nullable: true }).isMongoId().withMessage('Invalid department'),
  body('reportingTo').optional({ nullable: true }).isMongoId().withMessage('Invalid manager'),
  body('designation').optional().trim().isLength({ max: 60 }),
  body('phone').optional().trim().isLength({ max: 20 }),
];

export const updateUserValidator = [
  body('name').optional().trim().notEmpty(),
  body('role').optional().isIn(orgRoles),
  body('department').optional({ nullable: true }).isMongoId(),
  body('reportingTo').optional({ nullable: true }).isMongoId(),
  body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  body('designation').optional().trim().isLength({ max: 60 }),
  body('phone').optional().trim().isLength({ max: 20 }),
];

export const resetPasswordValidator = [
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
];