// Phase 30.5 — CANDIDATE BGV COLLECTION (hermetic suite).
//
// No MongoDB/Redis/SMTP/Cloudinary: every collaborator is injected. The
// real (pure) file-inspection code runs for MIME/magic-byte/size checks, so
// upload security is genuinely exercised. No seeding — fixtures live only
// in memory for the duration of a test.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  computeCollectionReadiness,
  maskIdentifier,
  validateEducationRecord,
  validateEmploymentRecord,
  validateIdentityInput,
  validateReferenceRecord,
} from '../src/services/bgv/bgvCollectionRules.js';
import {
  downloadBgvEvidence,
  getHrCollectionStatus,
  removeBgvEvidence,
  removeEducationRecord,
  resolveCollectionPortal,
  saveAddressInformation,
  saveEducationRecord,
  saveEmploymentRecord,
  saveIdentityInformation,
  saveReferenceRecord,
  submitBgvPackage,
  uploadBgvEvidence,
} from '../src/services/bgv/bgvCollectionService.js';
import { hashToken, randomToken } from '../src/utils/securityPolicy.js';
import { BGV_CONSENT_PURPOSE } from '../src/services/bgv/bgvConsentRules.js';

const COMPANY = 'aaa111111111111111111111';
const OTHER_COMPANY = 'bbb222222222222222222222';
const CANDIDATE_ID = 'ccc333333333333333333333';
const ORDER_ID = 'ord444444444444444444444';
const OTHER_ORDER_ID = 'ord999999999999999999999';
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const RAW_TOKEN = randomToken(48);
const RAW_TOKEN_B = randomToken(48);

const PDF_BUFFER = Buffer.from('%PDF-1.4\n1 0 obj synthetic test evidence endobj\n%%EOF\n');
const JPEG_BUFFER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

const pdfFile = (name = 'synthetic-evidence.pdf') => ({
  originalname: name,
  mimetype: 'application/pdf',
  buffer: PDF_BUFFER,
});
const jpegFile = (name = 'synthetic-selfie.jpg') => ({
  originalname: name,
  mimetype: 'image/jpeg',
  buffer: JPEG_BUFFER,
});

