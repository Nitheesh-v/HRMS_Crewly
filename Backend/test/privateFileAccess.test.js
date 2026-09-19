// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.8 — PRIVATE FILE ACCESS (adapter + delivery resolver + policies)
//
// Hermetic coverage for the new 32.8 pieces:
//   · infrastructure/storage/privateCloudinaryAsset — provider mechanics
//     with an INJECTED Cloudinary double (never the real provider):
//     authenticated type, overwrite:false, bounded signed-URL TTL,
//     best-effort destroy.
//   · services/privateFileDelivery — SIGNED_URL / REDIRECT / INLINE / 404
//     branching and legacy-row adaptation.
//   · middlewares/documentFilePolicy — extension+MIME cross-check matrix.
//   · §63 authorization predicates (documents, expense receipts) —
//     cross-tenant and cross-employee refusal, ownership and HR allowance.
// ─────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/privfile-access';

const adapter = await import('../src/infrastructure/storage/privateCloudinaryAsset.js');
const delivery = await import('../src/services/privateFileDelivery.js');
const policy = await import('../src/middlewares/documentFilePolicy.js');
const documentController = await import('../src/controllers/documentController.js');
const expenseController = await import('../src/controllers/expenseController.js');

// ── a tiny Cloudinary double that RECORDS its options ─────────────────
const makeCloudinaryDouble = ({ fail = false } = {}) => {
  const calls = { uploads: [], destroys: [], signedUrls: [] };

  return {
    calls,
    uploader: {
      upload_stream: (options, callback) => ({
        end: (buffer) => {
          calls.uploads.push({ ...options, bytes: buffer.length });
          if (fail) return callback(new Error('provider down'));
          return callback(null, { public_id: options.public_id, secure_url: `https://res.example.com/${options.public_id}` });
        },
      }),
      destroy: async (publicId, options) => {
        calls.destroys.push({ publicId, ...options });
        return { result: 'ok' };
      },
    },
    utils: {
      private_download_url: (publicId, _suffix, options) => {
        calls.signedUrls.push({ publicId, ...options });
        return `https://res.example.com/private/${encodeURIComponent(publicId)}?exp=${options.expires_at}`;
      },
    },
  };
};

describe('privateCloudinaryAsset adapter (injected provider)', () => {
  test('upload is AUTHENTICATED, non-overwriting, and returns the key', async () => {
    const double = makeCloudinaryDouble();
    const result = await adapter.uploadPrivateAsset({
      buffer: Buffer.from('private-bytes'),
      storageKey: 'crewly-private-documents/company-x/uuid-1',
      resourceType: 'raw',
      _cloudinary: double,
      _ready: true,
    });

    assert.equal(result.storageProvider, 'CLOUDINARY_AUTHENTICATED');
    assert.equal(result.storageKey, 'crewly-private-documents/company-x/uuid-1');
    assert.equal(double.calls.uploads.length, 1);

    const upload = double.calls.uploads[0];
    assert.equal(upload.type, 'authenticated', 'object must have NO permanent public URL');
    assert.equal(upload.overwrite, false, 'fresh uuid keys are never overwritten');
    assert.equal(upload.use_filename, false, 'original filenames never become storage paths');
    assert.equal(upload.resource_type, 'raw');
  });

  test('provider outage → loud 503 (DB is never told a file exists)', async () => {
    const double = makeCloudinaryDouble({ fail: true });
    await assert.rejects(
      () =>
        adapter.uploadPrivateAsset({
          buffer: Buffer.from('x'),
          storageKey: 'k',
          _cloudinary: double,
          _ready: true,
        }),
      (error) => `${error.status || error.statusCode}` === '503'
    );
    assert.equal(double.calls.uploads.length, 1, 'the attempt happened (and failed)');
  });

  test('signed URL is bounded (≤ 5 min) and carries the attachment flag', () => {
    const double = makeCloudinaryDouble();
    const { url, expiresAt } = adapter.getPrivateAssetSignedUrl({
      storageKey: 'crewly-private-expense-receipts/company-x/uuid-2',
      resourceType: 'image',
      attachment: true,
      ttlSeconds: 60 * 60 * 24, // attacker-ish oversized ask
      _cloudinary: double,
      _ready: true,
    });

    assert.ok(url.includes('res.example.com'), 'url built by the provider util');
    assert.ok(expiresAt - Math.floor(Date.now() / 1000) <= 5 * 60, 'TTL clamped to ≤ 300 s');
    assert.equal(double.calls.signedUrls[0].attachment, true);
    assert.equal(double.calls.signedUrls[0].type, 'authenticated');
  });

  test('destroy is best-effort: provider errors never propagate', async () => {
    const double = makeCloudinaryDouble();
    double.uploader.destroy = async () => {
      throw new Error('delete failed');
    };

    await adapter.destroyPrivateAsset({ storageKey: 'k', resourceType: 'raw', _cloudinary: double, _ready: true });
    await adapter.destroyPrivateAsset({ storageKey: '', _cloudinary: double, _ready: true }); // no-op
  });
});

