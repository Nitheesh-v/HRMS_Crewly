import { body } from 'express-validator';
import { LEAVE_TYPES } from '../utils/constants.js';

export const applyLeaveValidator = [
  body('type').isIn(Object.keys(LEAVE_TYPES)).withMessage(`Type must be one of: ${Object.keys(LEAVE_TYPES).join(', ')}`),
  body('startDate').isISO8601().withMessage('startDate must be YYYY-MM-DD'),
  body('endDate').isISO8601().withMessage('endDate must be YYYY-MM-DD'),
  body('reason').trim().isLength({ min: 3, max: 300 }).withMessage('Reason must be 3–300 characters'),
];

export const decideLeaveValidator = [
  body('action').isIn(['APPROVE', 'REJECT']).withMessage('Action must be APPROVE or REJECT'),
  body('note').optional().trim().isLength({ max: 300 }).withMessage('Note max 300 characters'),
];