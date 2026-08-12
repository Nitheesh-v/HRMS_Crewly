import { body } from 'express-validator';
import { PRIORITIES, PROJECT_STATUS, TASK_STATUS } from '../utils/constants.js';

export const createProjectValidator = [
  body('name').trim().notEmpty().withMessage('Project name is required').isLength({ max: 80 }),
  body('description').optional().trim().isLength({ max: 500 }),
  body('priority').optional().isIn(PRIORITIES),
  body('startDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('deadline').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('manager').optional({ nullable: true, checkFalsy: true }).isMongoId(),
  body('teamLead').optional({ nullable: true, checkFalsy: true }).isMongoId(),
  body('members').optional().isArray().withMessage('members must be an array'),
  body('members.*').optional().isMongoId(),
];

export const updateProjectValidator = [
  body('name').optional().trim().notEmpty().isLength({ max: 80 }),
  body('description').optional().trim().isLength({ max: 500 }),
  body('status').optional().isIn(PROJECT_STATUS),
  body('priority').optional().isIn(PRIORITIES),
  body('startDate').optional({ nullable: true }).isISO8601(),
  body('deadline').optional({ nullable: true }).isISO8601(),
];

export const updateTeamValidator = [
  body('teamLead').optional({ nullable: true, checkFalsy: true }).isMongoId(),
  body('members').optional().isArray(),
  body('members.*').optional().isMongoId(),
];

export const createTaskValidator = [
  body('project').isMongoId().withMessage('project is required'),
  body('title').trim().notEmpty().withMessage('Task title is required').isLength({ max: 120 }),
  body('description').optional().trim().isLength({ max: 500 }),
  body('priority').optional().isIn(PRIORITIES),
  body('dueDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('assignedTo').isMongoId().withMessage('assignedTo is required'),
];

export const updateTaskValidator = [
  body('title').optional().trim().notEmpty().isLength({ max: 120 }),
  body('description').optional().trim().isLength({ max: 500 }),
  body('priority').optional().isIn(PRIORITIES),
  body('dueDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('assignedTo').optional().isMongoId(),
];

export const taskStatusValidator = [
  body('status').isIn(TASK_STATUS).withMessage(`Status must be one of: ${TASK_STATUS.join(', ')}`),
];