describe('privateFileDelivery resolver', () => {
  const signedResolver = ({ storageKey }) => ({ url: `https://signed/${storageKey}`, expiresAt: 123 });

  test('private row → bounded signed URL, issued only via this resolver', () => {
    const out = delivery.resolvePrivateFileDelivery({
      storageProvider: 'CLOUDINARY_AUTHENTICATED',
      storageKey: 'k-1',
      signedUrlResolver: signedResolver,
    });

    assert.deepEqual(out, { kind: 'SIGNED_URL', url: 'https://signed/k-1', expiresAt: 123, storageKey: 'k-1' });
  });

  test('legacy public row → REDIRECT (gated), inline row → decoded bytes', () => {
    const legacy = delivery.resolvePrivateFileDelivery({
      storageProvider: 'LEGACY_PUBLIC_URL',
      legacyUrl: 'https://res.example.com/old-public',
    });

    assert.equal(legacy.kind, 'REDIRECT');

    const inline = delivery.resolvePrivateFileDelivery({
      storageProvider: 'INLINE_DEV_FALLBACK',
      dataUri: 'data:application/pdf;base64,' + Buffer.from('pdf-bytes').toString('base64'),
    });

    assert.equal(inline.kind, 'INLINE');
    assert.equal(inline.contentType, 'application/pdf');
    assert.equal(inline.bytes.toString(), 'pdf-bytes');
  });

  test('missing / mismatched references are 404 — never guesses', () => {
    assert.throws(
      () => delivery.resolvePrivateFileDelivery({ storageProvider: 'CLOUDINARY_AUTHENTICATED', storageKey: '', signedUrlResolver: signedResolver }),
      (error) => `${error.status || error.statusCode}` === '404'
    );
    assert.throws(
      () => delivery.resolvePrivateFileDelivery({ storageProvider: 'MYSTERY_PROVIDER', storageKey: 'k' }),
      (error) => `${error.status || error.statusCode}` === '404'
    );
    assert.throws(
      () => delivery.resolvePrivateFileDelivery({ storageProvider: 'CLOUDINARY_AUTHENTICATED', storageKey: 'k' }),
      (error) => `${error.status || error.statusCode}` === '503',
      'no resolver wired → storage unavailable, never a silent leak'
    );
  });

  test('legacy row adaptation (documents / expenses / task attachments)', () => {
    // 32.8 private row on an expense (renamed fields)
    assert.deepEqual(
      delivery.legacyRowDeliveryInput(
        { receiptStorageProvider: 'CLOUDINARY_AUTHENTICATED', receiptStorageKey: 'rk' },
        { legacyUrlField: 'receiptUrl', providerField: 'receiptStorageProvider', keyField: 'receiptStorageKey' }
      ),
      { storageProvider: 'CLOUDINARY_AUTHENTICATED', storageKey: 'rk', legacyUrl: '', dataUri: '' }
    );

    // pre-32.8 inline dev row (data: URI inside the legacy URL field)
    assert.equal(
      delivery.legacyRowDeliveryInput({ fileUrl: 'data:image/png;base64,AAA' }).storageProvider,
      'INLINE_DEV_FALLBACK'
    );

    // pre-32.8 public row
    assert.deepEqual(
      delivery.legacyRowDeliveryInput({ fileUrl: 'https://res.example.com/old' }),
      { storageProvider: 'LEGACY_PUBLIC_URL', storageKey: '', legacyUrl: 'https://res.example.com/old', dataUri: '' }
    );
  });

  test('classifyUploadedAsset: production NEVER silently inlines a failure', () => {
    const file = { buffer: Buffer.from('b'), mimetype: 'application/pdf' };

    assert.equal(delivery.classifyUploadedAsset({ cloudResult: { storageKey: 'k' }, file }).storageProvider, 'CLOUDINARY_AUTHENTICATED');

    const dev = delivery.classifyUploadedAsset({ cloudResult: null, file, allowInlineFallback: true });
    assert.equal(dev.storageProvider, 'INLINE_DEV_FALLBACK');
    assert.ok(dev.dataUri.startsWith('data:application/pdf;base64,'));

    assert.throws(
      () => delivery.classifyUploadedAsset({ cloudResult: null, file, allowInlineFallback: false }),
      (error) => `${error.status || error.statusCode}` === '503'
    );
  });
});

