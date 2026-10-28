// ═══════════════════════════════════════════════════════════════════════════
//  asBuffer — one normaliser for every stored binary that leaves the API.
//
//  A `Buffer` field in MongoDB does not always come back as a Node Buffer.
//  With `.lean()` the driver hands back a BSON `Binary` — an object with a
//  `buffer` (Uint8Array) and a `position` — and Node then refuses it wherever
//  a real Buffer is required:
//
//      TypeError: The "string" argument must be of type string or an instance
//      of Buffer or ArrayBuffer. Received an instance of Binary
//
//  That is exactly what `Buffer.byteLength()` throws, which is how a perfectly
//  good archive turned into a 500 on the download route.
//
//  This file is deliberately dependency-free: it must be importable by a test
//  without mongoose, and it must never throw. An unreadable value becomes an
//  empty buffer, so a caller sends an empty file rather than a stack trace.
// ═══════════════════════════════════════════════════════════════════════════

const EMPTY = () => Buffer.alloc(0);

const isByteView = (value) =>
  value instanceof Uint8Array ||
  (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) ||
  value instanceof ArrayBuffer;

export const asBuffer = (value) => {
  if (value === null || value === undefined) return EMPTY();
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);

  // BSON Binary (what `.lean()` returns for a Buffer field): the bytes live in
  // `buffer`, and `position` says how many of them were written.
  if (isByteView(value?.buffer)) {
    const bytes = Buffer.from(value.buffer);
    const written = Number(value.position);
    return Number.isFinite(written) && written >= 0 && written <= bytes.length
      ? bytes.subarray(0, written)
      : bytes;
  }

  // Older bson exposes `value()` instead of `buffer`.
  if (typeof value?.value === 'function') {
    try {
      const bytes = value.value(true);
      if (isByteView(bytes)) return asBuffer(bytes);
    } catch {
      return EMPTY();
    }
  }

  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Array.isArray(value)) {
    try {
      return Buffer.from(value);
    } catch {
      return EMPTY();
    }
  }

  try {
    return Buffer.from(value);
  } catch {
    return EMPTY();
  }
};

/** True when the value carries no bytes at all, whatever shape it arrived in. */
export const isEmptyBinary = (value) => asBuffer(value).length === 0;

export default asBuffer;
