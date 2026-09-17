// ─────────────────────────────────────────────────────────────
// Company Branding & Document Branding — pure rules.
//
// No IO, no models, no external dependencies. Every bound, enum and default
// below is enforced backend-side; frontend values are never trusted.
// PDF rendering clamps through these same constants independently.
// ─────────────────────────────────────────────────────────────

// §8 — a company logo never needs more than this. Matches the avatar
// upload precedent (2 MB).
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

// §7 — PNG/JPEG only. No SVG (active/external content), no GIF/WEBP
// (the PDFKit pipeline cannot reliably render them).
export const LOGO_ALLOWED_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg']);

// §9 — pathological source dimensions are refused before storage.
export const LOGO_MAX_SOURCE_DIMENSION = 2000;

export const IMAGE_FIT = Object.freeze({
  CONTAIN: 'CONTAIN',
  COVER: 'COVER',
});

export const LOGO_ALIGNMENT = Object.freeze({
  LEFT: 'LEFT',
  CENTER: 'CENTER',
  RIGHT: 'RIGHT',
});

// Addition §4 — safe backend bounds for document-header logo display,
// in PDF points. Absurd tenant values can never reach a renderer.
export const LOGO_DISPLAY_BOUNDS = Object.freeze({
  widthMin: 16,
  widthMax: 120,
  heightMin: 12,
  heightMax: 80,
});

// The pre-branding payslip header drew the logo at fit [34, 30],
// left-aligned, aspect-preserved — these defaults reproduce it exactly.
export const DEFAULT_LOGO_LAYOUT = Object.freeze({
  width: 34,
  maxHeight: 30,
  fit: IMAGE_FIT.CONTAIN,
  alignment: LOGO_ALIGNMENT.LEFT,
});

// Addition §6 — backend-controlled template registry. Tenants select a
// templateId; they never upload markup, styles or code.
export const PAYSLIP_TEMPLATE = Object.freeze({
  CLASSIC_CORPORATE: 'CLASSIC_CORPORATE',
  MINIMAL: 'MINIMAL',
});

export const DEFAULT_PAYSLIP_TEMPLATE = PAYSLIP_TEMPLATE.CLASSIC_CORPORATE;

// Addition §12 — the ONLY document types with tenant-facing branding
// configuration. Every other generator either consumes the shared logo
// (statutory/F&F/analytics) or stays platform-branded (BGV).
export const CONFIGURED_DOCUMENT_TYPES = Object.freeze(['PAYSLIP', 'OFFER_LETTER']);