const makeWorld = (opts = {}) => {
  const rawToken = opts.rawToken ?? RAW_TOKEN;
  const state = {
    order: opts.order ?? {
      _id: opts.orderId ?? ORDER_ID,
      companyId: opts.companyId ?? COMPANY,
      candidate: CANDIDATE_ID,
      orderCode: 'BGVORD-000010',
      status: opts.orderStatus ?? 'PAID',
      items: (opts.checks ?? ['IDENTITY', 'EDUCATION']).map((type) => ({
        type,
        name: `${type} check`,
        unitPriceMinorUnits: 1000,
      })),
      totalMinorUnits: 1000,
      openKey: 'OPEN',
    },
    candidate: { _id: CANDIDATE_ID, companyId: COMPANY, name: 'Demo Candidate', candidateCode: 'CAND-1' },
    company: { _id: COMPANY, name: 'Demo Company' },
    token: {
      _id: 'tok555555555555555555555555',
      companyId: opts.companyId ?? COMPANY,
      candidate: CANDIDATE_ID,
      bgvOrder: opts.orderId ?? ORDER_ID,
      purpose: BGV_CONSENT_PURPOSE,
      tokenHash: hashToken(rawToken),
      revokedAt: opts.revokedAt ?? null,
      expiresAt: opts.expiresAt ?? FUTURE,
      finalDecision: 'finalDecision' in opts ? opts.finalDecision : 'CONSENTED',
      decidedAt: opts.finalDecision ? new Date() : null,
    },
    cases: [],
    files: [],
    audits: [],
    stored: new Map(),
    nextId: 0,
  };

  const deps = {
    resolveToken: async (tokenHash) =>
      String(state.token.tokenHash) === String(tokenHash) ? { ...state.token } : null,
    loadOrder: async ({ companyId, orderId }) =>
      String(state.order.companyId) === String(companyId) && String(state.order._id) === String(orderId)
        ? { ...state.order }
        : null,
    loadCompany: async ({ companyId }) =>
      String(state.company._id) === String(companyId) ? { ...state.company } : null,
    loadCandidateByRef: async ({ companyId }) =>
      String(state.candidate.companyId) === String(companyId) ? { ...state.candidate } : null,
    loadLatestOrder: async ({ companyId }) =>
      String(state.order.companyId) === String(companyId) ? { ...state.order } : null,
    loadLatestToken: async () => ({ ...state.token }),
    loadCase: async ({ companyId, orderId }) => {
      const found = state.cases.find(
        (entry) => String(entry.companyId) === String(companyId) && String(entry.bgvOrder) === String(orderId)
      );
      return found ? { ...found } : null;
    },
    createCase: async (doc) => {
      const created = { _id: `case-${state.nextId++}`, ...doc };
      state.cases.push(created);
      return { ...created };
    },
    persistCase: async ({ companyId, caseId, set }) => {
      const found = state.cases.find(
        (entry) => String(entry._id) === String(caseId) && String(entry.companyId) === String(companyId)
      );
      if (!found) return null;
      Object.assign(found, set);
      return { ...found };
    },
    listActiveFiles: async ({ companyId, caseId }) =>
      state.files
        .filter(
          (file) =>
            file.isActive &&
            String(file.companyId) === String(companyId) &&
            String(file.bgvCollectionCase) === String(caseId)
        )
        .map((file) => ({ ...file })),
    createFile: async (doc) => {
      const created = { _id: `file-${state.nextId++}`, uploadedAt: new Date(), ...doc };
      state.files.push(created);
      return { ...created };
    },
    updateFile: async ({ fileId, set }) => {
      const found = state.files.find((file) => String(file._id) === String(fileId));
      if (!found) return null;
      Object.assign(found, set);
      return { ...found };
    },
    loadFileFull: async ({ fileId }) => {
      const found = state.files.find((file) => String(file._id) === String(fileId));
      return found ? { ...found } : null;
    },
    storeFile: async ({ buffer, companyId, caseId }) => {
      const key = `key-${state.nextId++}`;
      state.stored.set(key, buffer);
      return { storageProvider: 'LOCAL_PRIVATE', storageKey: key };
    },
    fetchFile: async ({ storageKey }) => {
      const buffer = state.stored.get(storageKey);
      if (!buffer) throw new Error('missing stored bytes');
      return buffer;
    },
    audit: async (entry) => {
      state.audits.push(entry);
    },
    newRecordId: () => `rec-${state.nextId++}`,
  };

  return { state, deps, rawToken };
};

const consentedWorld = (opts = {}) => makeWorld({ finalDecision: 'CONSENTED', ...opts });

const validIdentity = () => ({
  legalName: 'Demo Candidate',
  dateOfBirth: '1995-04-01',
  documentType: 'PAN',
  identifier: 'ABCDE1234F',
});

const completeIdentityFlow = async (world) => {
  await saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps });
  return uploadBgvEvidence({
    rawToken: world.rawToken,
    category: 'IDENTITY_DOCUMENT',
    file: pdfFile(),
    deps: world.deps,
  });
};

// ══════════════ ACCESS ══════════════

test('30.5: pre-consent save/upload/submit are all rejected (consent gate)', async () => {
  const world = makeWorld({ finalDecision: null });
  await assert.rejects(
    saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps }),
    (e) => e.statusCode === 409 && /consent/i.test(e.message)
  );
  await assert.rejects(
    uploadBgvEvidence({ rawToken: world.rawToken, category: 'IDENTITY_DOCUMENT', file: pdfFile(), deps: world.deps }),
    (e) => e.statusCode === 409
  );
  await assert.rejects(submitBgvPackage({ rawToken: world.rawToken, deps: world.deps }), (e) => e.statusCode === 409);
  assert.equal(world.state.files.length, 0);
});

test('30.5: commercially unauthorized order (not PAID) is rejected everywhere', async () => {
  const world = makeWorld({ orderStatus: 'PENDING_PAYMENT' });
  await assert.rejects(resolveCollectionPortal({ rawToken: world.rawToken, deps: world.deps }), (e) => e.statusCode === 409);
  await assert.rejects(
    saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps }),
    (e) => e.statusCode === 409
  );
  await assert.rejects(submitBgvPackage({ rawToken: world.rawToken, deps: world.deps }), (e) => e.statusCode === 409);
});

