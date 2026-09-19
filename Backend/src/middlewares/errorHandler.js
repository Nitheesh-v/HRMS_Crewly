import env from '../config/env.js';
import logger from '../config/logger.js';
import { serializeError } from '../infrastructure/observability/safeErrorSerializer.js';
import { routeTemplateOf } from '../infrastructure/observability/redaction.js';
import { getCurrentRequestId } from '../infrastructure/observability/requestContext.js';

// Phase 32.12 — error logging goes through the safe serializer and
// carries the request/correlation ID so an incident can be followed
// from client reference → completion/error log (§23/§58). HTTP
// responses keep their existing safe shape: stacks only in development.
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.isOperational ? err.message : 'Internal server error';

  if (err.name === 'CastError') {
    statusCode = 400;
    // 32.12: never echo the raw user-supplied value into the response
    // or logs — bound to its TYPE shape only (was: `Invalid ${err.path}:
    // ${err.value}` — a value-reflection leak).
    message = `Invalid ${String(err.path ?? 'identifier').slice(0, 64)}: wrong format`;
  }

  if (err.code === 11000) {
    statusCode = 409;
    const fields = Object.keys(err.keyValue || {}).join(', ');
    message = `Duplicate value for field(s): ${fields}`;
  }

  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(', ');
  }

  const requestId = req?.id || getCurrentRequestId() || undefined;
  const route = req ? routeTemplateOf(req) : undefined;

  if (statusCode >= 500) {
    logger.error('http.request.error', {
      requestId,
      method: req?.method,
      route,
      status: statusCode,
      error: serializeError(err),
    });
  } else {
    logger.warn('http.request.rejected', {
      requestId,
      method: req?.method,
      route,
      status: statusCode,
      error: serializeError(err),
    });
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(Array.isArray(err.errors) && err.errors.length > 0 && { errors: err.errors }),
    ...(env.NODE_ENV === 'development' && statusCode >= 500 && { stack: err.stack }),
  });
};

export default errorHandler;
