// Payslip document branding — hermetic suite.
//
// Real PDFKit renders (no Mongo/Redis/network). Proves the money law:
// the same snapshot through different templates preserves every rupee.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

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

const moneyStrings = (buffer) => pdfText(buffer).match(/Rs [\d,]+/g) || [];

const brandedCompany = () => ({
  name: 'Acme Pvt Ltd',
  address: 'Chennai',
  logoUrl: 'https://res.cloudinary.com/demo/image/upload/logo.png',
  branding: {
    logo: { deliveryUrl: 'https://res.cloudinary.com/demo/image/upload/logo.png', version: 2 },
    layout: { width: 80, maxHeight: 50, fit: 'COVER', alignment: 'RIGHT' },
  },
  documentBranding: { payslip: { templateId: 'MINIMAL' } },
});

const builderInput = (company) => ({
  company,
  setup: { payrollPolicy: { frequency: 'MONTHLY' } },
  employee: { _id: 'e1', employeeCode: 'EMP001', name: 'Asha Rao' },
  profile: {},
  result: {
    employeeCode: 'EMP001',
    employeeName: 'Asha Rao',
    earnings: [{ name: 'Basic Salary', amount: 60000 }],
    variableEarnings: [],
    reimbursements: [],
    deductions: [{ name: 'Provident Fund', amount: 7200 }],
    employerContributions: [],
    totals: {
      grossSalary: 60000,
      totalEarnings: 60000,
      totalDeductions: 7200,
      netSalary: 52800,
    },
    attendance: {},
  },
  payment: {},
  month: '2026-09',
  payslipNumber: 'PS-2026-09-000001',
  generatedAt: '2026-09-30T00:00:00.000Z',
});

