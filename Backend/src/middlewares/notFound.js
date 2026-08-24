import ApiError from '../utils/ApiError.js';
import { redactRequestUrl } from './requestLogger.js';

const notFound = (req, res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${redactRequestUrl(req.originalUrl)}`));
};

export default notFound;
