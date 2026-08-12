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
  if (company.status === 'SUSPENDED') {
    throw ApiError.forbidden('Your company account is suspended. Contact Crewly support.');
  }
  req.company = company;
  next();
});

// Expired subscription → READ-ONLY mode (from your requirements diagram)
export const readOnlyIfExpired = (req, res, next) => {
  const sub = req.company?.subscription;
  const expired = sub && (sub.status === 'EXPIRED' || new Date(sub.endDate).getTime() < Date.now());
  if (expired && req.method !== 'GET') {
    throw ApiError.forbidden('Subscription expired — your account is in read-only mode. Please renew.');
  }
  next();
};