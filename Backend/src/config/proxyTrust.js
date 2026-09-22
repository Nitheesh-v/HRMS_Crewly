import net from 'node:net';

// ============================================================
//  PHASE 32.3 — REVERSE PROXY TRUST CONFIGURATION.
//
//  THE trust boundary for Crewly. Express `trust proxy` decides
//  whether req.ip / req.ips / req.protocol / req.secure may be
//  derived from X-Forwarded-* headers — so it must be EXPLICIT,
//  never a blanket `true`, and never silently permissive.
//
//  Modes (TRUST_PROXY_MODE):
//
//    direct   (DEFAULT — trust = false)
//        The API is reached directly (localhost dev, or a
//        direct-exposed deployment). Client identity is the SOCKET
//        address. X-Forwarded-For / X-Forwarded-Proto from clients
//        are INERT — an attacker cannot forge IP/protocol identity.
//
//    loopback (trust = 'loopback')
//        Only loopback connections are treated as proxies. Local
//        proxy simulation (nginx on 127.0.0.1, dev tunnels).
//
//    hop      (trust = TRUST_PROXY_HOPS, clamped 1..10, default 1)
//        N reverse-proxy hops sit between the client and the API,
//        counting the proxy attached to the API's socket first
//        (Render/nginx/cPanel single proxy → hop 1; CDN + LB → 2).
//        Express counts hops FROM the socket: req.ip = the Nth entry
//        from the right of the X-Forwarded-For chain (proxies append
//        the address they received from).
//
//    cidr     (trust = TRUST_PROXY_CIDRS, comma-separated)
//        The SAFEST production declaration: trust only addresses in
//        the listed networks (the load balancer's private subnet).
//        Handles CDN + LB chains by trusting the boundary, not each
//        hop. Supports IPv4, IPv6 and CIDR notation.
//
//  Misconfiguration FAILS STARTUP with an explicit message — the
//  process never runs with silently weakened identity semantics.
//
//  Deployment assumption (32.15): when trust is declared, the API
//  must not be directly reachable from the internet bypassing the
//  trusted proxy path.
// ============================================================

export const PROXY_TRUST_MODES = ['direct', 'loopback', 'hop', 'cidr'];

const MIN_HOPS = 1;
const MAX_HOPS = 10;
const DEFAULT_HOPS = 1;

const normalizeEntry = (value) =>
  String(value || '')
    .trim()
    .replace(/\/32$/, '')
    .replace(/\/128$/, '');

const entryLooksLikeCidr = (entry) => {
  const slash = entry.lastIndexOf('/');

  if (slash === -1) return false;

  const base = entry.slice(0, slash);
  const prefix = Number(entry.slice(slash + 1));

  if (!Number.isInteger(prefix) || prefix < 0) return false;

  const baseIsV4 = net.isIPv4(base);
  const baseIsV6 = net.isIPv6(base);

  if (baseIsV4) return prefix <= 32;
  if (baseIsV6) return prefix <= 128;

  return false;
};

const validateTrustEntries = (raw) => {
  const entries = String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!entries.length) {
    throw new Error(
      'TRUST_PROXY_CIDRS is required when TRUST_PROXY_MODE=cidr ' +
        '(comma-separated IPs or CIDR blocks, IPv4 or IPv6).'
    );
  }

  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    const bare = normalized.split('/')[0];

    const valid =
      net.isIPv4(bare) ||
      net.isIPv6(bare) ||
      // Express/proxy-addr accepts named networks too; we deliberately
      // allow only the loopback families plus literal IP/CIDR entries
      // so configuration stays explicit and reviewable.
      ['loopback', 'linklocal', 'uniquelocal'].includes(
        normalized.toLowerCase(),
      ) ||
      entryLooksLikeCidr(normalized);

    if (!valid) {
      throw new Error(
        `TRUST_PROXY_CIDRS contains an invalid entry: "${entry}". ` +
          'Use IPs, CIDR blocks (IPv4/IPv6) or the named networks ' +
          'loopback | linklocal | uniquelocal.'
      );
    }
  }

  return entries.join(', ');
};

export const parseProxyTrustConfig = (source = process.env) => {
  const mode = String(source?.TRUST_PROXY_MODE || 'direct')
    .trim()
    .toLowerCase();

  if (!PROXY_TRUST_MODES.includes(mode)) {
    throw new Error(
      `TRUST_PROXY_MODE="${source?.TRUST_PROXY_MODE}" is invalid. ` +
        `Use one of: ${PROXY_TRUST_MODES.join(' | ')}.`
    );
  }

  if (mode === 'direct') {
    return { mode, trust: false, describe: 'direct (no proxy trust)' };
  }

  if (mode === 'loopback') {
    return { mode, trust: 'loopback', describe: 'loopback proxies only' };
  }

  if (mode === 'hop') {
    const parsed = Math.trunc(Number(source?.TRUST_PROXY_HOPS));

    if (
      source?.TRUST_PROXY_HOPS !== undefined &&
      source?.TRUST_PROXY_HOPS !== '' &&
      !Number.isFinite(parsed)
    ) {
      throw new Error(
        `TRUST_PROXY_HOPS="${source?.TRUST_PROXY_HOPS}" is not a number.`
      );
    }

    const hops = Math.min(
      MAX_HOPS,
      Math.max(MIN_HOPS, Number.isFinite(parsed) ? parsed : DEFAULT_HOPS),
    );

    return {
      mode,
      trust: hops,
      hops,
      describe: `${hops} trusted proxy hop(s)`,
    };
  }

  // mode === 'cidr'
  const cidrs = validateTrustEntries(source?.TRUST_PROXY_CIDRS);

  return { mode, trust: cidrs, cidrs, describe: `trusted CIDRs: ${cidrs}` };
};

// The ONE place Express trust is configured.
export const applyProxyTrust = (app, source = process.env) => {
  const config = parseProxyTrustConfig(source);

  app.set('trust proxy', config.trust);

  return config;
};
