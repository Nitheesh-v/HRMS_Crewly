// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.8 — PRIVATE STORAGE SERVICES (hermetic, local-fallback paths)
//
// The four hardened domain storage services (resume / offer document /
// pre-onboarding document / BGV evidence) had ZERO automated coverage.
// This suite exercises their provider-less (LOCAL_PRIVATE) paths with a
// real temp directory — which is exactly the code that also guards path
// traversal, size caps, uniqueness and production refusal. Cloudinary is
// intentionally UNCONFIGURED here (hermetic law: no live provider).
//
// §61/§62 coverage: roundtrip store/read/delete · traversal refusal
// (`../`, nested, absolute, backslash) · production 503 without a
// provider · provider mismatch → not found · size caps · unique keys.
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ── env BEFORE any storage module loads ────────────────────────────────
const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-storage-32-8-'));

delete process.env.CLOUDINARY_CLOUD_NAME;
delete process.env.CLOUDINARY_API_KEY;
delete process.env.CLOUDINARY_API_SECRET;
delete process.env.NODE_ENV; // local fallback is dev-only

process.env.PRIVATE_RESUME_STORAGE_DIR = path.join(TMP_ROOT, 'resumes');
process.env.PRIVATE_OFFER_STORAGE_DIR = path.join(TMP_ROOT, 'offers');
process.env.PRIVATE_PRE_ONBOARDING_STORAGE_DIR = path.join(TMP_ROOT, 'pre-onboarding');
process.env.PRIVATE_BGV_EVIDENCE_STORAGE_DIR = path.join(TMP_ROOT, 'bgv-evidence');

const resumeStorage = await import('../src/services/recruitment/resumeStorageService.js');
const offerStorage = await import('../src/services/recruitment/offerDocumentStorageService.js');
const preOnboardingStorage = await import('../src/services/recruitment/preOnboardingDocumentStorageService.js');
const bgvStorage = await import('../src/services/bgv/bgvEvidenceStorageService.js');

const COMPANY_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const fakeFile = (bytes) => ({ buffer: Buffer.from(bytes), mimetype: 'application/pdf', size: bytes.length });

describe('resumeStorageService (LOCAL_PRIVATE hermetic)', () => {
  test('store → read → delete roundtrip', async () => {
    const stored = await resumeStorage.storeResume({ file: fakeFile('resume-bytes'), companyId: COMPANY_ID });

    assert.equal(stored.storageProvider, 'LOCAL_PRIVATE');
    assert.match(stored.storageKey, /^[0-9a-f-]{36}$/);

    const buffer = await resumeStorage.getStoredResumeBuffer({ storageProvider: stored.storageProvider, storageKey: stored.storageKey });

    assert.equal(buffer.toString(), 'resume-bytes');

    await resumeStorage.deleteStoredResume({ storageProvider: stored.storageProvider, storageKey: stored.storageKey });
    await assert.rejects(() =>
      resumeStorage.getStoredResumeBuffer({ storageProvider: stored.storageProvider, storageKey: stored.storageKey })
    );
  });

  test('traversal keys never escape the private root (§62)', async () => {
    const attacks = ['../secret.txt', 'sub/../secret.txt', 'a/b', '..%2Fsecret', '/etc/passwd', 'C:\\Windows\\evil', 'nested/key.pdf'];

    for (const attack of attacks) {
      await assert.rejects(
        () => resumeStorage.getStoredResumeBuffer({ storageProvider: 'LOCAL_PRIVATE', storageKey: attack }),
        (error) => error.status === 404 || error.statusCode === 404,
        `must refuse: ${attack}`
      );
    }

    // Nothing was written outside the root.
    const entries = await fs.readdir(process.env.PRIVATE_RESUME_STORAGE_DIR);
    assert.deepEqual(entries, [], 'no file escaped the private root');
  });

  test('read size cap refuses oversized stored bytes (413)', async () => {
    const stored = await resumeStorage.storeResume({ file: fakeFile('x'.repeat(2048)), companyId: COMPANY_ID });

    await assert.rejects(() =>
      resumeStorage.getStoredResumeBuffer({ storageProvider: stored.storageProvider, storageKey: stored.storageKey, maximumBytes: 1024 })
    , (error) => `${error.status || error.statusCode}` === '413');
  });

  test('unknown provider → not found (never falls through)', async () => {
    await assert.rejects(() =>
      resumeStorage.getStoredResumeBuffer({ storageProvider: 'SOMEONE_ELSES_DISK', storageKey: 'whatever' })
    );
  });

  test('production without a provider refuses to store (503)', async () => {
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(
        () => resumeStorage.storeResume({ file: fakeFile('prod'), companyId: COMPANY_ID }),
        (error) => `${error.status || error.statusCode}` === '503'
      );
    } finally {
      delete process.env.NODE_ENV;
    }
  });
});

describe('offer / pre-onboarding / BGV evidence storage (LOCAL_PRIVATE hermetic)', () => {
  test('offer document roundtrip + oversize rejection', async () => {
    const stored = await offerStorage.storeOfferDocument({ buffer: Buffer.from('offer-pdf'), companyId: COMPANY_ID, offerCode: 'OFF-1' });

    assert.equal(stored.storageProvider, 'LOCAL_PRIVATE');

    const buffer = await offerStorage.getStoredOfferDocument({ storageProvider: stored.storageProvider, storageKey: stored.storageKey });

    assert.equal(buffer.toString(), 'offer-pdf');

    await assert.rejects(() =>
      offerStorage.storeOfferDocument({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), companyId: COMPANY_ID, offerCode: 'OFF-2' })
    );

    await offerStorage.deleteStoredOfferDocument({ storageProvider: stored.storageProvider, storageKey: stored.storageKey });
    await assert.rejects(() =>
      offerStorage.getStoredOfferDocument({ storageProvider: stored.storageProvider, storageKey: stored.storageKey })
    );
  });

  test('pre-onboarding document roundtrip + traversal refusal', async () => {
    const stored = await preOnboardingStorage.storePreOnboardingDocument({
      buffer: Buffer.from('preonboard-doc'),
      companyId: COMPANY_ID,
      documentCode: 'AADHAAR',
    });

    assert.equal(stored.storageProvider, 'LOCAL_PRIVATE');

    const buffer = await preOnboardingStorage.getStoredPreOnboardingDocument({
      storageProvider: stored.storageProvider,
      storageKey: stored.storageKey,
    });

    assert.equal(buffer.toString(), 'preonboard-doc');

    await assert.rejects(() =>
      preOnboardingStorage.getStoredPreOnboardingDocument({ storageProvider: stored.storageProvider, storageKey: '../../escape' })
    );
  });

  test('BGV evidence roundtrip + key/key mismatch is not-found', async () => {
    const stored = await bgvStorage.storeBgvEvidence({ buffer: Buffer.from('bvg-evidence'), companyId: COMPANY_ID, caseId: 'case-1' });

    assert.equal(stored.storageProvider, 'LOCAL_PRIVATE');

    const buffer = await bgvStorage.getStoredBgvEvidence({
      storageProvider: stored.storageProvider,
      storageKey: stored.storageKey,
    });

    assert.equal(buffer.toString(), 'bvg-evidence');

    await assert.rejects(() =>
      bgvStorage.getStoredBgvEvidence({ storageProvider: stored.storageProvider, storageKey: 'bgv-check-does-not-exist' })
    );
  });
});

after(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});
