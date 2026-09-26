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

// ─────────────────────────────────────────────────────────────────────────
// Metadata tail for the DEVELOPMENT console line.
//
// Before this, the pretty format printed only `${timestamp} [level]: message`
// and silently dropped the metadata argument — so a request line read
// "http.request.complete" with no way to see the STATUS CODE (or route,
// duration, user) that the observability middleware had already attached.
// Every structured event is now rendered as a bounded key=value tail, with
// the access-log essentials first:
//
//   [info]: http.request.complete status=200 method=GET route=/api/... durationMs=12.4
//
// Safety: the tail is bounded (max keys, max value length, max total
// length) and never throws — an unserializable or circular value degrades
// to a placeholder. Redaction stays the CALLER's job (the observability
// layer passes safe fields only); this formatter is a last-resort size
// bound, not a security boundary. Production console + the file transports
// keep their JSON records (meta already travels there).
// ─────────────────────────────────────────────────────────────────────────

const RESERVED_INFO_KEYS = new Set(['level', 'message', 'timestamp', 'stack', 'splat', 'ms']);

// Access-log shape first, then everything else alphabetically.
const META_KEY_PRIORITY = [
  'status',
  'method',
  'route',
  'durationMs',
  'thresholdMs',
  'bytes',
  'requestId',
  'userId',
  'companyId',
];

const META_TAIL_MAX_KEYS = 12;
const META_VALUE_MAX_CHARS = 160;
const META_TAIL_MAX_CHARS = 500;

const renderMetaValue = (value) => {
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'string') {
    return value.length > META_VALUE_MAX_CHARS
      ? `${value.slice(0, META_VALUE_MAX_CHARS)}...`
      : value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  if (value === null) return 'null';

  try {
    const json = JSON.stringify(value);
    if (json === undefined) return '';
    return json.length > META_VALUE_MAX_CHARS
      ? `${json.slice(0, META_VALUE_MAX_CHARS)}...`
      : json;
  } catch {
    return '[unserializable]';
  }
};

// Pure + exported so the line shape is unit-testable without a transport.
export const formatMetaTail = (info = {}) => {
  const keys = Object.keys(info).filter(
    (key) => !RESERVED_INFO_KEYS.has(key) && info[key] !== undefined,
  );

  if (keys.length === 0) return '';

  const rank = (key) => {
    const index = META_KEY_PRIORITY.indexOf(key);
    return index === -1 ? META_KEY_PRIORITY.length : index;
  };

  const ordered = keys
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, META_TAIL_MAX_KEYS);

  const parts = [];

  for (const key of ordered) {
    const rendered = renderMetaValue(info[key]);
    if (rendered === '') continue;
    parts.push(`${key}=${rendered}`);
  }

  if (parts.length === 0) return '';

  const tail = parts.join(' ');

  return tail.length > META_TAIL_MAX_CHARS
    ? `${tail.slice(0, META_TAIL_MAX_CHARS)}...`
    : tail;
};

const lineFormat = printf((info) => {
  const { level, message, timestamp, stack } = info;
  const tail = formatMetaTail(info);

  return `${timestamp} [${level}]: ${stack || message}${tail ? ` ${tail}` : ''}`;
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

// Named exports exist so tests can render a line without a transport —
// the default export stays the single app-wide logger.
export { lineFormat, prettyFormat, structuredFormat };

export default logger;
