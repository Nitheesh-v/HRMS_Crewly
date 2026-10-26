#!/usr/bin/env node
// ============================================================
// db:check — why can't the API reach MongoDB?
//
// Tests the three things that fail independently, in the order they fail:
//   1. DNS      — can this process resolve the host (SRV + TXT, or A)?
//   2. TCP      — does something accept a socket on 27017?
//   3. (no auth attempt — that needs the driver, and the driver is what
//      the API already prints a diagnosis for)
//
// `npm run db:check`  ·  prints no credentials, only the scheme + host.
// ============================================================
import './../src/config/loadEnv.js';
import dns from 'node:dns';
import net from 'node:net';
import { diagnoseMongoFailure, isSrvUri, parseDnsServers, uriHost } from '../src/config/mongoDiagnostics.js';

const uri = process.env.MONGO_URI || '';
const servers = parseDnsServers(process.env.MONGO_DNS_SERVERS);
const colour = (ok, text) => (process.stdout.isTTY ? `${ok ? '\u001b[32m' : '\u001b[31m'}${text}\u001b[0m` : text);
const line = (ok, label, detail = '') => console.log(`${ok ? colour(true, '✓') : colour(false, '✗')} ${label}${detail ? ` — ${detail}` : ''}`);

console.log('\nMongoDB connection check\n');

if (!uri) {
  line(false, 'MONGO_URI is empty', 'set it in Backend/.env');
  process.exit(1);
}

const srv = isSrvUri(uri);
const host = uriHost(uri);
line(true, 'MONGO_URI found', `${srv ? 'mongodb+srv' : 'mongodb'} → ${host}`);

if (servers.length) {
  dns.setServers(servers);
  console.log(`  (resolving with MONGO_DNS_SERVERS=${servers.join(', ')})`);
} else {
  console.log(`  (resolving with the system resolver: ${dns.getServers().join(', ') || 'none'})`);
}

// ── 1. DNS ──────────────────────────────────────────────────────────────────
let hosts = [];
try {
  if (srv) {
    const records = await dns.promises.resolveSrv(`_mongodb._tcp.${host}`);
    hosts = records.map((r) => `${r.name}:${r.port}`);
    line(true, 'SRV record resolved', `${records.length} host${records.length === 1 ? '' : 's'}`);
    records.forEach((r) => console.log(`    ${r.name}:${r.port}`));

    try {
      const txt = await dns.promises.resolveTxt(host);
      const options = txt.map((chunks) => chunks.join('')).join('&');
      line(true, 'TXT record (driver options)', options);
    } catch (error) {
      line(false, 'TXT record missing', error.code || error.message);
    }
  } else {
    for (const entry of host.split(',')) {
      const [name, port = '27017'] = entry.split(':');
      const addresses = await dns.promises.resolve4(name).catch(() => []);
      if (addresses.length) {
        hosts.push(`${name}:${port}`);
        line(true, `resolved ${name}`, addresses.join(', '));
      } else {
        line(false, `could not resolve ${name}`, 'check the hostname');
      }
    }
  }
} catch (error) {
  line(false, srv ? 'SRV lookup failed' : 'DNS lookup failed', `${error.code || ''} ${error.message}`.trim());
  const verdict = diagnoseMongoFailure(error, uri);
  console.log(`\n${verdict.summary}\n`);
  verdict.steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  process.exit(1);
}

// ── 2. TCP ──────────────────────────────────────────────────────────────────
const probe = (target) => new Promise((resolve) => {
  const [name, port] = target.split(':');
  const socket = net.createConnection({ host: name, port: Number(port) || 27017 });
  const done = (ok, detail) => {
    socket.destroy();
    resolve({ target, ok, detail });
  };
  socket.setTimeout(5000);
  socket.once('connect', () => done(true, 'open'));
  socket.once('timeout', () => done(false, 'timed out after 5s'));
  socket.once('error', (error) => done(false, error.code || error.message));
});

console.log('');
const results = await Promise.all(hosts.map(probe));
results.forEach(({ target, ok, detail }) => line(ok, `TCP ${target}`, detail));

const reachable = results.filter((r) => r.ok).length;
if (!reachable) {
  console.log('\nNo host accepted a connection. That is a network path problem (VPN, firewall,');
  console.log('Atlas IP access list), not a DNS one. See docs/MONGO_CONNECTION.md.\n');
  process.exit(1);
}

console.log(`\n${reachable}/${results.length} host(s) reachable. If the API still fails, the cause is`);
console.log('credentials or the Atlas IP access list — the startup log now names which.\n');
