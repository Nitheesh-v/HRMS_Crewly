import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import PDFDocument from 'pdfkit';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
process.env.PRIVATE_RESUME_STORAGE_DIR = path.resolve(
  'private_storage/test-resume-parsing'
);

const [
  { default: AuditLog },
  { default: Candidate },
  { default: CandidateHistory },
  { default: CandidateResume },
  { default: ResumeParseResult },
  extractionService,
  parserService,
  normalizationService,
  processingService,
  inboxService,
  dispatcher,
  atsDispatcher,
  permissionRegistry,
] = await Promise.all([
  import('../src/models/AuditLog.js'),
  import('../src/models/Candidate.js'),
  import('../src/models/CandidateHistory.js'),
  import('../src/models/CandidateResume.js'),
  import('../src/models/ResumeParseResult.js'),
  import('../src/services/resumeTextExtractionService.js'),
  import('../src/services/resumeDeterministicParser.js'),
  import('../src/services/resumeNormalizationService.js'),
  import('../src/services/resumeProcessingService.js'),
  import('../src/services/candidateInboxService.js'),
  import('../src/services/resumeProcessingDispatcher.js'),
  import('../src/services/atsDispatcher.js'),
  import('../src/utils/permissionRegistry.js'),
]);

const COMPANY_ID = '64b000000000000000000101';
const OTHER_COMPANY_ID = '64b000000000000000000102';
const CANDIDATE_ID = '64b000000000000000000103';
const RESUME_ID = '64b000000000000000000104';
const JOB_ID = '64b000000000000000000105';
const USER_ID = '64b000000000000000000106';
const PARSE_RESULT_ID = '64b000000000000000000107';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const restorable = (...entries) => {
  const originals = entries.map(([target, method]) => [
    target,
    method,
    target[method],
  ]);

  return () => {
    originals.forEach(([target, method, original]) => {
      target[method] = original;
    });
  };
};

const leanQuery = (value) => ({
  select() {
    return this;
  },
  sort() {
    return this;
  },
  limit() {
    return this;
  },
  lean() {
    return Promise.resolve(value);
  },
});

const createPdf = async ({ text = '', vectorOnly = false } = {}) => {
  const document = new PDFDocument({ autoFirstPage: false, compress: false });
  const output = new PassThrough();
  const chunks = [];

  output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  document.pipe(output);
  document.addPage();

  if (vectorOnly) {
    document.rect(50, 50, 250, 100).stroke();
  } else {
    document.fontSize(12).text(text, 50, 50, { width: 500 });
  }

  const completed = new Promise((resolve, reject) => {
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
  });
  document.end();
  return completed;
};

