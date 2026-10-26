// ═══════════════════════════════════════════════════════════════════════════
// MONGO CONNECTION DIAGNOSTICS
//
// `querySrv ECONNREFUSED` is the most misleading error this API can print: it
// looks like a dead database and is almost always a local DNS problem. These
// tests pin the translation from a driver error to a next step, and the two
// escape hatches (a resolver override, and a non-SRV URI) that do not require
// touching the machine's network settings.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  diagnoseMongoFailure, isSrvUri, parseDnsServers, uriHost,
} from '../src/config/mongoDiagnostics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

const SRV_URI = 'mongodb+srv://app:s3cret@hrms.vxhoifi.mongodb.net/hrms?retryWrites=true&w=majority';
const PLAIN_URI = 'mongodb://app:s3cret@127.0.0.1:27017/hrms';

describe('connection-string reading', () => {
  test('the two schemes are told apart', () => {
    assert.equal(isSrvUri(SRV_URI), true);
    assert.equal(isSrvUri(PLAIN_URI), false);
    assert.equal(isSrvUri(''), false);
  });

  test('the host is extracted without ever keeping the password', () => {
    assert.equal(uriHost(SRV_URI), 'hrms.vxhoifi.mongodb.net');
    assert.equal(uriHost(PLAIN_URI), '127.0.0.1:27017');
    assert.equal(uriHost('nonsense'), '');
    assert.equal(SRV_URI.includes('s3cret'), true);
    assert.equal(uriHost(SRV_URI).includes('s3cret'), false);
  });

  test('only literal IPs are accepted as resolvers', () => {
    assert.deepEqual(parseDnsServers('8.8.8.8, 1.1.1.1'), ['8.8.8.8', '1.1.1.1']);
    assert.deepEqual(parseDnsServers(''), []);
    // dns.setServers throws on a hostname — a typo must not crash the boot.
    assert.deepEqual(parseDnsServers('dns.google'), []);
    assert.deepEqual(parseDnsServers('8.8.8.8,not-an-ip'), ['8.8.8.8']);
  });
});

describe('failure diagnosis', () => {
  test('a refused SRV query is blamed on the resolver, not the database', () => {
    const error = Object.assign(new Error('querySrv ECONNREFUSED _mongodb._tcp.hrms.vxhoifi.mongodb.net'), {
      code: 'ECONNREFUSED',
    });
    const verdict = diagnoseMongoFailure(error, SRV_URI);

    assert.equal(verdict.kind, 'dns-srv');
    assert.match(verdict.summary, /resolver/);
    assert.match(verdict.summary, /hrms\.vxhoifi\.mongodb\.net/);
    // The two fixes that need no admin rights are both offered.
    assert.ok(verdict.steps.some((s) => s.includes('MONGO_DNS_SERVERS')));
    assert.ok(verdict.steps.some((s) => s.includes('standard connection string')));
  });

  test('a missing SRV record is a different sentence (paused cluster or typo)', () => {
    const error = Object.assign(new Error('querySrv ENOTFOUND _mongodb._tcp.gone.mongodb.net'), { code: 'ENOTFOUND' });
    const verdict = diagnoseMongoFailure(error, SRV_URI);

    assert.equal(verdict.kind, 'dns-missing');
    assert.match(verdict.summary, /paused, deleted, or the hostname has a typo/);
  });

  test('a plain hostname failure is not blamed on SRV', () => {
    const error = Object.assign(new Error('getaddrinfo ENOTFOUND db.local'), { code: 'ENOTFOUND' });
    assert.equal(diagnoseMongoFailure(error, PLAIN_URI).kind, 'dns');
  });

  test('bad credentials and a closed IP list are named separately', () => {
    assert.equal(
      diagnoseMongoFailure(new Error('MongoServerError: bad auth : Authentication failed.'), SRV_URI).kind,
      'auth',
    );
    assert.equal(
      diagnoseMongoFailure(new Error('Could not connect to any servers — IP not whitelisted'), SRV_URI).kind,
      'allowlist',
    );
  });

  test('a stopped local mongod is a start-the-service step', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27017'), { code: 'ECONNREFUSED' });
    const verdict = diagnoseMongoFailure(error, PLAIN_URI);

    assert.equal(verdict.kind, 'not-running');
    assert.ok(verdict.steps.some((s) => /start MongoDB|docker run/i.test(s)));
  });

  test('it never echoes the connection string', () => {
    for (const error of [new Error('querySrv ECONNREFUSED'), new Error('bad auth')]) {
      const verdict = diagnoseMongoFailure(error, SRV_URI);
      assert.equal(JSON.stringify(verdict).includes('s3cret'), false, 'the password must not reach a log');
    }
  });

  test('an unknown error still says what to run', () => {
    const verdict = diagnoseMongoFailure(new Error('something odd'), SRV_URI);
    assert.equal(verdict.kind, 'unknown');
    assert.match(verdict.steps.join(' '), /db:check/);
  });
});

describe('the startup path uses it', () => {
  const db = read('src/config/db.js');

  test('a resolver override is applied before the first connect', () => {
    assert.match(db, /parseDnsServers\(process\.env\.MONGO_DNS_SERVERS\)/);
    assert.ok(db.indexOf('dns.setServers') < db.indexOf('mongoose.connect'), 'the resolver is set first');
  });

  test('a failed connect prints the diagnosis before exiting', () => {
    assert.match(db, /diagnoseMongoFailure\(error, env\.MONGO_URI\)/);
    assert.ok(db.indexOf('verdict.steps.forEach') < db.indexOf('process.exit(1)'));
    assert.equal(db.includes('env.MONGO_URI}'), false, 'the URI is never interpolated into the log');
  });
});

describe('the db:check script', () => {
  const script = read('scripts/db-check.js');
  const pkg = JSON.parse(read('package.json'));

  test('it is wired as an npm script', () => {
    assert.equal(pkg.scripts['db:check'], 'node scripts/db-check.js');
  });

  test('it tests DNS and TCP, and prints no credentials', () => {
    assert.match(script, /resolveSrv/);
    assert.match(script, /net\.createConnection/);
    assert.equal(script.includes('process.env.MONGO_URI}'), false);
    assert.equal(script.includes('console.log(uri)'), false);
  });
});
