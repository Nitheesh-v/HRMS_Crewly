import winston from 'winston';

// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.12 — LOGGER (winston REUSED — no new logging dependency, §57)
//
// One change in 32.12: machine-readable STRUCTURED output where machines
// read logs (file transports always; console in production), while
// development keeps the human-friendly line format. Metadata passed as
// the second argument (e.g. logger.info('http.request.complete', meta))
// now survives into the JSON records — this is the structured-logging
// foundation (§10/§56). Secret hygiene is enforced by CALLERS going
// through infrastructure/observability redaction, never by winston.
// ─────────────────────────────────────────────────────────────────────────────

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const isProduction = process.env.NODE_ENV === 'production';

const lineFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`;
});

// Metadata-aware JSON format: message + metadata + error stacks in one
// machine-parseable record. The sanitizer pass bounds and flattens.
const structuredFormat = combine(
  errors({ stack: true }),
  timestamp(),
  json(),
);

const prettyFormat = combine(
  errors({ stack: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  lineFormat,
);

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: prettyFormat,
  transports: [
    new winston.transports.Console({
      format: isProduction ? structuredFormat : combine(colorize(), prettyFormat),
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error', format: structuredFormat }),
    new winston.transports.File({ filename: 'logs/combined.log', format: structuredFormat }),
  ],
});

export default logger;