const crcTable = Array.from({ length: 256 }, (_, number) => {
  let value = number;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;

  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const createStoredZip = (files) => {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  Object.entries(files).forEach(([name, content]) => {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  const entryCount = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
};

const createDocx = (paragraphs) => {
  const paragraphXml = paragraphs
    .map(
      (paragraph) =>
        `<w:p><w:r><w:t xml:space="preserve">${paragraph
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')}</w:t></w:r></w:p>`
    )
    .join('');

  return createStoredZip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphXml}<w:sectPr/></w:body></w:document>`,
  });
};

const resumeText = [
  'Ada Lovelace',
  'ada@example.com | +91 98765 43210',
  'SUMMARY',
  'Platform engineer focused on reliable distributed systems.',
  'SKILLS',
  'Node.js, TypeScript, MongoDB, C++, C#',
  'WORK EXPERIENCE',
  'Senior Engineer at Analytical Engines',
  'January 2022 - Present',
  'Built secure multi-tenant services.',
  'Engineer | Difference Labs',
  'June 2020 - December 2022',
  'Developed deterministic processing tools.',
  'EDUCATION',
  'Bachelor of Science in Computing',
  'University of London',
  '2016 - 2020',
  'CERTIFICATIONS',
  'Cloud Architecture Certificate',
  'PROJECTS',
  'Resume Safety Pipeline',
  'A bounded document extraction service.',
  'LANGUAGES',
  'English - Fluent, Tamil - Conversational',
  'AWARDS',
  'Engineering Excellence Award',
  'LINKS',
  'https://github.com/ada',
].join('\n');

test('valid text PDF and DOCX extraction is bounded and deterministic', async () => {
  const pdf = await extractionService.extractResumeText({
    buffer: await createPdf({ text: resumeText }),
    mimeType: 'application/pdf',
  });
  const docx = await extractionService.extractResumeText({
    buffer: createDocx(resumeText.split('\n')),
    mimeType: DOCX_MIME,
  });

  assert.match(pdf.rawText, /Ada Lovelace/);
  assert.match(docx.rawText, /TypeScript/);
  assert.equal(pdf.reviewRequired, false);
  assert.equal(docx.reviewRequired, false);
  assert.ok(pdf.rawText.length <= 250000);
  assert.ok(docx.rawText.length <= 250000);
  assert.equal(pdf.extractorVersion, 'pdf-parse-2.4.5');
  assert.equal(docx.extractorVersion, 'mammoth-1.12.1');
});

test('scanned PDF becomes review-required and corrupt/password-like archives fail safely', async () => {
  const scanned = await extractionService.extractResumeText({
    buffer: await createPdf({ vectorOnly: true }),
    mimeType: 'application/pdf',
  });

  assert.equal(scanned.reviewRequired, true);
  assert.equal(scanned.confidence <= 0.25, true);
  assert.equal(scanned.warnings.length, 1);

  await assert.rejects(
    extractionService.extractResumeText({
      buffer: Buffer.from('%PDF-1.7\nnot a complete pdf'),
      mimeType: 'application/pdf',
    }),
    (error) =>
      ['CORRUPT_FILE', 'EXTRACTION_FAILED'].includes(error.category) &&
      !String(error.safeMessage).includes('/home/')
  );

  const encryptedDocx = Buffer.from(createDocx(['Encrypted resume text']));
  const centralOffset = encryptedDocx.indexOf(
    Buffer.from([0x50, 0x4b, 0x01, 0x02])
  );
  encryptedDocx.writeUInt16LE(1, centralOffset + 8);

  await assert.rejects(
    extractionService.extractResumeText({
      buffer: encryptedDocx,
      mimeType: DOCX_MIME,
    }),
    (error) => error.category === 'PASSWORD_PROTECTED'
  );

  const activeDocx = createDocx(['Safe text']);
  const activeName = Buffer.from('word/vbaProject.bin');
  assert.equal(activeDocx.includes(activeName), false);

  const blockedArchive = createStoredZip({
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    'word/document.xml': '<document/>',
    'word/vbaProject.bin': 'macro bytes',
  });

  await assert.rejects(
    extractionService.extractResumeText({
      buffer: blockedArchive,
      mimeType: DOCX_MIME,
    }),
    (error) => error.category === 'UNSUPPORTED_FORMAT'
  );
});

test('deterministic parser extracts structured sections without ATS or fabricated fields', () => {
  const result = parserService.parseResumeDeterministically({
    rawText: resumeText,
    extraction: { confidence: 0.98, truncated: false },
  });

  assert.equal(parserService.RESUME_PARSER_VERSION, 'deterministic-1.0.0');
  assert.equal(result.structuredData.identity.name, 'Ada Lovelace');
  assert.equal(result.structuredData.identity.email, 'ada@example.com');
  assert.deepEqual(
    result.structuredData.skills.map((skill) => skill.display),
    ['Node.js', 'TypeScript', 'MongoDB', 'C++', 'C#']
  );
  assert.equal(result.structuredData.workExperience.length, 2);
  assert.equal(result.structuredData.education.length, 1);
  assert.equal(result.structuredData.certifications.length, 1);
  assert.equal(result.structuredData.projects.length, 1);
  assert.equal(result.structuredData.languages.length, 2);
  assert.equal(result.structuredData.awards.length, 1);
  assert.equal('atsScore' in result, false);
  assert.equal('ranking' in result, false);
  assert.equal(result.extractionConfidence.overall <= 1, true);
});

test('normalization preserves display values, separates technologies and merges overlapping employment', () => {
  const skills = normalizationService.normalizeSkills([
    'Node.js',
    'nodejs',
    'C',
    'C++',
    'C#',
  ]);
  const workExperience = [
    {
      startDate: normalizationService.normalizeResumeDate('January 2020'),
      endDate: normalizationService.normalizeResumeDate('December 2022', {
        endDate: true,
      }),
    },
    {
      startDate: normalizationService.normalizeResumeDate('June 2022'),
      endDate: normalizationService.normalizeResumeDate('June 2024', {
        endDate: true,
      }),
    },
  ];

  assert.deepEqual(
    skills.map((skill) => skill.display),
    ['Node.js', 'C', 'C++', 'C#']
  );
  assert.equal(normalizationService.deriveExperienceMonths(workExperience), 54);
  assert.equal(
    normalizationService.normalizeResumeDate('Spring 2023').normalized,
    null
  );
  assert.equal(
    normalizationService.normalizeResumeDate('2023').uncertain,
    true
  );
});

test('processing service persists completed state and never mutates Candidate data', async () => {
  const restore = restorable(
    [CandidateResume, 'findOneAndUpdate'],
    [CandidateResume, 'updateOne'],
    [ResumeParseResult, 'findOneAndUpdate'],
    [ResumeParseResult, 'updateOne'],
    [CandidateHistory, 'create'],
    [AuditLog, 'create'],
    [Candidate, 'updateOne']
  );
  const storageKey = 'processing-test.pdf';
  const directory = process.env.PRIVATE_RESUME_STORAGE_DIR;
  const resumeUpdates = [];
  const resultUpdates = [];
  const history = [];
  let candidateMutationAttempted = false;

  try {
    await mkdir(directory, { recursive: true });
    const pdf = await createPdf({ text: resumeText });
    await writeFile(path.join(directory, storageKey), pdf);

    CandidateResume.findOneAndUpdate = (_filter, update) =>
      leanQuery({
        _id: RESUME_ID,
        companyId: COMPANY_ID,
        candidate: CANDIDATE_ID,
        job: JOB_ID,
        storageProvider: 'LOCAL_PRIVATE',
        storageKey,
        mimeType: 'application/pdf',
        fileSize: pdf.length,
        status: 'UPLOADED',
        parsingStatus: 'PROCESSING',
        parsingAttempts: 1,
        parsingRequestedAt: new Date(),
        processingLeaseId: update.$set.processingLeaseId,
        processingLeaseExpiresAt: update.$set.processingLeaseExpiresAt,
      });
    CandidateResume.updateOne = async (filter, update) => {
      resumeUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    };
    ResumeParseResult.findOneAndUpdate = async () => ({
      _id: PARSE_RESULT_ID,
    });
    ResumeParseResult.updateOne = async (filter, update) => {
      resultUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    };
    CandidateHistory.create = async (payload) => {
      history.push(payload);
      return payload;
    };
    AuditLog.create = async (payload) => payload;
    Candidate.updateOne = async () => {
      candidateMutationAttempted = true;
    };

    const atsQueuedBefore = atsDispatcher.atsDispatcherState().queued;
    const processed = await processingService.processResumeJob({
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      resumeId: RESUME_ID,
    });

    assert.equal(processed.status, 'COMPLETED');
    assert.equal(
      atsDispatcher.atsDispatcherState().queued - atsQueuedBefore,
      1
    );
    assert.equal(candidateMutationAttempted, false);
    assert.equal(
      resumeUpdates.some(
        ({ update }) => update.$set?.parsingStatus === 'COMPLETED'
      ),
      true
    );
    const completed = resultUpdates.find(
      ({ update }) => update.$set?.status === 'COMPLETED'
    );
    assert.ok(completed);
    assert.match(completed.update.$set.rawText, /Ada Lovelace/);
    assert.equal(completed.update.$set.structuredData.identity.email, 'ada@example.com');
    assert.deepEqual(
      history.map((event) => event.action),
      ['RESUME_PARSE_STARTED', 'RESUME_PARSED']
    );
    assert.equal(JSON.stringify(history).includes(resumeText), false);
  } finally {
    restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test('tenant-scoped reprocess is atomic, attempt-bounded and audited in candidate history', async () => {
  const restore = restorable(
    [Candidate, 'findOne'],
    [CandidateResume, 'findOne'],
    [CandidateResume, 'findOneAndUpdate'],
    [ResumeParseResult, 'updateOne'],
    [CandidateHistory, 'create']
  );
  let candidateFilter;
  let atomicFilter;
  let historyPayload;

  try {
    Candidate.findOne = (filter) => {
      candidateFilter = filter;
      return leanQuery({
        _id: CANDIDATE_ID,
        candidateCode: 'CAN-000103',
        job: JOB_ID,
      });
    };
    CandidateResume.findOne = () =>
      leanQuery({
        _id: RESUME_ID,
        job: JOB_ID,
        parsingStatus: 'COMPLETED',
        parsingAttempts: 1,
        parsingRequestedAt: new Date(Date.now() - 120000),
      });
    CandidateResume.findOneAndUpdate = (filter, update) => {
      atomicFilter = filter;
      return leanQuery({
        _id: RESUME_ID,
        job: JOB_ID,
        parsingStatus: update.$set.parsingStatus,
        parsingAttempts: 1,
        parsingRequestedAt: update.$set.parsingRequestedAt,
      });
    };
    ResumeParseResult.updateOne = async () => ({ modifiedCount: 1 });
    CandidateHistory.create = async (payload) => {
      historyPayload = payload;
      return payload;
    };

    const result = await processingService.requestResumeReprocess({
      companyId: COMPANY_ID,
      candidateRef: 'CAN-000103',
      actorId: USER_ID,
    });

    assert.equal(candidateFilter.companyId, COMPANY_ID);
    assert.equal(atomicFilter.companyId, COMPANY_ID);
    assert.equal(atomicFilter.candidate, CANDIDATE_ID);
    assert.deepEqual(atomicFilter.parsingStatus.$in, [
      'COMPLETED',
      'FAILED',
      'UNSUPPORTED',
      'REVIEW_REQUIRED',
      'PARSED',
    ]);
    assert.equal(result.status, 'RETRY_PENDING');
    assert.equal(historyPayload.action, 'RESUME_REPROCESS_REQUESTED');
    assert.equal(historyPayload.actorType, 'TENANT_USER');
    assert.equal(String(historyPayload.actor), USER_ID);
    assert.equal(JSON.stringify(historyPayload).includes('rawText'), false);

    CandidateResume.findOne = () =>
      leanQuery({
        _id: RESUME_ID,
        parsingStatus: 'PROCESSING',
        parsingAttempts: 2,
        parsingRequestedAt: new Date(Date.now() - 120000),
      });

    await assert.rejects(
      processingService.requestResumeReprocess({
        companyId: COMPANY_ID,
        candidateRef: 'CAN-000103',
        actorId: USER_ID,
      }),
      (error) => error.statusCode === 409
    );
  } finally {
    restore();
  }
});

test('parsed read denies cross-tenant lookup and raw parser text is private by schema', async () => {
  const restore = restorable([Candidate, 'findOne']);
  let capturedFilter;

  try {
    Candidate.findOne = (filter) => {
      capturedFilter = filter;
      return leanQuery(null);
    };

    await assert.rejects(
      inboxService.getCandidateParsedResume({
        companyId: OTHER_COMPANY_ID,
        candidateRef: 'CAN-000103',
      }),
      (error) => error.statusCode === 404
    );

    assert.equal(capturedFilter.companyId, OTHER_COMPANY_ID);
    assert.equal(ResumeParseResult.schema.path('rawText').options.select, false);
    assert.equal(
      ResumeParseResult.schema.path('processingLeaseId').options.select,
      false
    );
    const uniqueIndex = ResumeParseResult.schema
      .indexes()
      .find(
        ([fields]) =>
          fields.companyId === 1 &&
          fields.resume === 1 &&
          fields.parserVersion === 1
      );
    assert.ok(uniqueIndex);
    assert.equal(uniqueIndex[1].unique, true);
  } finally {
    restore();
  }
});

test('authenticated parser routes use exact read/update permissions and public routes expose none', async () => {
  const [recruitmentRoutes, publicRoutes] = await Promise.all([
    readFile(
      new URL('../src/routes/recruitmentRoutes.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../src/routes/publicCareerRoutes.js', import.meta.url),
      'utf8'
    ),
  ]);
  const parsedRoute = recruitmentRoutes.indexOf(
    "'/candidates/:candidateRef/resume/parsed'"
  );
  const reprocessRoute = recruitmentRoutes.indexOf(
    "'/candidates/:candidateRef/resume/reprocess'"
  );

  const readPermission = recruitmentRoutes.indexOf(
    "requirePermission('CANDIDATE_READ')",
    parsedRoute
  );
  const updatePermission = recruitmentRoutes.indexOf(
    "requirePermission('CANDIDATE_UPDATE')",
    reprocessRoute
  );
  const limiter = recruitmentRoutes.indexOf(
    'resumeReprocessRateLimit',
    reprocessRoute
  );

  assert.notEqual(parsedRoute, -1);
  assert.notEqual(reprocessRoute, -1);
  assert.notEqual(readPermission, -1);
  assert.notEqual(updatePermission, -1);
  assert.notEqual(limiter, -1);
  assert.equal(readPermission - parsedRoute < 180, true);
  assert.equal(updatePermission - reprocessRoute < 220, true);
  assert.equal(limiter - reprocessRoute < 300, true);
  assert.equal(publicRoutes.includes('resume/parsed'), false);
  assert.equal(publicRoutes.includes('resume/reprocess'), false);
});

test('dispatcher deduplicates trusted IDs and RBAC reuses candidate permissions', () => {
  const before = dispatcher.resumeProcessingDispatcherState().queued;
  const first = dispatcher.dispatchResumeProcessing({
    companyId: COMPANY_ID,
    candidateId: CANDIDATE_ID,
    resumeId: RESUME_ID,
  });
  const second = dispatcher.dispatchResumeProcessing({
    companyId: COMPANY_ID,
    candidateId: CANDIDATE_ID,
    resumeId: RESUME_ID,
  });
  const after = dispatcher.resumeProcessingDispatcherState().queued;

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(after - before, 1);
  assert.ok(
    permissionRegistry.DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(
      'CANDIDATE_UPDATE'
    )
  );
  assert.ok(
    permissionRegistry.DEFAULT_ROLE_MATRIX.HR_MANAGER.includes(
      'CANDIDATE_UPDATE'
    )
  );

  for (const role of ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE']) {
    assert.equal(
      permissionRegistry.DEFAULT_ROLE_MATRIX[role].includes('CANDIDATE_READ'),
      false
    );
    assert.equal(
      permissionRegistry.DEFAULT_ROLE_MATRIX[role].includes('CANDIDATE_UPDATE'),
      false
    );
  }
});
