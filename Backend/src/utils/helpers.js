/**
 * Wraps async route handlers to avoid try/catch boilerplate.
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Build a standardized success response.
 */
export const sendSuccess = (res, data = {}, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    ...data,
  });
};

/**
 * Generate a unique employee ID for a tenant.
 * Format: EMP-{tenantPrefix}-{4-digit number}
 */
export const generateEmployeeId = (tenantSlug, count) => {
  const prefix = tenantSlug.slice(0, 3).toUpperCase();
  const num = String(count + 1).padStart(4, '0');
  return `EMP-${prefix}-${num}`;
};
