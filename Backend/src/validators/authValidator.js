import { body, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

// Collects validation errors → global error format
export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const list = errors.array().map((e) => ({ field: e.path, message: e.msg }));
    return next(ApiError.badRequest(list[0].message, list));
  }
  next();
};

export const registerCompanyValidator = [
  body('companyName').trim().notEmpty().withMessage('Company name is required').isLength({ min: 2, max: 80 }).withMessage('Company name must be 2–80 characters'),
  body('adminName').trim().notEmpty().withMessage('Your name is required'),
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

export const loginValidator = [
  body('companyCode').trim().notEmpty().withMessage('Company code is required'),
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];