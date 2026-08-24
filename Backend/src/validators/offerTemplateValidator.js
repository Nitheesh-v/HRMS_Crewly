import { body, param, query, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const normalized = errors.array().map((error) => ({ field: error.path, message: error.msg }));
  throw ApiError.badRequest(normalized[0]?.message || 'Validation failed', normalized);
};

const templateId = param('templateId').isMongoId().withMessage('Choose a valid offer template');

export const listOfferTemplateRules = [
  query('includeInactive').optional().isBoolean().withMessage('includeInactive must be true or false'),
  validate,
];

export const createOfferTemplateRules = [
  body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Template name must be 2–120 characters'),
  body('description').optional().trim().isLength({ max: 500 }).withMessage('Description is too long'),
  body('content').isString().isLength({ min: 20, max: 8000 }).withMessage('Template content must be 20–8,000 characters'),
  body('isDefault').optional().isBoolean().withMessage('isDefault must be true or false'),
  validate,
];

export const updateOfferTemplateRules = [
  templateId,
  body('name').optional().trim().isLength({ min: 2, max: 120 }).withMessage('Template name must be 2–120 characters'),
  body('description').optional().trim().isLength({ max: 500 }).withMessage('Description is too long'),
  body('content').optional().isString().isLength({ min: 20, max: 8000 }).withMessage('Template content must be 20–8,000 characters'),
  body('isDefault').optional().isBoolean().withMessage('isDefault must be true or false'),
  body('isActive').optional().isBoolean().withMessage('isActive must be true or false'),
  validate,
];

export const deactivateOfferTemplateRules = [templateId, validate];
