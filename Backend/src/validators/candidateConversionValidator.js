import { body, param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import { ROLES } from '../utils/constants.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed'));
  }
  return next();
};

export const conversionCandidateRules = [
  param('candidateId')
    .trim()
    .notEmpty()
    .withMessage('Candidate is required')
    .isLength({ max: 40 })
    .withMessage('Candidate reference is invalid'),
  validate,
];

export const convertToEmployeeRules = [
  param('candidateId')
    .trim()
    .notEmpty()
    .withMessage('Candidate is required')
    .isLength({ max: 40 }),
  body('employeeCode')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 20 })
    .withMessage('Employee code is too long'),
  body('departmentId')
    .notEmpty()
    .withMessage('Department is required')
    .isMongoId()
    .withMessage('Choose a valid department'),
  body('managerId')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('Choose a valid manager'),
  body('reportingTo')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('Choose a valid reporting manager'),
  body('shiftId')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('Choose a valid shift'),
  body('roleId')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('Choose a valid company role'),
  body('role')
    .optional()
    .isIn([ROLES.EMPLOYEE, ROLES.TEAM_LEAD, ROLES.MANAGER, ROLES.HR_MANAGER])
    .withMessage('Choose a valid assignable role'),
  body('designation')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 80 })
    .withMessage('Designation is too long'),
  body('location')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 120 }),
  body('employmentType')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'])
    .withMessage('Choose a valid employment type'),
  body('joiningDate')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Joining date must be a valid date'),
  body('name')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 2, max: 60 }),
  body('phone')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 20 }),
  validate,
];

export const employeeIdRules = [
  param('employeeId').isMongoId().withMessage('Choose a valid employee'),
  validate,
];