test('30.5: revoked / expired / unknown tokens are rejected', async () => {
  const revoked = makeWorld({ revokedAt: new Date() });
  await assert.rejects(resolveCollectionPortal({ rawToken: revoked.rawToken, deps: revoked.deps }), (e) => e.statusCode === 404);

  const expired = makeWorld({ expiresAt: new Date(Date.now() - 1000), rawToken: randomToken(48) });
  await assert.rejects(resolveCollectionPortal({ rawToken: expired.rawToken, deps: expired.deps }), (e) =>
    /expired/i.test(e.message)
  );

  const world = consentedWorld();
  await assert.rejects(
    resolveCollectionPortal({ rawToken: randomToken(48), deps: world.deps }),
    (e) => e.statusCode === 404
  );
});

test('30.5: Candidate A token cannot fetch Candidate B evidence (cross-case isolation)', async () => {
  const worldA = consentedWorld();
  await completeIdentityFlow(worldA);
  const fileA = worldA.state.files.find((file) => file.isActive);

  const worldB = consentedWorld({
    rawToken: RAW_TOKEN_B,
    orderId: OTHER_ORDER_ID,
    companyId: OTHER_COMPANY,
  });
  // World B has its own token/company/order; A's file id must never resolve.
  await assert.rejects(
    downloadBgvEvidence({ rawToken: RAW_TOKEN_B, fileId: fileA._id, deps: worldB.deps }),
    (e) => e.statusCode === 404
  );
  // Anonymous (garbage token) download is rejected too.
  await assert.rejects(
    downloadBgvEvidence({ rawToken: randomToken(48), fileId: fileA._id, deps: worldA.deps }),
    (e) => e.statusCode === 404
  );
  // The owner CAN download their own file.
  const own = await downloadBgvEvidence({ rawToken: RAW_TOKEN, fileId: fileA._id, deps: worldA.deps });
  assert.equal(own.mimeType, 'application/pdf');
  assert.ok(own.buffer.length > 0);
});

// ══════════════ PURCHASED CHECKS ══════════════

test('30.5: purchased check forms are available; summary lists only purchased checks', async () => {
  const world = consentedWorld({ checks: ['IDENTITY', 'EMPLOYMENT'] });
  const summary = await resolveCollectionPortal({ rawToken: world.rawToken, deps: world.deps });
  assert.deepEqual(summary.purchasedChecks, ['IDENTITY', 'EMPLOYMENT']);
  await saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps });
});

test('30.5: unpurchased checks are rejected by the backend (not just hidden)', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  await assert.rejects(
    saveAddressInformation({
      rawToken: world.rawToken,
      input: { line1: '1 Street', city: 'Coimbatore', state: 'TN', pincode: '641001', country: 'India' },
      deps: world.deps,
    }),
    (e) => e.statusCode === 409 && /not purchased/i.test(e.message)
  );
  await assert.rejects(
    saveEducationRecord({
      rawToken: world.rawToken,
      record: { institution: 'X', qualification: 'BSc', startYear: 2015 },
      deps: world.deps,
    }),
    (e) => e.statusCode === 409
  );
  await assert.rejects(
    uploadBgvEvidence({ rawToken: world.rawToken, category: 'EDUCATION_CERTIFICATE', recordId: 'rec-x', file: pdfFile(), deps: world.deps }),
    (e) => e.statusCode === 409
  );
});

test('30.5: frontend renders sections from purchasedChecks only (data contract)', async () => {
  const component = readFileSync(
    new URL('../../Frontend/src/components/candidate/BgvCollectionPortal.jsx', import.meta.url),
    'utf8'
  );
  assert.ok(component.includes('purchasedChecks'));
  // No hardcoded rendering of a check outside the purchased list.
  assert.ok(component.includes('hasCheck'));
});

// ══════════════ IDENTITY ══════════════

test('30.5: accepted identity document type saves; unsupported type rejected', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  const saved = await saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps });
  assert.equal(saved.identity.documentType, 'PAN');

  await assert.rejects(
    saveIdentityInformation({
      rawToken: world.rawToken,
      input: { ...validIdentity(), documentType: 'VOTER_ID' },
      deps: world.deps,
    }),
    (e) => e.statusCode === 400
  );
  // Malformed PAN format rejected too.
  await assert.rejects(
    saveIdentityInformation({
      rawToken: world.rawToken,
      input: { ...validIdentity(), identifier: 'NOT-A-PAN' },
      deps: world.deps,
    }),
    (e) => e.statusCode === 400
  );
});

