import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import env from './config/env.js';
import requestLogger from './middlewares/requestLogger.js';
import notFound from './middlewares/notFound.js';
import errorHandler from './middlewares/errorHandler.js';
import routes from './routes/index.js';
import ApiError from './utils/ApiError.js';

const app = express();

const configuredOrigins = String(env.CLIENT_URL || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

const originAllowed = (origin) => {
  // Requests from Postman, mobile clients and internal services.
  if (!origin) return true;

  const normalizedOrigin = origin.replace(/\/$/, '');

  if (configuredOrigins.includes(normalizedOrigin)) {
    return true;
  }

  // Arena live-preview support in development only.
  if (
    env.NODE_ENV !== 'production' &&
    /^https:\/\/\d+-[a-z0-9-]+\.e2b\.app$/i.test(
      normalizedOrigin,
    )
  ) {
    return true;
  }

  return false;
};

const checkCorsOrigin = (origin, callback) => {
  if (originAllowed(origin)) {
    return callback(null, true);
  }

  const error = new Error('Origin is not allowed by CORS');
  error.statusCode = 403;
  error.isOperational = true;

  return callback(error);
};

const parseCookies = (cookieHeader = '') => {
  const cookies = {};

  for (const item of String(cookieHeader).split(';')) {
    const separator = item.indexOf('=');

    if (separator === -1) continue;

    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();

    if (!name) continue;

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
};

const unsafeKey = (key) =>
  key === '__proto__' ||
  key === 'prototype' ||
  key === 'constructor' ||
  key.startsWith('$') ||
  key.includes('.');

const inspectRequestValue = (value, depth = 0) => {
  if (depth > 12) {
    throw ApiError.badRequest(
      'Request payload is too deeply nested',
    );
  }

  if (Array.isArray(value)) {
    value.forEach((item) =>
      inspectRequestValue(item, depth + 1),
    );

    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (unsafeKey(key)) {
      throw ApiError.badRequest(
        'Request contains an unsafe field name',
      );
    }

    inspectRequestValue(child, depth + 1);
  }
};

const requestSecurity = (req, res, next) => {
  try {
    req.cookies = parseCookies(req.headers.cookie);

    inspectRequestValue(req.body);
    inspectRequestValue(req.params);
    inspectRequestValue(req.query);

    next();
  } catch (error) {
    next(error);
  }
};

// Required for correct IP addresses behind Render, Nginx or cPanel.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());

app.use(
  cors({
    origin: checkCorsOrigin,
    credentials: true,
    methods: [
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
    ],
    maxAge: 86400,
  }),
);

app.use(
  express.json({
    limit: '10kb',
    strict: true,
  }),
);

app.use(
  express.urlencoded({
    extended: false,
    limit: '10kb',
  }),
);

app.use(requestSecurity);
app.use(requestLogger);

// Every backend route is mounted under /api.
app.use('/api', routes);

// These must remain last.
app.use(notFound);
app.use(errorHandler);

export default app;