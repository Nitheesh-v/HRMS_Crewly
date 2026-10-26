// ============================================================
// MONGO CONNECTION DIAGNOSTICS
//
// A failed `mongoose.connect` prints one sentence, and that sentence is
// rarely the thing the developer needs. The commonest failure on a Windows
// laptop is not the database at all: `mongodb+srv://` asks the DNS resolver
// for an SRV record, and a local resolver, VPN or antivirus that refuses SRV
// queries turns that into `querySrv ECONNREFUSED` — the cluster can be
// perfectly healthy at the same moment.
//
// This module owns the translation from a driver error to a short, specific
// next step. It is pure (no mongoose, no network) so tests can pin every
// branch, and db.js is the only caller.
// ============================================================

/** `mongodb+srv://…` needs DNS SRV+TXT; `mongodb://…` does not. */
export const isSrvUri = (uri = '') => /^mongodb\+srv:\/\//i.test(String(uri).trim());

/** The host part of a connection string, with any credentials stripped. */
export const uriHost = (uri = '') => {
  const match = String(uri).trim().match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i);

  return match ? match[1] : '';
};

/**
 * `MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1` → `['8.8.8.8', '1.1.1.1']`.
 * Anything that is not an IPv4/IPv6 literal is dropped: `dns.setServers`
 * throws on a hostname, and a typo in .env must not crash the boot.
 */
export const parseDnsServers = (value = '') => String(value)
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => /^(\d{1,3}\.){3}\d{1,3}$/.test(entry) || /^[0-9a-f:]+$/i.test(entry) && entry.includes(':'));

const DNS_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT', 'EREFUSED', 'ESERVFAIL']);

const steps = (lines) => lines.filter(Boolean);

/**
 * Classify a connection failure.
 *
 * Returns `{ kind, summary, steps }`, where `steps` are the actions to try in
 * order. `error` may be anything mongoose/Node threw; `uri` is the (secret)
 * connection string, used only for its scheme and host.
 */
export const diagnoseMongoFailure = (error = {}, uri = '') => {
  const message = String(error?.message || error || '');
  const code = error?.code || '';
  const srv = isSrvUri(uri);
  const host = uriHost(uri) || 'your cluster host';

  // 1) The SRV/TXT lookup itself failed. `querySrv` is the driver's wrapper
  //    around dns.resolveSrv; ECONNREFUSED means the *resolver* refused the
  //    query, not that the record is missing.
  if (srv && (/querySrv|queryTxt/i.test(message) || DNS_CODES.has(code))) {
    // ENOTFOUND and ECONNREFUSED look alike in a log and mean opposite things:
    // nothing exists at that name (paused/deleted cluster, typo) versus the
    // resolver refusing to answer at all (VPN, antivirus, ISP).
    const missing = code === 'ENOTFOUND' || /ENOTFOUND/i.test(message);
    return {
      kind: missing ? 'dns-missing' : 'dns-srv',
      summary: missing
        ? `no DNS record exists for ${host} — the cluster is paused, deleted, or the hostname has a typo`
        : `the DNS query for ${host} was refused — this is your resolver, not the database`,
      steps: missing
        ? steps([
          'Open Atlas → your project: is the cluster paused, deleted or renamed? A paused free-tier cluster stops answering.',
          `Ask a public resolver, to rule your machine out: nslookup -type=SRV _mongodb._tcp.${host} 8.8.8.8`,
          'If the cluster is gone, copy a fresh connection string from Atlas → Connect → Drivers.',
          'If the cluster is fine, check the hostname in MONGO_URI for a typo (the last part must be .mongodb.net).',
        ])
        : steps([
          `Check whether the record exists at all: nslookup -type=SRV _mongodb._tcp.${host}`,
          `Ask a public resolver directly: nslookup -type=SRV _mongodb._tcp.${host} 8.8.8.8`,
          'Flush the Windows cache (ipconfig /flushdns) and turn off VPN / WARP / antivirus "secure DNS" for a minute.',
          'Keep the +srv URI and let Node do the lookup with a resolver that answers: set MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1 in Backend/.env.',
          'Or remove DNS from the path entirely: Atlas → Connect → Drivers → "standard connection string" gives mongodb://h1,h2,h3/… that needs only A records.',
          'Run `npm run db:check` in Backend for a step-by-step diagnosis.',
        ]),
    };
  }

  // 2) A plain DNS failure on a standard URI. ECONNREFUSED is deliberately not
  //    in this list: on `mongodb://1.2.3.4:27017` it means nothing is listening
  //    (a stopped mongod), which is a different fix from a bad hostname.
  if (!srv && ['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL'].includes(code)) {
    return {
      kind: 'dns',
      summary: `the host ${host} could not be resolved`,
      steps: steps([
        `Check the hostname in MONGO_URI and that the machine is online: ping ${host.split(',')[0].split(':')[0]}`,
        'If the cluster was paused or deleted, copy a fresh string from Atlas.',
      ]),
    };
  }

  // 3) Authentication: the server answered and said no.
  if (/authentication failed|bad auth|invalid credentials|SCRAM/i.test(message)) {
    return {
      kind: 'auth',
      summary: 'the cluster answered, but the credentials were rejected',
      steps: steps([
        'Re-copy the connection string from Atlas — a rotated database user password is the usual cause.',
        'Percent-encode special characters in the password (@ : / ? # [ ] % → %40 %3A %2F %3F %23 %5B %5D %25).',
        'The URI must carry authSource=admin (the TXT record of an Atlas SRV adds it automatically; a hand-written mongodb:// URI does not).',
      ]),
    };
  }

  // 4) The cluster is up but this machine is not allowed in.
  if (/IP|whitelist|allowlist|not allowed|Could not connect to any servers/i.test(message)) {
    return {
      kind: 'allowlist',
      summary: 'the cluster is reachable, but this machine is not on its access list',
      steps: steps([
        'Atlas → Network Access → add your current public IP (or 0.0.0.0/0 for local development only).',
        'If you are on a new Wi-Fi network, the IP changed — add the new one.',
      ]),
    };
  }

  // 5) Local mongod that is not running.
  if (DNS_CODES.has(code) || /ECONNREFUSED/i.test(message)) {
    return {
      kind: 'not-running',
      summary: 'nothing accepted the connection on that host and port',
      steps: steps([
        'If MONGO_URI points at localhost, start MongoDB (net start MongoDB, or `docker run -d -p 27017:27017 mongo`).',
        'If it points at Atlas, check whether the cluster is paused (free tier pauses itself after inactivity).',
      ]),
    };
  }

  return {
    kind: 'unknown',
    summary: message || 'the driver did not say why',
    steps: ['Run `npm run db:check` in Backend to test DNS, TCP and credentials separately.'],
  };
};

export default diagnoseMongoFailure;
