import Company from '../models/Company.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';

// Company isolation: loads the user's company + subscription onto req.company.
// Every module (Phase 2+) scopes its queries to req.companyId — cross-company
// data leak is impossible.
export const tenantContext = asyncHandler(async (req, res, next) => {
  if (!req.companyId) return next(); // SUPER_ADMIN — platform-wide, no tenant

  const company = await Company.findById(req.companyId).populate('subscription');
  if (!company) throw ApiError.forbidden('Company not found');
  if (
    [
      'SUSPENDED',
      'DEACTIVATED',
      'ARCHIVED',
    ].includes(company.status)
  ) {
    throw ApiError.forbidden(
      `Your company account is ` +
      `${company.status.toLowerCase()}. ` +
      `Contact Crewly support.`
    );
  }
  req.company = company;
  next();
});

// Expired subscription → READ-ONLY mode (from your requirements diagram)
export const readOnlyIfExpired = (
  req,
  res,
  next
) => {
  const subscription =
    req.company?.subscription;

  if (
    !subscription ||
    [
      'ACTIVE',
      'TRIAL',
      'EXPIRING_SOON',
      'GRACE_PERIOD',
    ].includes(subscription.status)
  ) {
    return next();
  }

  // Billing must remain available so an expired
  // company can renew its subscription.
  if (
    req.originalUrl.startsWith(
      '/api/billing'
    )
  ) {
    return next();
  }

  const behavior =
    subscription.expirationBehavior ||
    'READ_ONLY';

  if (
    behavior ===
    'FULL_ACCESS_BLOCKED'
  ) {
    throw ApiError.forbidden(
      'Subscription expired — access is blocked until renewal.'
    );
  }

  if (
    behavior ===
      'FEATURE_RESTRICTED' &&
    !['GET', 'HEAD'].includes(
      req.method
    )
  ) {
    throw ApiError.forbidden(
      'Subscription expired — restricted features are unavailable until renewal.'
    );
  }

  if (
    behavior === 'READ_ONLY' &&
    !['GET', 'HEAD'].includes(
      req.method
    )
  ) {
    throw ApiError.forbidden(
      'Subscription expired — your account is in read-only mode. Please renew.'
    );
  }

  next();
};