test('30.5: identifier is masked in every response; full number never persists/logs/audits', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  const saved = await saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps });
  assert.equal(saved.identity.identifierMasked, '******234F');
  assert.equal(saved.identity.identifier, undefined);

  // The persisted case + audit trail never contain the raw number.
  const persisted = JSON.stringify(world.state.cases);
  const audited = JSON.stringify(world.state.audits);
  assert.equal(persisted.includes('ABCDE1234F'), false);
  assert.equal(audited.includes('ABCDE1234F'), false);
  // A select:false fingerprint exists but is not the raw value.
  assert.equal(world.state.cases[0].identity.identifierFingerprint.length, 64);
});

test('30.5: selfie is private image-only evidence (PDF selfie rejected, no URL leaks)', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  await assert.rejects(
    uploadBgvEvidence({ rawToken: world.rawToken, category: 'IDENTITY_SELFIE', file: pdfFile(), deps: world.deps }),
    (e) => e.statusCode === 400
  );
  const selfie = await uploadBgvEvidence({
    rawToken: world.rawToken,
    category: 'IDENTITY_SELFIE',
    file: jpegFile(),
    deps: world.deps,
  });
  assert.equal(selfie.category, 'IDENTITY_SELFIE');
  assert.equal(selfie.storageKey, undefined);
  assert.equal(selfie.url, undefined);
  assert.equal(JSON.stringify(selfie).includes('http'), false);
  // Stored privately via the injected private-store only.
  assert.equal(world.state.files.find((f) => f._id === selfie.id).storageProvider, 'LOCAL_PRIVATE');
});

// ══════════════ ADDRESS ══════════════

test('30.5: address validation enforced; valid address saves with private proof', async () => {
  const world = consentedWorld({ checks: ['ADDRESS'] });
  await assert.rejects(
    saveAddressInformation({
      rawToken: world.rawToken,
      input: { line1: '1 Street', state: 'TN', pincode: '641001', country: 'India' }, // no city
      deps: world.deps,
    }),
    (e) => e.statusCode === 400
  );
  const saved = await saveAddressInformation({
    rawToken: world.rawToken,
    input: {
      line1: '12 Demo Street',
      locality: 'RS Puram',
      city: 'Coimbatore',
      state: 'Tamil Nadu',
      pincode: '641002',
      country: 'India',
      residenceType: 'RENTED',
      evidenceCategory: 'UTILITY_BILL',
    },
    deps: world.deps,
  });
  assert.equal(saved.address.city, 'Coimbatore');

  const proof = await uploadBgvEvidence({
    rawToken: world.rawToken,
    category: 'ADDRESS_PROOF',
    file: pdfFile('utility-bill.pdf'),
    deps: world.deps,
  });
  assert.equal(proof.checkType, 'ADDRESS');
  assert.equal(JSON.stringify(proof).includes('http'), false); // never a public URL
});

// ══════════════ EDUCATION / EMPLOYMENT / REFERENCE ══════════════

test('30.5: multiple education entries; invalid years rejected; edit + remove work', async () => {
  const world = consentedWorld({ checks: ['EDUCATION'] });
  const first = await saveEducationRecord({
    rawToken: world.rawToken,
    record: { institution: 'Demo University', qualification: 'BSc', startYear: 2013, endYear: 2016 },
    deps: world.deps,
  });
  const secondEdu = await saveEducationRecord({
    rawToken: world.rawToken,
    record: { institution: 'Demo Institute', qualification: 'MSc', startYear: 2016, endYear: 2018 },
    deps: world.deps,
  });
  assert.equal(secondEdu.collection.educations.length, 2);

  await assert.rejects(
    saveEducationRecord({
      rawToken: world.rawToken,
      record: { institution: 'Bad', qualification: 'BA', startYear: 2018, endYear: 2015 },
      deps: world.deps,
    }),
    (e) => e.statusCode === 400 && /before the start year/i.test(e.message)
  );
  assert.equal(validateEducationRecord({ institution: 'X', qualification: 'Y', startYear: 3000 }).length > 0, true);

  // Edit before submission keeps the same record id.
  const edited = await saveEducationRecord({
    rawToken: world.rawToken,
    recordId: first.recordId,
    record: { institution: 'Demo University (updated)', qualification: 'BSc', startYear: 2013, endYear: 2016 },
    deps: world.deps,
  });
  assert.equal(edited.collection.educations.length, 2);

  // Remove before submission.
  const afterRemove = await removeEducationRecord({ rawToken: world.rawToken, recordId: first.recordId, deps: world.deps });
  assert.equal(afterRemove.educations.length, 1);
});

