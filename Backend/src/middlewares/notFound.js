import ApiError from '../utils/ApiError.js';
import { redactRequestUrl } from '../infrastructure/observability/redaction.js';

const notFound = (req, res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${redactRequestUrl(req.originalUrl)}`));
};

export default notFound;