const clampInt = (value, min, max, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

// Lenient: unknown/missing fields fall back to defaults. Used on every
// read path so a corrupt setting can never break a render.
export const sanitizeLogoLayout = (layout = {}) => ({
  width: clampInt(
    layout?.width,
    LOGO_DISPLAY_BOUNDS.widthMin,
    LOGO_DISPLAY_BOUNDS.widthMax,
    DEFAULT_LOGO_LAYOUT.width
  ),
  maxHeight: clampInt(
    layout?.maxHeight,
    LOGO_DISPLAY_BOUNDS.heightMin,
    LOGO_DISPLAY_BOUNDS.heightMax,
    DEFAULT_LOGO_LAYOUT.maxHeight
  ),
  fit: IMAGE_FIT[layout?.fit] || DEFAULT_LOGO_LAYOUT.fit,
  alignment: LOGO_ALIGNMENT[layout?.alignment] || DEFAULT_LOGO_LAYOUT.alignment,
});

export const sanitizePayslipTemplateId = (value) =>
  PAYSLIP_TEMPLATE[value] || DEFAULT_PAYSLIP_TEMPLATE;

// Strict: throws on anything invalid. Used on the mutation path (after
// the express-validator layer) so bad input is rejected, not coerced.
export const assertValidLogoLayout = (layout = {}) => {
  const { widthMin, widthMax, heightMin, heightMax } = LOGO_DISPLAY_BOUNDS;
  const width = Number(layout?.width);
  const maxHeight = Number(layout?.maxHeight);
  if (!Number.isInteger(width) || width < widthMin || width > widthMax) {
    throw new Error(`Logo width must be an integer ${widthMin}–${widthMax}`);
  }
  if (!Number.isInteger(maxHeight) || maxHeight < heightMin || maxHeight > heightMax) {
    throw new Error(`Logo max height must be an integer ${heightMin}–${heightMax}`);
  }
  if (!IMAGE_FIT[layout?.fit]) throw new Error('Logo fit must be CONTAIN or COVER');
  if (!LOGO_ALIGNMENT[layout?.alignment]) {
    throw new Error('Logo alignment must be LEFT, CENTER or RIGHT');
  }
  return { width, maxHeight, fit: layout.fit, alignment: layout.alignment };
};

export const assertValidPayslipTemplateId = (value) => {
  if (!PAYSLIP_TEMPLATE[value]) throw new Error(`Unknown payslip template: ${String(value)}`);
  return value;
};

// Addition §14 — branding snapshot captured at document-generation time.
// Pure: pass generation-time company state (a doc or a plain object).
// Identity + version + layout only: no bytes, no executable markup.
export const snapshotBranding = (company, docType, overrides = {}) => {
  const logo = company?.branding?.logo || null;
  const payslipLogo = company?.documentBranding?.payslip?.logo || {};
  const inherited =
    docType === 'PAYSLIP'
      ? Object.fromEntries(
          Object.entries({
            width: payslipLogo.width ?? undefined,
            maxHeight: payslipLogo.maxHeight ?? undefined,
            fit: payslipLogo.fit ?? undefined,
            alignment: payslipLogo.alignment ?? undefined,
          }).filter(([, value]) => value !== undefined)
        )
      : {};
  const layout = sanitizeLogoLayout({
    ...DEFAULT_LOGO_LAYOUT,
    ...(company?.branding?.layout || {}),
    ...inherited,
    ...(overrides?.layout || {}),
  });
  const snapshot = {
    logoVersion: logo?.version || 0,
    hasLogo: Boolean(logo?.deliveryUrl),
    layout,
  };
  if (docType === 'PAYSLIP') {
    snapshot.templateId = sanitizePayslipTemplateId(
      overrides?.templateId ?? company?.documentBranding?.payslip?.templateId
    );
  }
  return snapshot;
};

// ── Dependency-free image dimension readers (no sharp, no file-type) ──

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const readPngDimensions = (buffer) => {
  // IHDR must be the first chunk: width/height are bytes 16–23.
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
};

const readJpegDimensions = (buffer) => {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  // Scan markers for a Start-Of-Frame that carries dimensions.
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const size = buffer.readUInt16BE(offset + 2);
    if (size < 2 || offset + size + 2 > buffer.length) return null;
    // SOF0–SOF3, SOF5–SOF7, SOF9–SOF11, SOF13–SOF15 (SOF4/8/12 excluded).
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    offset += 2 + size;
  }
  return null;
};

export const readImageDimensions = (buffer, mimeType) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  if (mimeType === 'image/png') return readPngDimensions(buffer);
  if (mimeType === 'image/jpeg') return readJpegDimensions(buffer);
  return null;
};

export const assertSaneSourceDimensions = (buffer, mimeType) => {
  const dimensions = readImageDimensions(buffer, mimeType);
  if (!dimensions) throw new Error('Logo image dimensions could not be determined');
  if (
    dimensions.width > LOGO_MAX_SOURCE_DIMENSION ||
    dimensions.height > LOGO_MAX_SOURCE_DIMENSION
  ) {
    throw new Error(
      `Logo dimensions must not exceed ${LOGO_MAX_SOURCE_DIMENSION}px on either side`
    );
  }
  return dimensions;
};

// Fallback identity when no logo exists. Initials only — never a broken
// image icon, in UI or in PDFs.
export const initialsOf = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'CO';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
};