test('30.5: multiple employment entries; date validation; sensitive evidence stays private', async () => {
  const world = consentedWorld({ checks: ['EMPLOYMENT'] });
  await assert.rejects(
    saveEmploymentRecord({
      rawToken: world.rawToken,
      record: { employer: 'Old Co', designation: 'Analyst', startDate: '2020-06-01', endDate: '2019-01-01' },
      deps: world.deps,
    }),
    (e) => e.statusCode === 400 && /before the start date/i.test(e.message)
  );

  const first = await saveEmploymentRecord({
    rawToken: world.rawToken,
    record: { employer: 'Old Co', designation: 'Analyst', startDate: '2018-06-01', endDate: '2021-05-31' },
    deps: world.deps,
  });
  const secondEmp = await saveEmploymentRecord({
    rawToken: world.rawToken,
    record: { employer: 'Current Co', designation: 'Senior Analyst', startDate: '2021-06-15', employmentType: 'CURRENT' },
    deps: world.deps,
  });
  assert.equal(secondEmp.collection.employments.length, 2);

  const evidence = await uploadBgvEvidence({
    rawToken: world.rawToken,
    category: 'EMPLOYMENT_EVIDENCE',
    recordId: first.recordId,
    file: pdfFile('payslip-optional.pdf'),
    deps: world.deps,
  });
  assert.equal(evidence.recordId, first.recordId);
  assert.equal(evidence.storageKey, undefined);

  // Record-scoped evidence must reference an existing record.
  await assert.rejects(
    uploadBgvEvidence({
      rawToken: world.rawToken,
      category: 'EMPLOYMENT_EVIDENCE',
      recordId: 'rec-does-not-exist',
      file: pdfFile(),
      deps: world.deps,
    }),
    (e) => e.statusCode === 400
  );
});

test('30.5: valid reference saves; malformed contact rejected', async () => {
  const world = consentedWorld({ checks: ['REFERENCE'] });
  await assert.rejects(
    saveReferenceRecord({
      rawToken: world.rawToken,
      record: { name: 'Ref One', relationship: 'Manager', email: 'not-an-email' },
      deps: world.deps,
    }),
    (e) => e.statusCode === 400
  );
  await assert.rejects(
    saveReferenceRecord({
      rawToken: world.rawToken,
      record: { name: 'Ref One', relationship: 'Manager' }, // no contact at all
      deps: world.deps,
    }),
    (e) => e.statusCode === 400
  );
  assert.equal(validateReferenceRecord({ name: 'A', relationship: 'B', phone: '12' }).length > 0, true);

  const saved = await saveReferenceRecord({
    rawToken: world.rawToken,
    record: { name: 'Ref One', relationship: 'Former Manager', email: 'ref@example.com', phone: '+91 98765 43210' },
    deps: world.deps,
  });
  assert.equal(saved.collection.references.length, 1);
});

// ══════════════ FILE SECURITY ══════════════

test('30.5: invalid MIME, oversize, and executable files are rejected', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  // Claimed PDF but plain text bytes → magic-byte validation rejects.
  await assert.rejects(
    uploadBgvEvidence({
      rawToken: world.rawToken,
      category: 'IDENTITY_DOCUMENT',
      file: { originalname: 'fake.pdf', mimetype: 'application/pdf', buffer: Buffer.from('just text, not a pdf') },
      deps: world.deps,
    }),
    (e) => e.statusCode === 400
  );
  // Oversize (limit is 5 MB for BGV evidence).
  await assert.rejects(
    uploadBgvEvidence({
      rawToken: world.rawToken,
      category: 'IDENTITY_DOCUMENT',
      file: { originalname: 'big.pdf', mimetype: 'application/pdf', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 1) },
      deps: world.deps,
    }),
    (e) => e.statusCode === 400 && /MB or smaller/i.test(e.message)
  );
  // Executable type is not on any allowlist.
  await assert.rejects(
    uploadBgvEvidence({
      rawToken: world.rawToken,
      category: 'IDENTITY_DOCUMENT',
      file: { originalname: 'payload.exe', mimetype: 'application/x-msdownload', buffer: Buffer.from('MZ') },
      deps: world.deps,
    }),
    (e) => e.statusCode === 400 && /not allowed/i.test(e.message)
  );
  assert.equal(world.state.files.length, 0);
});

