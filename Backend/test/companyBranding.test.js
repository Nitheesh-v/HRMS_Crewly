// Company Branding & Document Branding — hermetic suite.
//
// No MongoDB, no Redis, no network: the company model, audit sink,
// file inspector, storage and clock are all injected fakes.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ACTOR = { _id: 'cccccccccccccccccccccccc', name: 'Admin User', role: 'COMPANY_ADMIN' };

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const pngWithSize = (width, height) => {
  const buf = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};

const jpegWithSize = (width, height) =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x02, 0x03, 0x04,
  ]);

const emptyLogo = () => ({
  provider: '',
  publicId: '',
  deliveryUrl: '',
  mimeType: '',
  bytes: 0,
  width: 0,
  height: 0,
  version: 0,
  uploadedAt: null,
  uploadedBy: null,
});

const makeCompanyDoc = (seed = {}) => {
  const doc = {
    _id: COMPANY_A,
    name: 'Acme Pvt Ltd',
    archivedAt: null,
    logoUrl: '',
    branding: {
      logo: emptyLogo(),
      layout: { width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT' },
    },
    documentBranding: {
      payslip: {
        templateId: 'CLASSIC_CORPORATE',
        logo: { width: null, maxHeight: null, fit: null, alignment: null },
      },
      offer: { useCompanyLogo: true },
    },
    ...seed,
    saved: 0,
    set(path, value) {
      const parts = String(path).split('.');
      let node = doc;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (node[parts[i]] === undefined || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = value;
    },
    async save() {
      doc.saved += 1;
      return doc;
    },
  };
  return doc;
};

const pngFile = (buffer = ONE_PX_PNG) => ({
  buffer,
  mimetype: 'image/png',
  originalname: 'logo.png',
  size: buffer.length,
});

// ── pure rules ────────────────────────────────────────────────

test('branding rules — layout sanitizer clamps absurd values to safe bounds', async () => {
  const { sanitizeLogoLayout } = await import('../src/services/companyBrandingRules.js');
  assert.deepEqual(sanitizeLogoLayout({}), {
    width: 34,
    maxHeight: 30,
    fit: 'CONTAIN',
    alignment: 'LEFT',
  });
  assert.deepEqual(
    sanitizeLogoLayout({ width: 50000, maxHeight: 50000, fit: 'CORNER', alignment: 'DIAGONAL' }),
    { width: 120, maxHeight: 80, fit: 'CONTAIN', alignment: 'LEFT' }
  );
  assert.deepEqual(
    sanitizeLogoLayout({ width: 80, maxHeight: 50, fit: 'COVER', alignment: 'RIGHT' }),
    { width: 80, maxHeight: 50, fit: 'COVER', alignment: 'RIGHT' }
  );
});

test('branding rules — strict layout/template assertions reject bad input', async () => {
  const {
    assertValidLogoLayout,
    assertValidPayslipTemplateId,
    sanitizePayslipTemplateId,
  } = await import('../src/services/companyBrandingRules.js');
  assert.deepEqual(assertValidLogoLayout({ width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT' }), {
    width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT',
  });
  assert.throws(() => assertValidLogoLayout({ width: 50000, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT' }), /width/);
  assert.throws(() => assertValidLogoLayout({ width: 34, maxHeight: 30, fit: 'STRETCH', alignment: 'LEFT' }), /fit/);
  assert.throws(() => assertValidLogoLayout({ width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'MIDDLE' }), /alignment/);
  assert.equal(assertValidPayslipTemplateId('MINIMAL'), 'MINIMAL');
  assert.throws(() => assertValidPayslipTemplateId('FANCY'), /Unknown payslip template/);
  assert.equal(sanitizePayslipTemplateId('FANCY'), 'CLASSIC_CORPORATE');
});

test('branding rules — dependency-free PNG/JPEG dimension readers', async () => {
  const { readImageDimensions, assertSaneSourceDimensions } = await import(
    '../src/services/companyBrandingRules.js'
  );
  assert.deepEqual(readImageDimensions(pngWithSize(100, 50), 'image/png'), { width: 100, height: 50 });
  assert.deepEqual(readImageDimensions(jpegWithSize(300, 200), 'image/jpeg'), { width: 300, height: 200 });
  assert.equal(readImageDimensions(Buffer.from('nope'), 'image/png'), null);
  assert.equal(readImageDimensions(pngWithSize(10, 10), 'image/webp'), null);
  assert.deepEqual(assertSaneSourceDimensions(pngWithSize(64, 64), 'image/png'), { width: 64, height: 64 });
  assert.throws(() => assertSaneSourceDimensions(Buffer.from('nope'), 'image/png'), /could not be determined/);
  assert.throws(() => assertSaneSourceDimensions(pngWithSize(3000, 10), 'image/png'), /must not exceed 2000px/);
});

test('branding rules — initials fallback + generation-time snapshots', async () => {
  const { initialsOf, snapshotBranding } = await import('../src/services/companyBrandingRules.js');
  assert.equal(initialsOf('Acme Pvt Ltd'), 'AL');
  assert.equal(initialsOf('X'), 'X');
  assert.equal(initialsOf(''), 'CO');

  const company = makeCompanyDoc();
  company.branding.logo = {
    ...emptyLogo(),
    deliveryUrl: 'data:image/png;base64,AAAA',
    version: 3,
  };
  company.branding.layout = { width: 80, maxHeight: 50, fit: 'COVER', alignment: 'RIGHT' };
  company.documentBranding.payslip.templateId = 'MINIMAL';
  const payslip = snapshotBranding(company, 'PAYSLIP');
  assert.deepEqual(payslip, {
    logoVersion: 3,
    hasLogo: true,
    layout: { width: 80, maxHeight: 50, fit: 'COVER', alignment: 'RIGHT' },
    templateId: 'MINIMAL',
  });
  // Payslip-level overrides win over company defaults without copying the logo.
  const overridden = snapshotBranding(company, 'PAYSLIP', { layout: { alignment: 'CENTER' } });
  assert.equal(overridden.layout.alignment, 'CENTER');

  const offer = snapshotBranding(company, 'OFFER_LETTER');
  assert.equal(offer.templateId, undefined);
  assert.equal(offer.logoVersion, 3);

  const bare = snapshotBranding({}, 'PAYSLIP');
  assert.deepEqual(bare, {
    logoVersion: 0,
    hasLogo: false,
    layout: { width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT' },
    templateId: 'CLASSIC_CORPORATE',
  });
});

// ── hardened logo resolver ────────────────────────────────────

test('logo resolver — only Crewly-controlled references resolve (SSRF rule)', async () => {
  const { isCrewlyControlledLogoUrl } = await import('../src/utils/companyLogo.js');
  assert.equal(isCrewlyControlledLogoUrl('data:image/png;base64,AAAA'), true);
  assert.equal(isCrewlyControlledLogoUrl('data:image/jpeg;base64,AAAA'), true);
  assert.equal(isCrewlyControlledLogoUrl('data:image/webp;base64,AAAA'), false);
  assert.equal(isCrewlyControlledLogoUrl('data:text/html;base64,AAAA'), false);
  assert.equal(isCrewlyControlledLogoUrl('https://res.cloudinary.com/demo/image/upload/logo.png'), true);
  assert.equal(isCrewlyControlledLogoUrl('http://res.cloudinary.com/demo/logo.png'), false);
  assert.equal(isCrewlyControlledLogoUrl('https://evil.example/logo.png'), false);
  assert.equal(isCrewlyControlledLogoUrl('https://127.0.0.1:9/logo.png'), false);
  assert.equal(isCrewlyControlledLogoUrl(''), false);
  assert.equal(isCrewlyControlledLogoUrl('not-a-url'), false);
});

test('logo resolver — fail-open: inline resolves, arbitrary URLs refuse without network', async () => {
  const { resolveCompanyLogo } = await import('../src/utils/companyLogo.js');
  assert.equal(await resolveCompanyLogo(''), null);
  assert.equal(await resolveCompanyLogo('https://evil.example/logo.png'), null);
  assert.equal(await resolveCompanyLogo('https://127.0.0.1:9/logo.png'), null);
  const inline = await resolveCompanyLogo(`data:image/png;base64,${ONE_PX_PNG.toString('base64')}`);
  assert.ok(inline);
  assert.equal(inline.contentType, 'image/png');
  assert.equal(Buffer.compare(inline.buffer, ONE_PX_PNG), 0);
  assert.equal(await resolveCompanyLogo('data:image/gif;base64,AAAA'), null);
  const huge = await resolveCompanyLogo(`data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`);
  assert.equal(huge, null);
});

// ── service: upload / replace / remove ────────────────────────

const makeHarness = ({ company = null, inspect = null, storage = null } = {}) => {
  const audits = [];
  const queries = [];
  const removed = [];
  const doc = company || makeCompanyDoc();
  const service = null;
  return { audits, queries, removed, doc, service };
};

const buildService = async (harness, { inspectImpl = null, saveImpl = null } = {}) => {
  const { createCompanyBrandingService } = await import('../src/services/companyBrandingService.js');
  return createCompanyBrandingService({
    companyModel: {
      findOne: async (query) => {
        harness.queries.push(query);
        return harness.doc;
      },
    },
    audit: async (entry) => {
      harness.audits.push(entry);
    },
    inspectFile: inspectImpl || (async ({ file }) => ({ mimeType: file.mimetype })),
    storage: {
      save:
        saveImpl ||
        (async ({ companyId }) => ({
          provider: 'CLOUDINARY',
          publicId: `company-${companyId}`,
          deliveryUrl: `https://res.cloudinary.com/demo/image/upload/company-${companyId}.png`,
        })),
      remove: async (logo) => {
        harness.removed.push(logo);
      },
    },
    clock: () => new Date('2026-09-17T00:00:00.000Z'),
  });
};

test('branding service — upload stores metadata, syncs logoUrl, audits, serializes safely', async () => {
  const harness = makeHarness();
  const service = await buildService(harness);
  const safe = await service.uploadLogo({ companyId: COMPANY_A, actor: ACTOR, file: pngFile(pngWithSize(64, 64)) });

  assert.deepEqual(harness.queries, [{ _id: COMPANY_A }]);
  assert.equal(harness.doc.saved, 1);
  assert.equal(harness.doc.branding.logo.version, 1);
  assert.equal(harness.doc.branding.logo.mimeType, 'image/png');
  assert.equal(harness.doc.branding.logo.width, 64);
  assert.equal(harness.doc.logoUrl, 'https://res.cloudinary.com/demo/image/upload/company-aaaaaaaaaaaaaaaaaaaaaaaa.png');
  assert.equal(harness.audits.length, 1);
  assert.equal(harness.audits[0].action, 'COMPANY_LOGO_UPLOADED');
  assert.equal(harness.audits[0].companyId, COMPANY_A);
  assert.deepEqual(Object.keys(harness.audits[0].metadata).sort(), ['bytes', 'height', 'mimeType', 'version', 'width']);

  assert.equal(safe.hasLogo, true);
  assert.equal(safe.logo.deliveryUrl, harness.doc.logoUrl);
  assert.equal(safe.logo.publicId, undefined);
  assert.equal(safe.logo.uploadedBy, undefined);
});

test('branding service — replace bumps version and cleans up only orphaned assets', async () => {
  const { createCompanyBrandingService } = await import('../src/services/companyBrandingService.js');
  void createCompanyBrandingService;
  const doc = makeCompanyDoc();
  doc.branding.logo = {
    ...emptyLogo(),
    provider: 'CLOUDINARY',
    publicId: 'old-public-id',
    deliveryUrl: 'https://res.cloudinary.com/demo/image/upload/old.png',
    version: 4,
  };
  doc.logoUrl = doc.branding.logo.deliveryUrl;
  const harness = makeHarness({ company: doc });
  const service = await buildService(harness);
  await service.uploadLogo({ companyId: COMPANY_A, actor: ACTOR, file: pngFile() });

  assert.equal(doc.branding.logo.version, 5);
  assert.equal(harness.audits[0].action, 'COMPANY_LOGO_REPLACED');
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.removed[0].publicId, 'old-public-id');

  // Same public_id (overwrite in place) → no destroy call.
  const harness2 = makeHarness({ company: doc });
  const service2 = await buildService(harness2, {
    saveImpl: async () => ({ provider: 'CLOUDINARY', publicId: doc.branding.logo.publicId, deliveryUrl: doc.branding.logo.deliveryUrl }),
  });
  await service2.uploadLogo({ companyId: COMPANY_A, actor: ACTOR, file: pngFile() });
  assert.equal(harness2.removed.length, 0);
});

test('branding service — upload validation: missing/invalid/oversized/disguised files refuse', async () => {
  const harness = makeHarness();
  const service = await buildService(harness);
  await assert.rejects(service.uploadLogo({ companyId: COMPANY_A, actor: ACTOR, file: null }), /field "logo"/);

  const badInspect = await buildService(makeHarness(), {
    inspectImpl: async () => {
      throw new Error('File is not a valid PNG image');
    },
  });
  await assert.rejects(
    badInspect.uploadLogo({ companyId: COMPANY_A, actor: ACTOR, file: pngFile() }),
    /not a valid PNG/
  );

  const badDims = await buildService(makeHarness());
  await assert.rejects(
    badDims.uploadLogo({ companyId: COMPANY_A, actor: ACTOR, file: pngFile(pngWithSize(3000, 3000)) }),
    /must not exceed 2000px/
  );
  assert.equal(harness.doc.saved, 0);
});

test('branding service — missing company 404s; queries stay tenant-scoped', async () => {
  const { createCompanyBrandingService } = await import('../src/services/companyBrandingService.js');
  const queries = [];
  const service = createCompanyBrandingService({
    companyModel: {
      findOne: async (query) => {
        queries.push(query);
        return null;
      },
    },
    audit: async () => {},
  });
  await assert.rejects(service.uploadLogo({ companyId: COMPANY_B, actor: ACTOR, file: pngFile() }), /Company not found/);
  await assert.rejects(service.removeLogo({ companyId: COMPANY_B, actor: ACTOR }), /Company not found/);
  await assert.rejects(service.updateSettings({ companyId: COMPANY_B, actor: ACTOR, layout: {} }), /Company not found/);
  assert.deepEqual(queries, [{ _id: COMPANY_B }, { _id: COMPANY_B }, { _id: COMPANY_B }]);
});

test('branding service — remove clears the logo; empty remove is a silent no-op', async () => {
  const doc = makeCompanyDoc();
  doc.branding.logo = { ...emptyLogo(), provider: 'CLOUDINARY', publicId: 'company-x', deliveryUrl: 'https://res.cloudinary.com/demo/x.png', version: 2 };
  doc.logoUrl = doc.branding.logo.deliveryUrl;
  const harness = makeHarness({ company: doc });
  const service = await buildService(harness);
  const safe = await service.removeLogo({ companyId: COMPANY_A, actor: ACTOR });
  assert.equal(doc.logoUrl, '');
  assert.equal(doc.branding.logo.deliveryUrl, '');
  assert.equal(doc.branding.logo.version, 2);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.audits[0].action, 'COMPANY_LOGO_REMOVED');
  assert.equal(safe.hasLogo, false);

  const empty = makeHarness();
  const service2 = await buildService(empty);
  await service2.removeLogo({ companyId: COMPANY_A, actor: ACTOR });
  assert.equal(empty.doc.saved, 0);
  assert.equal(empty.audits.length, 0);
});

// ── service: settings + resolver + snapshots ──────────────────

test('branding service — settings merge, validate and audit; empty update is a no-op', async () => {
  const harness = makeHarness();
  const service = await buildService(harness);
  const safe = await service.updateSettings({
    companyId: COMPANY_A,
    actor: ACTOR,
    layout: { width: 80, alignment: 'RIGHT' },
    documentBranding: { payslip: { templateId: 'MINIMAL', logo: { width: null, alignment: 'CENTER' } }, offer: { useCompanyLogo: false } },
  });
  assert.deepEqual(harness.doc.branding.layout, { width: 80, maxHeight: 30, fit: 'CONTAIN', alignment: 'RIGHT' });
  assert.equal(harness.doc.documentBranding.payslip.templateId, 'MINIMAL');
  assert.deepEqual(harness.doc.documentBranding.payslip.logo, { width: null, maxHeight: null, fit: null, alignment: 'CENTER' });
  assert.equal(harness.doc.documentBranding.offer.useCompanyLogo, false);
  assert.equal(harness.audits[0].action, 'COMPANY_BRANDING_UPDATED');
  assert.deepEqual(harness.audits[0].metadata.fields.sort(), ['layout', 'offer.useCompanyLogo', 'payslip.logo', 'payslip.templateId']);
  assert.equal(safe.documentBranding.payslip.templateId, 'MINIMAL');

  await assert.rejects(
    service.updateSettings({ companyId: COMPANY_A, actor: ACTOR, layout: { width: 50000 } }),
    /width/
  );
  await assert.rejects(
    service.updateSettings({ companyId: COMPANY_A, actor: ACTOR, documentBranding: { payslip: { templateId: 'NOPE' } } }),
    /Unknown payslip template/
  );

  const quiet = makeHarness();
  const service2 = await buildService(quiet);
  await service2.updateSettings({ companyId: COMPANY_A, actor: ACTOR });
  assert.equal(quiet.doc.saved, 0);
  assert.equal(quiet.audits.length, 0);
});

test('branding service — resolver contract exposes identity, never internals', async () => {
  const harness = makeHarness();
  const service = await buildService(harness);
  const resolved = await service.resolveCompanyBranding({ companyId: COMPANY_A });
  assert.deepEqual(Object.keys(resolved).sort(), ['companyName', 'documentBranding', 'hasLogo', 'initials', 'layout', 'logoResource']);
  assert.equal(resolved.companyName, 'Acme Pvt Ltd');
  assert.equal(resolved.initials, 'AL');
  assert.equal(resolved.hasLogo, false);
  assert.equal(resolved.logoResource, null);
});

test('branding service — Company A settings never leak into Company B snapshots', async () => {
  const harness = makeHarness();
  const service = await buildService(harness);
  const companyA = makeCompanyDoc({ _id: COMPANY_A, name: 'Alpha' });
  companyA.documentBranding.payslip.templateId = 'MINIMAL';
  companyA.branding.layout = { width: 100, maxHeight: 60, fit: 'COVER', alignment: 'RIGHT' };
  const companyB = makeCompanyDoc({ _id: COMPANY_B, name: 'Beta' });
  const snapA = service.buildBrandingSnapshot(companyA, 'PAYSLIP');
  const snapB = service.buildBrandingSnapshot(companyB, 'PAYSLIP');
  assert.equal(snapA.templateId, 'MINIMAL');
  assert.equal(snapB.templateId, 'CLASSIC_CORPORATE');
  assert.deepEqual(snapB.layout, { width: 34, maxHeight: 30, fit: 'CONTAIN', alignment: 'LEFT' });
});
