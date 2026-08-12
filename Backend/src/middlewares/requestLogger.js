import morgan from 'morgan';
import env from '../config/env.js';
import logger from '../config/logger.js';

const stream = {
  write: (message) => logger.http(message.trim()),
};

const requestLogger = morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream });

export default requestLogger;