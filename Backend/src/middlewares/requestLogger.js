import morgan from 'morgan';
import env from '../config/env.js';
import logger from '../config/logger.js';

const stream = {
  write: (message) => logger.http(message.trim()),
};

export const redactRequestUrl = (value = '') =>
  String(value).replace(
    /(\/api\/public\/candidate\/offers\/)[A-Za-z0-9_-]+/gi,
    '$1[REDACTED]'
  );

// Override Morgan's built-in URL token so secure candidate-offer tokens never
// enter development or production request logs.
morgan.token('url', (req) => redactRequestUrl(req.originalUrl || req.url));

const requestLogger = morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream });

export default requestLogger;