describe('documentFilePolicy (extension + MIME cross-check)', () => {
  const runFilter = (name, mimetype) =>
    new Promise((resolve) => {
      policy.documentFileFilter(
        {},
        { originalname: name, mimetype },
        (error, accepted) => resolve({ accepted, error })
      );
    });

  test('valid pdf and images pass', async () => {
    assert.deepEqual(await runFilter('doc.pdf', 'application/pdf'), { accepted: true, error: null });
    assert.deepEqual(await runFilter('scan.jpg', 'image/jpeg'), { accepted: true, error: null });
    assert.deepEqual(await runFilter('shot.PNG', 'image/png'), { accepted: true, error: null });
  });

  test('mismatched or disallowed types are refused (multer cb contract: error, no accept)', async () => {
    for (const [name, mimetype] of [
      ['evil.exe', 'application/pdf'],
      ['doc.pdf', 'application/zip'], // MIME lie
      ['archive.zip', 'application/zip'],
      ['noext', 'application/pdf'],
    ]) {
      const result = await runFilter(name, mimetype);
      assert.notEqual(result.error, null, `must refuse ${name}/${mimetype}`);
      assert.notEqual(result.accepted, true);
      assert.equal(result.error.message, policy.DOCUMENT_FILE_POLICY_MESSAGE);
    }
  });

  test('a traversal-looking DISPLAY name never influences storage safety (§62)', async () => {
    // Display names are never used as filesystem/provider paths (uuid keys
    // only); the policy judges type alone.
    assert.deepEqual(await runFilter('../../../../etc/evil.pdf', 'application/pdf'), { accepted: true, error: null });
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §63 — TENANT / OWNERSHIP AUTHORIZATION PREDICATES
// ═══════════════════════════════════════════════════════════════════

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const EMPLOYEE_A1 = 'cccccccccccccccccccccccc';
const EMPLOYEE_A2 = 'dddddddddddddddddddddddd';

describe('§63 canViewDocumentFile (owner-or-HR, tenant-safe)', () => {
  const doc = { companyId: COMPANY_A, user: EMPLOYEE_A1 };

  test('owner can fetch', () => {
    assert.equal(documentController.canViewDocumentFile({ _id: EMPLOYEE_A1, companyId: COMPANY_A, role: 'EMPLOYEE' }, doc), true);
  });

  test('same-company HR can fetch', () => {
    assert.equal(documentController.canViewDocumentFile({ _id: EMPLOYEE_A2, companyId: COMPANY_A, role: 'HR_MANAGER' }, doc), true);
    assert.equal(documentController.canViewDocumentFile({ _id: EMPLOYEE_A2, companyId: COMPANY_A, role: 'COMPANY_ADMIN' }, doc), true);
  });

  test('another employee of the same company CANNOT fetch', () => {
    assert.equal(documentController.canViewDocumentFile({ _id: EMPLOYEE_A2, companyId: COMPANY_A, role: 'EMPLOYEE' }, doc), false);
  });

  test('cross-tenant HR CANNOT fetch (Company B HR vs Company A file)', () => {
    assert.equal(documentController.canViewDocumentFile({ _id: EMPLOYEE_A2, companyId: COMPANY_B, role: 'HR_MANAGER' }, doc), false);
  });

  test('unknown file / anonymous actor → false', () => {
    assert.equal(documentController.canViewDocumentFile({ _id: EMPLOYEE_A1, companyId: COMPANY_A }, null), false);
    assert.equal(documentController.canViewDocumentFile(null, doc), false);
  });
});

describe('§63 canViewExpenseReceipt (owner-or-HR/Finance, tenant-safe)', () => {
  const expense = { companyId: COMPANY_A, user: EMPLOYEE_A1 };

  test('owner can fetch their receipt', () => {
    assert.equal(expenseController.canViewExpenseReceipt({ _id: EMPLOYEE_A1, companyId: COMPANY_A, role: 'EMPLOYEE' }, expense), true);
  });

  test('same-company HR/Finance can fetch', () => {
    assert.equal(expenseController.canViewExpenseReceipt({ _id: EMPLOYEE_A2, companyId: COMPANY_A, role: 'HR_MANAGER' }, expense), true);
  });

  test('peer employee CANNOT fetch', () => {
    assert.equal(expenseController.canViewExpenseReceipt({ _id: EMPLOYEE_A2, companyId: COMPANY_A, role: 'EMPLOYEE' }, expense), false);
  });

  test('cross-tenant finance CANNOT fetch', () => {
    assert.equal(expenseController.canViewExpenseReceipt({ _id: EMPLOYEE_A2, companyId: COMPANY_B, role: 'HR_MANAGER' }, expense), false);
  });
});
