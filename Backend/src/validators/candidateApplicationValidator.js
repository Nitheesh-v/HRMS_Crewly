import { body, param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const ALLOWED_FIELDS = new Set([
  'fullName',
  'email',
  'phone',
  'location',
  'currentCompany',
  'currentTitle',
  'totalExperience',
  'relevantExperience',
  'expectedSalary',
  'noticePeriod',
  'degree',
  'institution',
  'graduationYear',
  'skills',
  'linkedIn',
  'github',
  'portfolio',
  'consent',
]);

const rejectUnexpectedFields = (req, _res, next) => {
  const unexpected = Object.keys(req.body || {}).find(
    (field) => !ALLOWED_FIELDS.has(field)
  );

  if (unexpected) {
    throw ApiError.badRequest('Application contains an unsupported field');
  }

  return next();
};

const validate = (req, _res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) return next();

  const normalized = errors.array().map((error) => ({
    field: error.path,
    message: error.msg,
  }));

  throw ApiError.badRequest(
    normalized[0]?.message || 'Invalid application',
    normalized
  );
};

const optionalText = (field, maximum, message) =>
  body(field)
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: maximum })
    .withMessage(message);

const optionalHttpsUrl = (field, label) =>
  body(field)
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 300 })
    .withMessage(`${label} link is too long`)
    .isURL({
      protocols: ['https'],
      require_protocol: true,
      require_valid_protocol: true,
    })
    .withMessage(`${label} must be a valid HTTPS link`);

export const candidateApplicationRules = [
  rejectUnexpectedFields,
  param('companySlug')
    .trim()
    .toLowerCase()
    .isLength({ min: 3, max: 63 })
    .withMessage('Invalid career portal address')
    .matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .withMessage('Invalid career portal address'),
  param('jobCode')
    .trim()
    .toUpperCase()
    .isLength({ min: 4, max: 30 })
    .withMessage('Invalid job code')
    .matches(/^[A-Z0-9-]+$/)
    .withMessage('Invalid job code'),
  body('fullName')
    .trim()
    .notEmpty()
    .withMessage('Full name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Full name must be 2–100 characters'),
  body('email')
    .trim()
    .toLowerCase()
    .isLength({ max: 254 })
    .withMessage('Email is too long')
    .isEmail()
    .withMessage('Enter a valid email address'),
  body('phone')
    .trim()
    .matches(/^[0-9+()\-\s]{6,20}$/)
    .withMessage('Enter a valid phone number'),
  optionalText('location', 120, 'Location must be 120 characters or fewer'),
  optionalText(
    'currentCompany',
    120,
    'Current company must be 120 characters or fewer'
  ),
  optionalText(
    'currentTitle',
    120,
    'Current title must be 120 characters or fewer'
  ),
  body('totalExperience')
    .optional({ values: 'falsy' })
    .isFloat({ min: 0, max: 60 })
    .withMessage('Total experience must be between 0 and 60 years')
    .toFloat(),
  body('relevantExperience')
    .optional({ values: 'falsy' })
    .isFloat({ min: 0, max: 60 })
    .withMessage('Relevant experience must be between 0 and 60 years')
    .toFloat(),
  body('expectedSalary')
    .optional({ values: 'falsy' })
    .isFloat({ min: 0, max: 1000000000 })
    .withMessage('Expected salary is outside the supported range')
    .toFloat(),
  body('noticePeriod')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 365 })
    .withMessage('Notice period must be between 0 and 365 days')
    .toInt(),
  optionalText('degree', 120, 'Degree must be 120 characters or fewer'),
  optionalText(
    'institution',
    160,
    'Institution must be 160 characters or fewer'
  ),
  body('graduationYear')
    .optional({ values: 'falsy' })
    .isInt({ min: 1950, max: new Date().getFullYear() + 5 })
    .withMessage('Enter a valid graduation year')
    .toInt(),
  body('skills')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Skills must be 1000 characters or fewer'),
  optionalHttpsUrl('linkedIn', 'LinkedIn'),
  optionalHttpsUrl('github', 'GitHub'),
  optionalHttpsUrl('portfolio', 'Portfolio'),
  body('consent')
    .custom((value) => value === true || value === 'true')
    .withMessage('Consent is required to submit your application'),
  validate,
];
