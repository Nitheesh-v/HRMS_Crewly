import { body, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import {
  IMAGE_FIT,
  LOGO_ALIGNMENT,
  LOGO_DISPLAY_BOUNDS,
  PAYSLIP_TEMPLATE,
} from '../services/companyBrandingRules.js';

// Runs after the rules — collects errors into our standard format
// (same tail convention as companyValidator.js).
export const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

// PUT /api/companies/my/branding — layout enums + template allowlist.
// The service re-validates everything; this layer only produces clean 400s.
export const updateBrandingValidator = [
  body('layout.width')
    .optional()
    .isInt({ min: LOGO_DISPLAY_BOUNDS.widthMin, max: LOGO_DISPLAY_BOUNDS.widthMax })
    .withMessage(
      `Logo width must be ${LOGO_DISPLAY_BOUNDS.widthMin}–${LOGO_DISPLAY_BOUNDS.widthMax}`
    )
    .toInt(),
  body('layout.maxHeight')
    .optional()
    .isInt({ min: LOGO_DISPLAY_BOUNDS.heightMin, max: LOGO_DISPLAY_BOUNDS.heightMax })
    .withMessage(
      `Logo max height must be ${LOGO_DISPLAY_BOUNDS.heightMin}–${LOGO_DISPLAY_BOUNDS.heightMax}`
    )
    .toInt(),
  body('layout.fit')
    .optional()
    .isIn(Object.values(IMAGE_FIT))
    .withMessage('Logo fit must be CONTAIN or COVER'),
  body('layout.alignment')
    .optional()
    .isIn(Object.values(LOGO_ALIGNMENT))
    .withMessage('Logo alignment must be LEFT, CENTER or RIGHT'),
  body('documentBranding.payslip.templateId')
    .optional()
    .isIn(Object.values(PAYSLIP_TEMPLATE))
    .withMessage('Unknown payslip template'),
  body('documentBranding.payslip.logo.width')
    .optional({ nullable: true })
    .isInt({ min: LOGO_DISPLAY_BOUNDS.widthMin, max: LOGO_DISPLAY_BOUNDS.widthMax })
    .withMessage(
      `Payslip logo width must be ${LOGO_DISPLAY_BOUNDS.widthMin}–${LOGO_DISPLAY_BOUNDS.widthMax}`
    )
    .toInt(),
  body('documentBranding.payslip.logo.maxHeight')
    .optional({ nullable: true })
    .isInt({ min: LOGO_DISPLAY_BOUNDS.heightMin, max: LOGO_DISPLAY_BOUNDS.heightMax })
    .withMessage(
      `Payslip logo max height must be ${LOGO_DISPLAY_BOUNDS.heightMin}–${LOGO_DISPLAY_BOUNDS.heightMax}`
    )
    .toInt(),
  body('documentBranding.payslip.logo.fit')
    .optional({ nullable: true })
    .isIn(Object.values(IMAGE_FIT))
    .withMessage('Payslip logo fit must be CONTAIN or COVER'),
  body('documentBranding.payslip.logo.alignment')
    .optional({ nullable: true })
    .isIn(Object.values(LOGO_ALIGNMENT))
    .withMessage('Payslip logo alignment must be LEFT, CENTER or RIGHT'),
  body('documentBranding.offer.useCompanyLogo')
    .optional()
    .isBoolean()
    .withMessage('Offer logo flag must be true or false')
    .toBoolean(),
  validate,
];