test('payslip snapshot — builder captures generation-time branding; bare companies get defaults', async () => {
  const { buildPayslipSnapshot } = await import('../src/services/payroll/payslipRules.js');
  const snapshot = buildPayslipSnapshot(builderInput(brandedCompany()));
  assert.deepEqual(snapshot.company.brandingSnapshot, {
    logoVersion: 2,
    hasLogo: true,
    layout: { width: 80, maxHeight: 50, fit: 'COVER', alignment: 'RIGHT' },
    templateId: 'MINIMAL',
  });

  const bare = buildPayslipSnapshot(builderInput({ name: 'No Brand Co', address: '', logoUrl: '' }));
  assert.deepEqual(bare.company.brandingSnapshot, {
    logoVersion: 0,
    hasLogo: false,
    layout: { width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT' },
    templateId: 'CLASSIC_CORPORATE',
  });
});

test('payslip templates — CLASSIC and MINIMAL are distinct documents', async () => {
  const { buildPayslipPdf } = await import('../src/utils/payslipPdf.js');
  const { buildSamplePayslipSnapshot } = await import('../src/utils/payslipTemplates.js');
  const snapshot = buildSamplePayslipSnapshot({ companyName: 'Acme Pvt Ltd' });
  const classic = await buildPayslipPdf(snapshot, {});
  const minimal = await buildPayslipPdf(snapshot, { templateId: 'MINIMAL' });
  for (const pdf of [classic, minimal]) {
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  }
  assert.ok(pdfText(classic).includes('Earnings'), 'classic has Earnings section');
  assert.ok(!pdfText(classic).includes('EARNINGS'), 'classic is not the minimal style');
  assert.ok(pdfText(minimal).includes('EARNINGS'), 'minimal has its own section style');
  assert.ok(pdfText(minimal).includes('PAYSLIP'), 'minimal has its own title style');
  assert.notEqual(Buffer.compare(classic, minimal), 0);
});

test('payslip templates — MONEY LAW: identical rupee values across templates', async () => {
  const { buildPayslipPdf } = await import('../src/utils/payslipPdf.js');
  const { buildSamplePayslipSnapshot } = await import('../src/utils/payslipTemplates.js');
  const snapshot = buildSamplePayslipSnapshot({ companyName: 'Acme Pvt Ltd' });
  const classic = await buildPayslipPdf(snapshot, {});
  const minimal = await buildPayslipPdf(snapshot, { templateId: 'MINIMAL' });
  const classicMoney = moneyStrings(classic).sort();
  const minimalMoney = moneyStrings(minimal).sort();
  assert.ok(classicMoney.length > 5, `classic carries money values (got ${classicMoney.length})`);
  assert.deepEqual(minimalMoney, classicMoney);
  assert.ok(classicMoney.includes('Rs 87,600'), 'net pay present in both');
});

test('payslip templates — snapshot templateId drives the render; unknown ids fall back to classic', async () => {
  const { buildPayslipPdf } = await import('../src/utils/payslipPdf.js');
  const { buildSamplePayslipSnapshot } = await import('../src/utils/payslipTemplates.js');
  const viaSnapshot = buildSamplePayslipSnapshot({
    companyName: 'Acme',
    brandingSnapshot: { logoVersion: 0, hasLogo: false, templateId: 'MINIMAL', layout: { width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT' } },
  });
  const rendered = await buildPayslipPdf(viaSnapshot, {});
  assert.ok(pdfText(rendered).includes('EARNINGS'), 'snapshot templateId selects MINIMAL');

  const unknown = await buildPayslipPdf(viaSnapshot, { templateId: 'FANCY' });
  assert.ok(!pdfText(unknown).includes('EARNINGS'), 'unknown template falls back to classic');
});

test('payslip templates — pre-branding snapshots (no capture) render classic unchanged', async () => {
  const { buildPayslipPdf } = await import('../src/utils/payslipPdf.js');
  const { buildSamplePayslipSnapshot } = await import('../src/utils/payslipTemplates.js');
  const snapshot = buildSamplePayslipSnapshot({ companyName: 'Acme' });
  delete snapshot.company.brandingSnapshot;
  const rendered = await buildPayslipPdf(snapshot, {});
  assert.equal(rendered.subarray(0, 5).toString(), '%PDF-');
  assert.ok(!pdfText(rendered).includes('EARNINGS'));
  assert.ok(pdfText(rendered).includes('Rs 87,600'));
});

test('payslip header — logo embeds, alignment moves it, corrupt bytes fall back cleanly', async () => {
  const { buildPayslipPdf } = await import('../src/utils/payslipPdf.js');
  const { buildSamplePayslipSnapshot } = await import('../src/utils/payslipTemplates.js');
  const base = buildSamplePayslipSnapshot({ companyName: 'Acme Pvt Ltd' });
  const plain = await buildPayslipPdf(base, {});
  const withLogo = await buildPayslipPdf(base, { logo: { buffer: ONE_PX_PNG, contentType: 'image/png' } });
  assert.notEqual(Buffer.compare(plain, withLogo), 0);

  const left = await buildPayslipPdf(base, {
    logo: { buffer: ONE_PX_PNG, contentType: 'image/png' },
    layout: { width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT' },
  });
  const right = await buildPayslipPdf(base, {
    logo: { buffer: ONE_PX_PNG, contentType: 'image/png' },
    layout: { width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'RIGHT' },
  });
  assert.notEqual(Buffer.compare(left, right), 0);
  const cover = await buildPayslipPdf(base, {
    logo: { buffer: ONE_PX_PNG, contentType: 'image/png' },
    layout: { width: 80, maxHeight: 50, fit: 'COVER', alignment: 'CENTER' },
  });
  assert.equal(cover.subarray(0, 5).toString(), '%PDF-');

  const corrupt = await buildPayslipPdf(base, { logo: { buffer: Buffer.from('not-an-image'), contentType: 'image/png' } });
  assert.equal(normalizePdf(plain), normalizePdf(corrupt));
  assert.ok(pdfText(corrupt).includes('AP'), 'initials badge fallback keeps the company mark');
});

test('payslip preview — sample data only, watermarked, never a real payslip', async () => {
  const { buildPayslipPdf } = await import('../src/utils/payslipPdf.js');
  const { buildSamplePayslipSnapshot } = await import('../src/utils/payslipTemplates.js');
  const sample = buildSamplePayslipSnapshot({ companyName: 'Acme' });
  assert.equal(sample.payroll.payslipNumber, 'SAMPLE-0000');
  assert.equal(sample.employee.name, 'Sample Employee');
  const preview = await buildPayslipPdf(sample, { templateId: 'MINIMAL', preview: true });
  assert.ok(pdfText(preview).includes('SAMPLE'));
  assert.ok(pdfText(preview).includes('NOT A REAL PAYSLIP'));
  const real = await buildPayslipPdf(sample, { templateId: 'MINIMAL' });
  assert.ok(!pdfText(real).includes('SAMPLE-0000') || pdfText(real).includes('SAMPLE-0000'));
  assert.ok(!pdfText(real).includes('NOT A REAL PAYSLIP'), 'non-preview renders carry no watermark');
});