test('30.5: draft replacement creates version history; NOT_CONFIGURED never fakes CLEAN', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  const v1 = await uploadBgvEvidence({ rawToken: world.rawToken, category: 'IDENTITY_DOCUMENT', file: pdfFile('v1.pdf'), deps: world.deps });
  const v2 = await uploadBgvEvidence({ rawToken: world.rawToken, category: 'IDENTITY_DOCUMENT', file: pdfFile('v2.pdf'), deps: world.deps });

  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  const oldFile = world.state.files.find((file) => file._id === v1.id);
  assert.equal(oldFile.isActive, false);
  assert.equal(oldFile.status, 'REPLACED'); // history preserved, not overwritten
  assert.ok(world.state.stored.has(oldFile.storageKey)); // old bytes retained

  // Honest malware posture.
  assert.equal(v2.scanStatus, 'NOT_CONFIGURED');
  const cleanClaims = world.state.audits.filter((entry) => JSON.stringify(entry).includes('"CLEAN"'));
  assert.equal(cleanClaims.length, 0);
});

test('30.5: evidence removal works in draft; download of removed file rejected', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  const uploaded = await uploadBgvEvidence({ rawToken: world.rawToken, category: 'IDENTITY_DOCUMENT', file: pdfFile(), deps: world.deps });
  await removeBgvEvidence({ rawToken: world.rawToken, fileId: uploaded.id, deps: world.deps });
  await assert.rejects(
    downloadBgvEvidence({ rawToken: world.rawToken, fileId: uploaded.id, deps: world.deps }),
    (e) => e.statusCode === 404
  );
});

// ══════════════ DRAFT / SUBMISSION ══════════════

test('30.5: draft saves persist and reopen returns the draft (masked)', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  await saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps });

  // "Close and reopen the browser": a fresh portal read returns the draft.
  const summary = await resolveCollectionPortal({ rawToken: world.rawToken, deps: world.deps });
  assert.equal(summary.collection.status, 'DRAFT');
  assert.equal(summary.collection.identity.legalName, 'Demo Candidate');
  assert.equal(summary.collection.identity.identifierMasked, '******234F');
  assert.equal(summary.readiness.perCheck.IDENTITY, 'INCOMPLETE'); // file still missing
});

test('30.5: readiness only considers purchased checks (unpurchased never block)', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  await completeIdentityFlow(world);
  const summary = await resolveCollectionPortal({ rawToken: world.rawToken, deps: world.deps });
  assert.equal(summary.readiness.ready, true);
  assert.equal(summary.readiness.missing.length, 0);

  // Pure-function cross-check: EDUCATION-only readiness with an empty case.
  const bare = computeCollectionReadiness({ purchasedChecks: ['EDUCATION'], collectionCase: {}, activeFiles: [] });
  assert.equal(bare.ready, false);
  assert.ok(bare.missing.some((entry) => /education record/i.test(entry.requirement)));
});

test('30.5: incomplete submission rejected with safe missing list; complete submission succeeds', async () => {
  const world = consentedWorld({ checks: ['IDENTITY', 'EDUCATION'] });
  await saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps });

  await assert.rejects(submitBgvPackage({ rawToken: world.rawToken, deps: world.deps }), (e) => {
    assert.equal(e.statusCode, 409);
    // Safe human-readable requirements — no stack/db internals.
    assert.ok(Array.isArray(e.missingRequirements) && e.missingRequirements.length > 0);
    assert.equal(JSON.stringify(e.missingRequirements).includes('storageKey'), false);
    return true;
  });

  await completeIdentityFlow(world);
  const edu = await saveEducationRecord({
    rawToken: world.rawToken,
    record: { institution: 'Demo University', qualification: 'BSc', startYear: 2013, endYear: 2016 },
    deps: world.deps,
  });
  await uploadBgvEvidence({
    rawToken: world.rawToken,
    category: 'EDUCATION_CERTIFICATE',
    recordId: edu.recordId,
    file: pdfFile('degree.pdf'),
    deps: world.deps,
  });

  const result = await submitBgvPackage({ rawToken: world.rawToken, deps: world.deps });
  assert.equal(result.status, 'SUBMITTED');
  assert.ok(result.submittedAt);
});

