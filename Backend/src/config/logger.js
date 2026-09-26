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

// ─────────────────────────────────────────────────────────────────────────
// DEVELOPMENT access rows (33.10-fix).
//
// The metadata tail made every request line a key=value paragraph and printed
// the error serializer's JSON (stack included) straight into the terminal:
//
//   [warn]: http.request.rejected status=400 ... error={"name":"Error",...
//
// The console now renders request events the way this product has always been
// read, one bounded row per request, with the failure reason on its own line:
//
//   2026-09-26 10:43:34 [warn]: 400 - A file is required.
//   2026-09-26 10:43:34 [http]: POST /api/chat/conversations/:id/attachments 400 212.500 ms - 49
//
// It is a RENDERING change only: the event name and every safe field still
// travel to the JSON file transports (logs/combined.log, logs/error.log),
// which keep requestId/userId/companyId and the bounded stack.
//
// The path shown is the normalized ROUTE TEMPLATE, not the raw URL: 32.12's
// redaction law strips query strings and tokenized path segments, so raw URLs
// never reach a log line (§12/§15) — and the template is what metrics label on.
// ─────────────────────────────────────────────────────────────────────────
const HTTP_ACCESS_EVENTS = new Set([
  'http.request.complete',
  'http.request.slow',
  'http.request.rejected',
  'http.request.error',
]);

const ACCESS_ROW_MAX_CHARS = 300;

// One line, always: control characters and newlines collapse to spaces so a
// multi-line error message cannot break the log stream.
const toSingleLine = (value) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const boundedRow = (text) =>
  text.length > ACCESS_ROW_MAX_CHARS ? `${text.slice(0, ACCESS_ROW_MAX_CHARS)}...` : text;

/**
 * Render an HTTP request event as a compact console row, or null when the
 * event is not an access-log event (every non-HTTP line keeps the existing
 * `message + metadata tail` shape). Never throws.
 */
export const formatAccessRow = (info = {}) => {
  const message = String(info?.message ?? '');
  if (!HTTP_ACCESS_EVENTS.has(message)) return null;

  const status = info.status ?? info.error?.statusCode;

  if (message === 'http.request.rejected' || message === 'http.request.error') {
    const error = info.error || {};
    const name = toSingleLine(error.name);
    const detail = toSingleLine(error.message) || 'request failed';

    return {
      level: message === 'http.request.error' ? 'error' : 'warn',
      text: boundedRow(
        `${status ?? '-'} - ${name && name !== 'Error' ? `${name}: ` : ''}${detail}`,
      ),
    };
  }

  const duration = Number(info.durationMs);
  const bytes = info.bytes === undefined || info.bytes === null ? '-' : info.bytes;
  const slow = message === 'http.request.slow' ? ' (slow)' : '';

  return {
    level: message === 'http.request.slow' ? 'warn' : 'http',
    text: boundedRow(
      `${info.method || '-'} ${info.route || 'unmatched'} ${status ?? '-'} ${
        Number.isFinite(duration) ? duration.toFixed(3) : '-'
      } ms - ${bytes}${slow}`,
    ),
  };
};

const lineFormat = printf((info) => {
  const { level, message, timestamp, stack } = info;

  let accessRow = null;
  try {
    accessRow = formatAccessRow(info);
  } catch {
    accessRow = null; // a formatter must never break the log path
  }

  if (accessRow) return `${timestamp} [${accessRow.level}]: ${accessRow.text}`;

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
