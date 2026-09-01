// ─────────────────────────────────────────────────────────────────────────────
//  Company logo resolver (Phase 29.9, §6 / §8)
//
//  A payslip header shows the company logo. The snapshot stores the URL, not
//  the bytes, so the bytes are resolved at render time — but never at the
//  cost of a payslip:
//
//    · fail-open        — no logo, slow host or bad content just draws the
//                         initials badge instead
//    · bounded          — 3 second timeout, 2 MB cap, images only
//    · cached           — one fetch per URL per 10 minutes, because a bulk
//                         run renders thousands of payslips from the SAME
//                         logo and must not hit the network each time
//    · offline-safe     — no network call at all when there is no logo
//
//  Nothing here is awaited by a request the employee is waiting on unless a
//  PDF is actually being produced.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 200;

const cache = new Map();

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

const prune = () => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS) cache.delete(key);
  }
  // Hard cap: never let the cache grow without bound on a busy tenant.
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

export const clearCompanyLogoCache = () => cache.clear();

/**
 * @param {string} url  company logo URL (http/https) or a data: image URL
 * @returns {Promise<{ buffer: Buffer, contentType: string } | null>}
 */
export const resolveCompanyLogo = async (url) => {
  const raw = String(url || '').trim();
  if (!raw) return null;

  // A data URL is already inline — no network, no risk.
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(raw)) {
    try {
      const base64 = raw.slice(raw.indexOf(',') + 1);
      const buffer = Buffer.from(base64, 'base64');
      if (!buffer.length || buffer.length > MAX_BYTES) return null;
      const contentType = `image/${raw.slice(11, raw.indexOf(';')).toLowerCase()}`;
      return { buffer, contentType };
    } catch {
      return null;
    }
  }

  if (!isHttpUrl(raw)) return null;

  const cached = cache.get(raw);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ? { buffer: cached.value.buffer, contentType: cached.value.contentType } : null;
  }

  try {
    const response = await fetch(raw, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
      headers: { accept: 'image/*' },
    });
    if (!response.ok) {
      cache.set(raw, { at: Date.now(), value: null });
      prune();
      return null;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      cache.set(raw, { at: Date.now(), value: null });
      prune();
      return null;
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      cache.set(raw, { at: Date.now(), value: null });
      prune();
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_BYTES) {
      cache.set(raw, { at: Date.now(), value: null });
      prune();
      return null;
    }

    const value = { buffer, contentType };
    cache.set(raw, { at: Date.now(), value });
    prune();
    return { buffer: value.buffer, contentType: value.contentType };
  } catch {
    // Network failure, timeout, DNS, TLS — a payslip never waits on a logo.
    cache.set(raw, { at: Date.now(), value: null });
    prune();
    return null;
  }
};

export default resolveCompanyLogo;
