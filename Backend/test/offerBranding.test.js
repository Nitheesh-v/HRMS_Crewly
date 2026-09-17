// Offer document branding — hermetic suite.
//
// Real PDFKit renders (no Mongo/Redis/network). The offer keeps its CREWLY
// product band; tenant branding adds the approval-time logo beside it.
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

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const baseOffer = () => ({
  offerCode: 'OFF-000001',
  companySnapshot: { name: 'Acme Pvt Ltd', address: 'Chennai' },
  candidateSnapshot: { name: 'Jane Doe' },
  approval: { approvedAt: new Date('2026-09-01T00:00:00.000Z') },
  approvalSignatory: { name: 'HR Manager', role: 'HR', approvedAt: new Date('2026-09-01T00:00:00.000Z') },
  terms: {
    offerDate: new Date('2026-08-24T00:00:00.000Z'),
    expiryDate: new Date('2026-09-30T00:00:00.000Z'),
    designation: 'Platform Engineer',
    departmentName: 'Engineering',
    workMode: 'HYBRID',
    employmentType: 'FULL_TIME',
    joiningDate: new Date('2026-10-01T00:00:00.000Z'),
    reportingManagerName: 'Hiring Manager',
  },
  renderedContent: 'Dear Jane, we are pleased to offer you the position.',
  compensationSnapshot: {
    currency: 'INR',
    annualCTC: 1200000,
    monthly: { basic: 50000, hra: 20000 },
    variablePay: 0,
  },
});

test('offer pdf — pre-branding offers render the text-only header unchanged', async () => {
  const { generateOfferPdf } = await import('../src/utils/offerPdfService.js');
  const pdf = await generateOfferPdf(baseOffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const text = pdfText(pdf);
  assert.ok(text.includes('CREWLY'));
  assert.ok(text.includes('Acme Pvt Ltd'));
  assert.ok(text.includes('Jane Doe'));
});

test('offer pdf — approval-time logo embeds; corrupt bytes keep the text header', async () => {
  const { generateOfferPdf } = await import('../src/utils/offerPdfService.js');
  const plain = await generateOfferPdf(baseOffer());
  const branded = await generateOfferPdf({ ...baseOffer(), brandingLogo: ONE_PX_PNG });
  assert.notEqual(Buffer.compare(plain, branded), 0);
  assert.ok(pdfText(branded).includes('CREWLY'), 'product band retained with logo');

  const corrupt = await generateOfferPdf({ ...baseOffer(), brandingLogo: Buffer.from('not-an-image') });
  assert.equal(normalizePdf(plain), normalizePdf(corrupt));
});

test('offer letter model — companySnapshot carries the approval-time branding capture', async () => {
  const { default: OfferLetter } = await import('../src/models/OfferLetter.js');
  assert.ok(OfferLetter.schema.path('companySnapshot.logoUrl'), 'logoUrl path exists');
  assert.ok(OfferLetter.schema.path('companySnapshot.brandingSnapshot.logoVersion'), 'logoVersion path exists');
  assert.ok(OfferLetter.schema.path('companySnapshot.brandingSnapshot.hasLogo'), 'hasLogo path exists');
  assert.ok(!OfferLetter.schema.path('companySnapshot.brandingSnapshot.templateId'), 'offers have no template selection');
});
