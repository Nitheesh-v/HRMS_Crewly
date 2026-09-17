// BGV final report — platform-branded regression suite (hermetic).
//
// The BGV report is Crewly/Infolexus platform identity rendered from the
// stored snapshot only. Tenant branding must NEVER appear on it — this
// suite fails if anyone wires a tenant logo into the BGV renderer.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

import { inflateSync } from 'node:zlib';

// PDFKit compresses content streams: inflate them for text assertions, and
// normalize the per-render metadata (timestamps, trailer id) for equality.
// PDFKit kerns words as hex-fragment arrays ([<50> 100 <41>] TJ): decode each
// array's fragments in order so assertions read human-visible words.
const decodePdfText = (content) =>
  content
    .replace(/\[((?:<[^>]*>|-?[\d.]+|\s)+)\]\s*TJ/g, (array) =>
      [...array.matchAll(/<([0-9a-fA-F]+)>/g)]
        .map((fragment) => Buffer.from(fragment[1], 'hex').toString('latin1'))
        .join('')
    )
    .replace(/<([0-9a-fA-F]+)>/g, (_, hex) => Buffer.from(hex, 'hex').toString('latin1'));

const pdfText = (buffer) => {
  const raw = buffer.toString('latin1');
  const parts = [raw];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match = re.exec(raw);
  while (match !== null) {
    try {
      const inflated = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
      // PDFKit kerns text as hex fragments ([<4f70> 10 <6572>] TJ): decode and
      // concatenate so assertions read the human-visible words.
      parts.push(decodePdfText(inflated));
    } catch {
      // Not a flate stream (e.g. embedded images) — skipped.
    }
    match = re.exec(raw);
  }
  return parts.join('\n');
};

const normalizePdf = (buffer) =>
  buffer
    .toString('latin1')
    .replace(/\/CreationDate\s*\([^)]*\)/g, '/CreationDate (D)')
    .replace(/\/ModDate\s*\([^)]*\)/g, '/ModDate (D)')
    .replace(/\/ID\s*\[[^\]]*\]/g, '/ID []');

const baseSnapshot = () => ({
  reportNumber: 'BGVRPT-000001',
  version: 1,
  overallOutcome: 'VERIFIED',
  generatedAt: '2026-09-01T00:00:00.000Z',
  tenantName: 'Acme Pvt Ltd',
  candidateName: 'Jane Doe',
  identity: [{ documentType: 'PAN', identifierMasked: 'XXXXX1234X' }],
  checks: [
    {
      checkType: 'IDENTITY',
      conclusion: 'VERIFIED',
      revision: 2,
      methods: ['DOCUMENT_REVIEW'],
      completedAt: '2026-09-01T00:00:00.000Z',
      discrepancies: [],
    },
  ],
  disclaimer: 'Human review required for final decisions.',
});

test('bgv report — platform identity header, tenant shown as requesting org only', async () => {
  const { buildBgvReportPdf } = await import('../src/utils/bgvReportPdf.js');
  const pdf = await buildBgvReportPdf(baseSnapshot());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const text = pdfText(pdf);
  assert.ok(text.includes('Crewly'), 'Crewly platform identity present');
  assert.ok(text.includes('Infolexus'), 'operator identity present');
  assert.ok(text.includes('Acme Pvt Ltd'), 'requesting organization named in body');
});

test('bgv report — injected tenant branding fields are ignored byte-for-byte', async () => {
  const { buildBgvReportPdf } = await import('../src/utils/bgvReportPdf.js');
  const clean = await buildBgvReportPdf(baseSnapshot());
  const injected = await buildBgvReportPdf({
    ...baseSnapshot(),
    logoUrl: 'https://res.cloudinary.com/demo/image/upload/tenant-logo.png',
    tenantBranding: { templateId: 'MINIMAL', logoVersion: 9 },
    brandingSnapshot: { logoVersion: 9, hasLogo: true },
    brandingLogo: Buffer.from('fake-bytes'),
  });
  assert.equal(normalizePdf(clean), normalizePdf(injected));
  assert.ok(!pdfText(clean).includes('cloudinary'), 'no tenant asset reference leaks in');
});
