// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.13 — TARGET SAFETY GUARD (§2/§31/§32/§79/§80)
//
// THE load-tooling safety law: load must never reach production.
//
// Policy (fail-closed, no force switch exists anywhere in 32.13):
//   • The runner REFUSES to run when NODE_ENV=production (a 32.13 tool
//     has no business inside a production process anyway).
//   • Only loopback-style hosts are unconditionally safe:
//     localhost, 127.0.0.0/8, [::1]/::1, *.localhost
//   • ANY other host is refused unless BOTH:
//       --target <url> is explicit, AND
//       --confirm-remote-is-safe-staging "<exact host>" matches it.
//     This is an operator's explicit declaration, not a bypass.
//   • Pure string matching on the TARGET STRING only — the guard never
//     performs network I/O, so testing refusal cannot contact anyone.
// ═══════════════════════════════════════════════════════════════════════════

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const isLoopbackHost = (hostname) => {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.endsWith('.localhost')) return true;
  return false;
};

export const parseTargetUrl = (target) => {
  try {
    return { url: new URL(String(target)), error: null };
  } catch {
    return { url: null, error: 'target is not a valid absolute URL (expected e.g. http://localhost:5000)' };
  }
};

export const hostOf = (url) => String(url?.hostname || '').toLowerCase();

/**
 * Validate a load target. Returns { ok, reason } — ok:true ONLY when
 * traffic generation is permitted against this target.
 */
export const validateTarget = ({ target, explicit = false, confirmedStagingHost = '', nodeEnv = process.env.NODE_ENV } = {}) => {
  if (String(nodeEnv).toLowerCase() === 'production') {
    return { ok: false, reason: 'NODE_ENV=production — 32.13 load tooling refuses to run inside production processes.' };
  }

  if (!target) {
    return { ok: false, reason: 'No target. Default is http://localhost:5000 — pass --target explicitly for anything else.' };
  }

  const { url, error } = parseTargetUrl(target);
  if (!url) return { ok: false, reason: error };

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Refused: unsupported protocol "${url.protocol}" (use http/https only).` };
  }

  const host = hostOf(url);
  if (isLoopbackHost(host)) return { ok: true, reason: `loopback target (${host})`, url };

  // Non-loopback: requires BOTH an explicit --target AND the exact-host
  // staging declaration. Ambiguity resolves to REFUSAL (§32).
  const confirmed = String(confirmedStagingHost || '').toLowerCase().replace(/\.$/, '');
  if (!explicit) {
    return { ok: false, reason: `Refused: "${host}" is not loopback and no explicit --target was given.` };
  }
  if (!confirmed) {
    return {
      ok: false,
      reason: `Refused: "${host}" is not loopback. If this is REALLY an isolated dev/staging host, re-run with: --confirm-remote-is-safe-staging ${host}`,
    };
  }
  if (confirmed !== host) {
    return {
      ok: false,
      reason: `Refused: staging confirmation was for "${confirmed}" but the target host is "${host}". They must match exactly.`,
    };
  }
  return { ok: true, reason: `remote target "${host}" explicitly declared isolated staging`, url };
};

export default validateTarget;