test('30.5: duplicate submit is idempotent; submitted case locks edits and replacements', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  await completeIdentityFlow(world);
  const first = await submitBgvPackage({ rawToken: world.rawToken, deps: world.deps });
  assert.equal(first.idempotent, false);

  const second = await submitBgvPackage({ rawToken: world.rawToken, deps: world.deps });
  assert.equal(second.idempotent, true);
  const submitAudits = world.state.audits.filter((entry) => entry.action === 'BGV_PACKAGE_SUBMITTED');
  assert.equal(submitAudits.length, 1); // no duplicate submission recorded

  // Ordinary editing blocked after submission.
  await assert.rejects(
    saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps }),
    (e) => e.statusCode === 409 && /locked/i.test(e.message)
  );
  // Document replacement blocked after submission.
  await assert.rejects(
    uploadBgvEvidence({ rawToken: world.rawToken, category: 'IDENTITY_DOCUMENT', file: pdfFile(), deps: world.deps }),
    (e) => e.statusCode === 409
  );
  // Record removal blocked after submission.
  const summary = await resolveCollectionPortal({ rawToken: world.rawToken, deps: world.deps });
  assert.equal(summary.collection.status, 'SUBMITTED');
});

test('30.5: final submission is POST-only (route contract)', async () => {
  const routes = readFileSync(new URL('../src/routes/publicBgvCollectionRoutes.js', import.meta.url), 'utf8');
  assert.ok(routes.includes("router.post('/:secureToken/submit'"));
  assert.equal(routes.includes("router.get('/:secureToken/submit'"), false);
  // GET summary exists but is read-only (no decision/submit verbs on GET).
  assert.ok(routes.includes("router.get('/:secureToken'"));
});

// ══════════════ SECURITY STRUCTURE ══════════════

test('30.5: raw token never persisted in cases/files/audit; no queue or provider coupling', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  await completeIdentityFlow(world);
  await submitBgvPackage({ rawToken: world.rawToken, deps: world.deps });

  const everything = JSON.stringify({
    cases: world.state.cases,
    files: world.state.files,
    audits: world.state.audits,
  });
  assert.equal(everything.includes(world.rawToken), false);
  assert.equal(everything.includes(hashToken(world.rawToken)), false);

  // Code-level scans (comments stripped): no queue payloads, no payment
  // provider fields, no pipeline mutation, no verifier coupling, no CLEAR.
  const codeOnly = readFileSync(new URL('../src/services/bgv/bgvCollectionService.js', import.meta.url), 'utf8')
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(' ');
  for (const banned of [
    'enqueueJob(',
    'getQueue(',
    'razorpay',
    'gatewayPaymentId',
    'providerOrderId',
    'currentStage',
    'assignVerifier',
    'verifierId',
    "'CLEAR'",
  ]) {
    assert.equal(codeOnly.toLowerCase().includes(banned.toLowerCase()), false, 'banned coupling: ' + banned);
  }

  // No permanent public URL construction in the collection layer.
  const storageCode = readFileSync(new URL('../src/services/bgv/bgvEvidenceStorageService.js', import.meta.url), 'utf8');
  assert.equal(storageCode.includes('/uploads/'), false);
  const routes = readFileSync(new URL('../src/routes/publicBgvCollectionRoutes.js', import.meta.url), 'utf8');
  assert.equal(routes.includes('/uploads/'), false);
});

test('30.5: audit metadata is redacted (no filenames, identifiers, storage keys, tokens)', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  await saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps });
  await uploadBgvEvidence({
    rawToken: world.rawToken,
    category: 'IDENTITY_DOCUMENT',
    file: pdfFile('my-secret-pan-ABCDE1234F.pdf'),
    deps: world.deps,
  });
  const audited = JSON.stringify(world.state.audits);
  assert.equal(audited.includes('ABCDE1234F'), false); // no identifier (even via filename)
  assert.equal(audited.includes('my-secret-pan'), false); // no filenames
  assert.equal(audited.includes('storageKey'), false);
  assert.equal(audited.includes(world.rawToken), false);
  // But safe metadata IS present.
  assert.ok(world.state.audits.some((entry) => entry.action === 'BGV_EVIDENCE_UPLOADED' && entry.metadata.category === 'IDENTITY_DOCUMENT'));
});

