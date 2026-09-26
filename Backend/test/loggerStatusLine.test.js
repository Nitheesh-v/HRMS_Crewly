// ============================================================
//  PHASE 33.9-fix — LOGGER STATUS LINE (HERMETIC).
//
//  WHY THIS SUITE EXISTS
//    The development console format only ever printed
//    `${timestamp} [level]: message` and dropped the metadata argument, so
//    the request line read "http.request.complete" with no STATUS CODE —
//    the one field an operator needs while accepting RBAC work (200 vs 403
//    vs 404). The structured JSON in the file transports always had it; the
//    human line did not.
//
//  WHAT IS PINNED
//    · status is rendered, and rendered FIRST (access-log shape)
//    · the other essentials survive (method, route, durationMs)
//    · a message with no metadata stays a clean line (no dangling space)
//    · the tail is bounded (value length, key count, total length)
//    · unserializable/circular values degrade — the formatter never throws
//    · winston internals / reserved keys never leak into the line
//    · production (JSON) records still carry status as a real field
//
//  No Redis, no Mongo, no HTTP: the real formatter runs against a captured
//  in-memory transport.
// ============================================================

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_logger';
process.env.REDIS_ENABLED ||= 'false';

import winston from 'winston';

import {
  formatMetaTail,
  prettyFormat,
  structuredFormat,
} from '../src/config/logger.js';

const capture = async (format, write) => {
  const lines = [];
  const stream = new Writable({
    write: (chunk, _encoding, callback) => {
      lines.push(chunk.toString().trim());
      callback();
    },
  });

  const logger = winston.createLogger({
    format,
    transports: [new winston.transports.Stream({ stream })],
  });

  write(logger);
  await new Promise((resolve) => setTimeout(resolve, 30));

  return lines;
};

const completionEvent = {
  requestId: 'f3a1-b2c4',
  method: 'GET',
  route: '/api/chat/conversations/:conversationId',
  status: 200,
  durationMs: 12.4,
  bytes: 812,
  userId: '68f0admin',
  companyId: '68efcompany',
};

test('a request line carries the status code, rendered first', async () => {
  const lines = await capture(prettyFormat, (logger) =>
    logger.info('http.request.complete', completionEvent)
  );

  assert.equal(lines.length, 1);

  const line = lines[0];

  assert.match(line, /http\.request\.complete/);
  assert.match(line, /status=200/);
  assert.match(line, /method=GET/);
  assert.match(line, /route=\/api\/chat\/conversations\/:conversationId/);
  assert.match(line, /durationMs=12\.4/);

  // Access-log shape: status comes before method/route/duration.
  const indexOf = (needle) => line.indexOf(needle);
  assert.ok(indexOf('status=') < indexOf('method='), 'status must lead the tail');
  assert.ok(indexOf('status=') < indexOf('route='), 'status before route');
  assert.ok(indexOf('status=') < indexOf('durationMs='), 'status before duration');
});

test('a slow-request warn line carries its status too (403 acceptance case)', async () => {
  const lines = await capture(prettyFormat, (logger) =>
    logger.warn('http.request.slow', {
      requestId: 'f3a2',
      method: 'PATCH',
      route: '/api/chat/conversations/:conversationId/disable',
      status: 403,
      durationMs: 1602.5,
      thresholdMs: 1500,
    })
  );

  assert.match(lines[0], /^.*\[warn\]: http\.request\.slow status=403/);
  assert.match(lines[0], /thresholdMs=1500/);
});

test('a message without metadata stays a clean line', async () => {
  const lines = await capture(prettyFormat, (logger) => logger.info('[Cache] miss'));

  assert.equal(lines[0].endsWith('miss'), true, 'no dangling separator or space');
  assert.equal(lines[0].includes('='), false);
});

test('reserved/internal keys are not rendered as metadata pairs', async () => {
  const lines = await capture(prettyFormat, (logger) =>
    logger.info('hello', { status: 200, level: 'fake', message: 'fake', splat: 'x' })
  );

  const line = lines[0];

  assert.match(line, /hello/);
  assert.match(line, /status=200/);
  // The invariant: winston-owned keys are never rendered as `key=value`
  // metadata pairs (how winston merges them into the body is its business).
  assert.ok(!line.includes('level='), 'level is winston-owned');
  assert.ok(!line.includes('message='), 'message is winston-owned');
  assert.ok(!line.includes('splat='), 'splat is winston-owned');
  assert.ok(!line.includes('[object Object]'));
  assert.equal(formatMetaTail({ level: 'x', message: 'y', splat: 'z' }), '');
});

test('an error stack stays the body, and the tail still follows it', async () => {
  // `errors({ stack: true })` promotes info.stack into the rendered body —
  // that is winston's error channel, not metadata, and it must keep winning
  // over the tail.
  const lines = await capture(prettyFormat, (logger) =>
    logger.error('boom', { status: 500, route: '/api/x', stack: 'Error: boom\n    at handler' })
  );

  assert.match(lines[0], /Error: boom/);
  assert.match(lines[0], /at handler/);
  assert.match(lines[0], /status=500/);
  assert.match(lines[0], /route=\/api\/x/);
});

test('the tail is bounded: long values, key count and total length', () => {
  const longValue = formatMetaTail({ status: 200, note: 'y'.repeat(500) });

  assert.ok(longValue.includes('note='));
  assert.ok(longValue.length <= 510, `value must be truncated, got ${longValue.length}`);
  assert.ok(longValue.includes('...'), 'truncation is visible');

  const manyKeys = Object.fromEntries(
    Array.from({ length: 40 }, (_value, index) => [`k${index}`, index])
  );
  const bounded = formatMetaTail(manyKeys);

  assert.ok(
    bounded.split(' ').length <= 12,
    'the key count is bounded so one event cannot flood the line',
  );
});

test('unserializable and circular metadata degrade instead of throwing', () => {
  const circular = {};
  circular.self = circular;

  const tail = formatMetaTail({
    status: 500,
    circular,
    when: new Date('2026-01-02T03:04:05.000Z'),
  });

  assert.match(tail, /status=500/);
  assert.match(tail, /circular=\[unserializable\]/);
  assert.match(tail, /when=2026-01-02T03:04:05\.000Z/);
});

test('production JSON records still carry status as a real field', async () => {
  const lines = await capture(structuredFormat, (logger) =>
    logger.info('http.request.complete', completionEvent)
  );

  const record = JSON.parse(lines[0]);

  assert.equal(record.message, 'http.request.complete');
  assert.equal(record.status, 200);
  assert.equal(record.route, '/api/chat/conversations/:conversationId');
});
