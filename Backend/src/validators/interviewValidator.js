import { body, param, query, validationResult } from 'express-validator';
import {
  INTERVIEW_STATUSES,
  INTERVIEW_TYPES,
} from '../models/Interview.js';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  const normalized = errors.array().map((error) => ({
    field: error.path,
    message: error.msg,
  }));
  throw ApiError.badRequest(
    normalized[0]?.message || 'Invalid interview request',
    normalized
  );
};

const interviewIdRule = param('id')
  .isMongoId()
  .withMessage('Choose a valid interview');
const dateRule = (location = body) =>
  location('date')
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Choose a valid interview date');
const timeRule = (location = body) =>
  location('time')
    .matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
    .withMessage('Choose a valid interview time');
const timezoneRule = (location = body) =>
  location('timezone')
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage('Timezone must be between 3 and 100 characters');
const durationRule = (location = body) =>
  location('durationMinutes')
    .isInt({ min: 15, max: 480 })
    .withMessage('Interview duration must be between 15 and 480 minutes')
    .toInt();
const interviewerRules = [
  body('interviewerIds')
    .isArray({ min: 1, max: 10 })
    .withMessage('Choose between 1 and 10 interviewers')
    .custom((values) => {
      const normalized = values.map(String);
      if (new Set(normalized).size !== normalized.length) {
        throw new Error('Interviewer selection cannot contain duplicates');
      }
      return true;
    }),
  body('interviewerIds.*')
    .isMongoId()
    .withMessage('Interviewer selection contains an invalid user'),
];
const textRule = (field, max, label, required = false) => {
  const rule = body(field);
  if (!required) rule.optional({ values: 'falsy' });
  return rule
    .trim()
    .isLength({ min: required ? 1 : 0, max })
    .withMessage(`${label} must be ${max} characters or fewer`);
};

export const scheduleInterviewRules = [
  body('candidateId').isMongoId().withMessage('Choose a valid candidate'),
  body('roundKey')
    .trim()
    .toUpperCase()
    .matches(/^[A-Z0-9_]{2,80}$/)
    .withMessage('Choose a valid interview round'),
  body('roundName')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage('Round name must be between 2 and 120 characters'),
  body('roundSequence')
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: 100 })
    .withMessage('Round sequence must be between 1 and 100')
    .toInt(),
  body('roundCategory')
    .optional({ values: 'falsy' })
    .toUpperCase()
    .isIn(['TECHNICAL', 'MANAGER', 'HR', 'CUSTOM'])
    .withMessage('Choose a valid round category'),
  dateRule(),
  timeRule(),
  timezoneRule(),
  durationRule(),
  body('interviewType')
    .toUpperCase()
    .isIn(INTERVIEW_TYPES)
    .withMessage('Choose a valid interview type'),
  textRule('meetingLink', 1000, 'Meeting link'),
  textRule('location', 500, 'Location'),
  textRule('candidateInstructions', 3000, 'Candidate instructions'),
  textRule('internalNotes', 5000, 'Internal notes'),
  ...interviewerRules,
  body('updateCandidateStage')
    .optional()
    .isBoolean()
    .withMessage('Pipeline update choice must be true or false')
    .toBoolean(),
  body().custom((value) => {
    const forbidden = [
      'companyId',
      'jobId',
      'requisitionId',
      'interviewCode',
      'status',
      'createdBy',
      'updatedBy',
      'statusHistory',
      'rescheduleHistory',
      'reminderDispatch',
      'notificationDispatch',
    ];
    if (forbidden.some((field) => Object.hasOwn(value, field))) {
      throw new Error('Interview ownership and lifecycle fields are server controlled');
    }
    if (value.interviewType === 'ONLINE' && !value.meetingLink) {
      throw new Error('Meeting link is required for online interviews');
    }
    if (value.interviewType === 'ONSITE' && !value.location) {
      throw new Error('Location is required for onsite interviews');
    }
    return true;
  }),
  validate,
];

export const rescheduleInterviewRules = [
  interviewIdRule,
  dateRule(),
  timeRule(),
  timezoneRule(),
  durationRule(),
  textRule('meetingLink', 1000, 'Meeting link'),
  textRule('location', 500, 'Location'),
  textRule('reason', 1000, 'Reason', true),
  ...interviewerRules,
  body().custom((value) => {
    const forbidden = [
      'companyId',
      'candidateId',
      'jobId',
      'roundKey',
      'status',
      'interviewType',
      'internalNotes',
      'candidateInstructions',
    ];
    if (forbidden.some((field) => Object.hasOwn(value, field))) {
      throw new Error('This field cannot be changed while rescheduling');
    }
    return true;
  }),
  validate,
];

export const cancelInterviewRules = [
  interviewIdRule,
  textRule('reason', 1000, 'Cancellation reason', true),
  validate,
];

export const updateInterviewStatusRules = [
  interviewIdRule,
  body('status')
    .toUpperCase()
    .isIn(['IN_PROGRESS', 'COMPLETED', 'NO_SHOW'])
    .withMessage('Choose a valid operational interview status'),
  textRule('reason', 1000, 'Status reason'),
  body().custom((value) => {
    if (value.status === 'NO_SHOW' && !String(value.reason || '').trim()) {
      throw new Error('A reason is required when marking a no-show');
    }
    return true;
  }),
  validate,
];

export const interviewDetailRules = [interviewIdRule, validate];

export const candidateInterviewRules = [
  param('candidateRef')
    .trim()
    .custom((value) =>
      /^[a-f\d]{24}$/i.test(value) || /^CAN-\d{6,}$/i.test(value)
    )
    .withMessage('Choose a valid candidate'),
  validate,
];

export const interviewListRules = [
  query('page')
    .optional()
    .isInt({ min: 1, max: 10000 })
    .withMessage('Page must be between 1 and 10000')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('Limit must be between 1 and 50')
    .toInt(),
  query('view')
    .optional()
    .isIn(['all', 'upcoming', 'past'])
    .withMessage('Choose a valid interview view'),
  query('status')
    .optional({ values: 'falsy' })
    .toUpperCase()
    .isIn(INTERVIEW_STATUSES)
    .withMessage('Choose a valid interview status'),
  query('roundKey')
    .optional({ values: 'falsy' })
    .trim()
    .toUpperCase()
    .matches(/^[A-Z0-9_]{2,80}$/)
    .withMessage('Choose a valid round'),
  query('job')
    .optional({ values: 'falsy' })
    .isMongoId()
    .withMessage('Choose a valid job'),
  query('interviewer')
    .optional({ values: 'falsy' })
    .isMongoId()
    .withMessage('Choose a valid interviewer'),
  query('search')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 120 })
    .withMessage('Search must be 120 characters or fewer'),
  query('dateFrom')
    .optional({ values: 'falsy' })
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Choose a valid start date'),
  query('dateTo')
    .optional({ values: 'falsy' })
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Choose a valid end date'),
  query().custom((value) => {
    if (value.dateFrom && value.dateTo) {
      const from = Date.parse(`${value.dateFrom}T00:00:00Z`);
      const to = Date.parse(`${value.dateTo}T00:00:00Z`);
      if (to < from) throw new Error('End date cannot be before start date');
      if (to - from > 366 * 24 * 60 * 60 * 1000) {
        throw new Error('Interview date range cannot exceed 366 days');
      }
    }
    return true;
  }),
  validate,
];