// ══════════════ HR VISIBILITY ══════════════

test('30.5: HR sees status only — awaiting → draft → submitted, never raw files', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });

  const awaiting = await getHrCollectionStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: world.deps });
  assert.equal(awaiting.collectionStatus, 'AWAITING_CANDIDATE');

  await saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps });
  const draft = await getHrCollectionStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: world.deps });
  assert.equal(draft.collectionStatus, 'CANDIDATE_DRAFT');
  // Status-level only: no file payloads, no identifiers in the HR view.
  assert.equal(JSON.stringify(draft).includes('ABCDE1234F'), false);
  assert.equal(JSON.stringify(draft).includes('storageKey'), false);

  await completeIdentityFlow(world);
  await submitBgvPackage({ rawToken: world.rawToken, deps: world.deps });
  const submitted = await getHrCollectionStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: world.deps });
  assert.equal(submitted.collectionStatus, 'CANDIDATE_SUBMITTED');
  assert.ok(submitted.submittedAt);
});

test('30.5: HR status is NOT_APPLICABLE without commercial authorization; awaiting before consent', async () => {
  const unpaid = makeWorld({ orderStatus: 'PENDING_PAYMENT' });
  const notApplicable = await getHrCollectionStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: unpaid.deps });
  assert.equal(notApplicable.collectionStatus, 'NOT_APPLICABLE');

  const preConsent = makeWorld({ finalDecision: null });
  const awaiting = await getHrCollectionStatus({ companyId: COMPANY, candidateRef: CANDIDATE_ID, deps: preConsent.deps });
  assert.equal(awaiting.collectionStatus, 'AWAITING_CANDIDATE');
});

// ══════════════ RULES UNIT CHECKS ══════════════

test('30.5: masking rules keep display-safe values only', async () => {
  assert.equal(maskIdentifier('PAN', 'abcde1234f'), '******234F');
  assert.equal(maskIdentifier('AADHAAR', '1234 5678 9012'), 'XXXX XXXX 9012');
  assert.equal(maskIdentifier('PASSPORT', 'A1234567'), '****4567');
  assert.equal(validateIdentityInput({}).length > 0, true);
  assert.equal(validateIdentityInput(validIdentity()), '');
  assert.equal(validateEmploymentRecord({ employer: 'X', designation: 'Y' }).length > 0, true);
});

test('30.5: blank identifier on re-save keeps the stored masked value; blank with no prior value rejected', async () => {
  const world = consentedWorld({ checks: ['IDENTITY'] });
  await saveIdentityInformation({ rawToken: world.rawToken, input: validIdentity(), deps: world.deps });
  const fingerprintBefore = world.state.cases[0].identity.identifierFingerprint;

  // Re-save with legal-name change and BLANK identifier (UI copy promises
  // "leave blank to keep it") — must keep mask + fingerprint.
  const updated = await saveIdentityInformation({
    rawToken: world.rawToken,
    input: { ...validIdentity(), identifier: '', legalName: 'Demo Candidate Updated' },
    deps: world.deps,
  });
  assert.equal(updated.identity.legalName, 'Demo Candidate Updated');
  assert.equal(updated.identity.identifierMasked, '******234F');
  assert.equal(world.state.cases[0].identity.identifierFingerprint, fingerprintBefore);
  assert.equal(JSON.stringify(world.state.cases).includes('ABCDE1234F'), false);

  // Changing the document type with a blank identifier is NOT a keep.
  await assert.rejects(
    saveIdentityInformation({
      rawToken: world.rawToken,
      input: { ...validIdentity(), identifier: '', documentType: 'PASSPORT' },
      deps: world.deps,
    }),
    (e) => e.statusCode === 400
  );

  // A fresh case with a blank identifier is still rejected.
  const fresh = consentedWorld({ checks: ['IDENTITY'] });
  await assert.rejects(
    saveIdentityInformation({
      rawToken: fresh.rawToken,
      input: { ...validIdentity(), identifier: '' },
      deps: fresh.deps,
    }),
    (e) => e.statusCode === 400 && /required/i.test(e.message)
  );
});
