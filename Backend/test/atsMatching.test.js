import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  { default: ATSResult },
  { default: AuditLog },
  { default: Candidate },
  { default: CandidateHistory },
  { default: CandidatePipelineHistory },
  { default: CandidateResume },
  { default: JobPosting },
  { default: ResumeParseResult },
  matchingService,
  dispatcher,
  permissionRegistry,
] = await Promise.all([
  import('../src/models/ATSResult.js'),
  import('../src/models/AuditLog.js'),
  import('../src/models/Candidate.js'),
  import('../src/models/CandidateHistory.js'),
  import('../src/models/CandidatePipelineHistory.js'),
  import('../src/models/CandidateResume.js'),
  import('../src/models/JobPosting.js'),
  import('../src/models/ResumeParseResult.js'),
  import('../src/services/atsMatchingService.js'),
  import('../src/services/atsDispatcher.js'),
  import('../src/utils/permissionRegistry.js'),
]);

const COMPANY_ID = '64b000000000000000000201';
const OTHER_COMPANY_ID = '64b000000000000000000202';
const CANDIDATE_ID = '64b000000000000000000203';
const JOB_ID = '64b000000000000000000204';
const RESUME_ID = '64b000000000000000000205';
const PARSE_RESULT_ID = '64b000000000000000000206';
const USER_ID = '64b000000000000000000207';
const ATS_RESULT_ID = '64b000000000000000000208';

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

const configuration = {
  engineVersion: '1.0',
  weights: {
    requiredSkills: 40,
    experience: 25,
    preferredSkills: 15,
    education: 10,
    locationAndNotice: 10,
  },
  defaultMaxNoticePeriod: 30,
};

const candidateInput = {
  _id: CANDIDATE_ID,
  job: JOB_ID,
  currentStage: 'APPLIED',
  stage: 'APPLIED',
  skills: ['MongoDB'],
  totalExperience: 9,
  education: { degree: '' },
  location: 'Chennai, Tamil Nadu',
  noticePeriod: 45,
};

const jobInput = {
  _id: JOB_ID,
  createdBy: USER_ID,
  requiredSkills: ['Node.js', 'TypeScript', 'MongoDB', 'Docker'],
  preferredSkills: ['Redis', 'AWS'],
  minExperience: 5,
  educationRequirements: ["Bachelor's degree"],
  location: 'Chennai',
  workMode: 'HYBRID',
  maxNoticePeriod: 30,
};

const parseResultInput = {
  _id: PARSE_RESULT_ID,
  updatedAt: new Date('2026-08-22T10:00:00.000Z'),
  structuredData: {
    skills: [
      { display: 'Node.js', normalized: 'node.js' },
      { display: 'TypeScript', normalized: 'typescript' },
      { display: 'Redis', normalized: 'redis' },
    ],
    derivedExperienceMonths: 60,
    identity: { location: 'Bengaluru' },
    education: [
      {
        qualification: 'Bachelor of Science',
        fieldOfStudy: 'Computer Science',
      },
    ],
  },
};

test('default methodology produces an exact explainable score and prioritizes parsed experience', () => {
  const result = matchingService.calculateATSMatch({
    candidate: candidateInput,
    job: jobInput,
    parseResult: parseResultInput,
    configuration,
  });

  assert.equal(result.requiredSkillMatch.score, 30);
  assert.deepEqual(result.requiredSkillMatch.matched, [
    'Node.js',
    'TypeScript',
    'MongoDB',
  ]);
  assert.deepEqual(result.requiredSkillMatch.missing, ['Docker']);
  assert.equal(result.experienceMatch.score, 25);
  assert.equal(result.experienceMatch.candidateMonths, 60);
  assert.equal(result.experienceMatch.source, 'PARSED_RESUME');
  assert.equal(result.preferredSkillMatch.score, 7.5);
  assert.deepEqual(result.preferredSkillMatch.matched, ['Redis']);
  assert.deepEqual(result.preferredSkillMatch.missing, ['AWS']);
  assert.equal(result.educationMatch.score, 10);
  assert.deepEqual(result.educationMatch.matched, ["Bachelor's degree"]);
  assert.equal(result.locationAndNoticeMatch.location.score, 5);
  assert.equal(result.locationAndNoticeMatch.notice.score, 3);
  assert.equal(result.overallScore, 80.5);
  assert.equal(result.matchCategory, 'GOOD');
});

test('empty requirements are explained, remote location scores fully and self-declared experience is the fallback', () => {
  const result = matchingService.calculateATSMatch({
    candidate: {
      ...candidateInput,
      totalExperience: 2,
      location: '',
      noticePeriod: null,
    },
    job: {
      ...jobInput,
      requiredSkills: [],
      preferredSkills: [],
      minExperience: 4,
      educationRequirements: [],
      workMode: 'REMOTE',
      location: 'Mumbai',
    },
    parseResult: {
      ...parseResultInput,
      structuredData: {
        ...parseResultInput.structuredData,
        derivedExperienceMonths: 0,
      },
    },
    configuration,
  });

  assert.equal(result.requiredSkillMatch.score, 40);
  assert.match(result.requiredSkillMatch.explanation, /no required skills are configured/i);
  assert.equal(result.experienceMatch.score, 12.5);
  assert.equal(result.experienceMatch.source, 'CANDIDATE_DECLARATION');
  assert.equal(result.educationMatch.score, 10);
  assert.equal(result.locationAndNoticeMatch.location.score, 5);
  assert.match(result.locationAndNoticeMatch.location.explanation, /remote/i);
  assert.equal(result.locationAndNoticeMatch.notice.score, 1);
});

test('education matching respects both qualification level and configured field of study', () => {
  const matched = matchingService.calculateATSMatch({
    candidate: candidateInput,
    job: {
      ...jobInput,
      educationRequirements: ["Bachelor's degree in Computer Science"],
    },
    parseResult: parseResultInput,
    configuration,
  });
  const missing = matchingService.calculateATSMatch({
    candidate: candidateInput,
    job: {
      ...jobInput,
      educationRequirements: ["Bachelor's degree in Civil Engineering"],
    },
    parseResult: parseResultInput,
    configuration,
  });

  assert.equal(matched.educationMatch.score, 10);
  assert.equal(missing.educationMatch.score, 0);
  assert.deepEqual(missing.educationMatch.missing, [
    "Bachelor's degree in Civil Engineering",
  ]);
});

test('changing job requirements changes the score without producing a hiring decision', () => {
  const initial = matchingService.calculateATSMatch({
    candidate: candidateInput,
    job: jobInput,
    parseResult: parseResultInput,
    configuration,
  });
  const recalculated = matchingService.calculateATSMatch({
    candidate: candidateInput,
    job: {
      ...jobInput,
      requiredSkills: ['Node.js', 'TypeScript'],
      preferredSkills: ['Redis'],
      minExperience: 3,
    },
    parseResult: parseResultInput,
    configuration,
  });

  assert.equal(initial.overallScore, 80.5);
  assert.equal(recalculated.overallScore, 98);
  assert.equal(Object.hasOwn(recalculated, 'decision'), false);
  assert.equal(Object.hasOwn(recalculated, 'rank'), false);
  assert.equal(Object.hasOwn(recalculated, 'rejected'), false);
});

test('processing upserts one tenant result, records one immutable APPLIED transition and emits audits', async () => {
  const restore = restorable(
    [Candidate, 'findOne'],
    [Candidate, 'findOneAndUpdate'],
    [Candidate, 'updateOne'],
    [CandidatePipelineHistory, 'create'],
    [JobPosting, 'findOne'],
    [CandidateResume, 'findOne'],
    [ResumeParseResult, 'findOne'],
    [ATSResult, 'findOne'],
    [ATSResult, 'findOneAndUpdate'],
    [CandidateHistory, 'create'],
    [AuditLog, 'create']
  );
  let existing = null;
  let candidateStage = 'APPLIED';
  const upserts = [];
  const stageUpdates = [];
  const pipelineHistory = [];
  const history = [];
  const audits = [];

  try {
    Candidate.findOne = (filter) => {
      assert.equal(String(filter.companyId), COMPANY_ID);
      if (filter.job) assert.equal(String(filter.job), JOB_ID);
      return leanQuery({
        ...candidateInput,
        currentStage: candidateStage,
        stage: candidateStage,
        candidateCode: 'CAN-000203',
      });
    };
    Candidate.findOneAndUpdate = (filter, update) => {
      stageUpdates.push({ filter, update });
      candidateStage = update.$set.currentStage;
      return leanQuery({
        ...candidateInput,
        currentStage: candidateStage,
        stage: candidateStage,
        candidateCode: 'CAN-000203',
      });
    };
    Candidate.updateOne = async () => ({ modifiedCount: 1 });
    CandidatePipelineHistory.create = async (payload) => {
      const event = {
        _id: '64b000000000000000000209',
        createdAt: new Date(),
        ...payload,
      };
      pipelineHistory.push(event);
      return event;
    };
    JobPosting.findOne = (filter) => {
      assert.equal(String(filter.companyId), COMPANY_ID);
      return leanQuery(jobInput);
    };
    CandidateResume.findOne = (filter) => {
      assert.equal(String(filter.companyId), COMPANY_ID);
      assert.equal(String(filter.candidate), CANDIDATE_ID);
      return leanQuery({ _id: RESUME_ID });
    };
    ResumeParseResult.findOne = (filter) => {
      assert.equal(String(filter.companyId), COMPANY_ID);
      assert.equal(String(filter.candidate), CANDIDATE_ID);
      return leanQuery(parseResultInput);
    };
    ATSResult.findOne = (filter) => {
      assert.deepEqual(
        { companyId: String(filter.companyId), candidateId: String(filter.candidateId) },
        { companyId: COMPANY_ID, candidateId: CANDIDATE_ID }
      );
      return leanQuery(existing);
    };
    ATSResult.findOneAndUpdate = (filter, update, options) => {
      upserts.push({ filter, update, options });
      existing = {
        _id: ATS_RESULT_ID,
        ...update.$set,
      };
      return leanQuery(existing);
    };
    CandidateHistory.create = async (payload) => {
      history.push(payload);
      return payload;
    };
    AuditLog.create = async (payload) => {
      audits.push(payload);
      return payload;
    };

    const first = await matchingService.processATSMatch({
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      jobId: JOB_ID,
      resumeId: RESUME_ID,
      parseResultId: PARSE_RESULT_ID,
      trigger: 'RESUME_PARSED',
    });
    const second = await matchingService.processATSMatch({
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      jobId: JOB_ID,
      resumeId: RESUME_ID,
      parseResultId: PARSE_RESULT_ID,
      trigger: 'MANUAL_REPROCESS',
      actorId: USER_ID,
    });

    assert.equal(first.action, 'ATS_PROCESSED');
    assert.equal(second.action, 'ATS_REPROCESSED');
    assert.equal(upserts.length, 2);
    assert.deepEqual(
      upserts.map(({ filter }) => ({
        companyId: String(filter.companyId),
        candidateId: String(filter.candidateId),
      })),
      [
        { companyId: COMPANY_ID, candidateId: CANDIDATE_ID },
        { companyId: COMPANY_ID, candidateId: CANDIDATE_ID },
      ]
    );
    assert.equal(upserts.every(({ options }) => options.upsert), true);
    assert.equal(stageUpdates.length, 1);
    assert.equal(stageUpdates[0].update.$set.stage, 'ATS_SCREENING');
    assert.equal(pipelineHistory.length, 1);
    assert.equal(pipelineHistory[0].fromStage, 'APPLIED');
    assert.equal(pipelineHistory[0].toStage, 'ATS_SCREENING');
    assert.equal(String(pipelineHistory[0].actor), USER_ID);
    assert.equal(pipelineHistory[0].metadata.source, 'ATS_ENGINE');
    assert.deepEqual(history.map((event) => event.action), [
      'ATS_PROCESSED',
      'ATS_REPROCESSED',
    ]);
    assert.equal(history[1].actorType, 'TENANT_USER');
    assert.equal(String(history[1].actor), USER_ID);
    assert.deepEqual(audits.map((event) => event.action), [
      'CANDIDATE_STAGE_CHANGED',
      'ATS_PROCESSED',
      'ATS_REPROCESSED',
    ]);
    assert.equal(JSON.stringify({ history, audits }).includes('rawText'), false);
  } finally {
    restore();
  }
});

test('unchanged automatic input is skipped without duplicate score, audit or stage history', async () => {
  const restore = restorable(
    [Candidate, 'findOne'],
    [Candidate, 'findOneAndUpdate'],
    [Candidate, 'updateOne'],
    [CandidatePipelineHistory, 'create'],
    [JobPosting, 'findOne'],
    [CandidateResume, 'findOne'],
    [ResumeParseResult, 'findOne'],
    [ATSResult, 'findOne'],
    [ATSResult, 'findOneAndUpdate'],
    [CandidateHistory, 'create'],
    [AuditLog, 'create']
  );
  let resultWrites = 0;
  let historyWrites = 0;
  let stageWrites = 0;
  let pipelineWrites = 0;
  let candidateStage = 'APPLIED';

  try {
    Candidate.findOne = () => leanQuery({
      ...candidateInput,
      currentStage: candidateStage,
      stage: candidateStage,
    });
    Candidate.findOneAndUpdate = (_filter, update) => {
      stageWrites += 1;
      candidateStage = update.$set.currentStage;
      return leanQuery({
        ...candidateInput,
        currentStage: candidateStage,
        stage: candidateStage,
      });
    };
    Candidate.updateOne = async () => ({ modifiedCount: 1 });
    CandidatePipelineHistory.create = async (payload) => {
      pipelineWrites += 1;
      return {
        _id: '64b000000000000000000209',
        createdAt: new Date(),
        ...payload,
      };
    };
    JobPosting.findOne = () => leanQuery(jobInput);
    CandidateResume.findOne = () => leanQuery({ _id: RESUME_ID });
    ResumeParseResult.findOne = () => leanQuery(parseResultInput);

    const firstFingerprintCapture = [];
    ATSResult.findOne = () => leanQuery(
      firstFingerprintCapture.length
        ? { inputFingerprint: firstFingerprintCapture[0] }
        : null
    );
    ATSResult.findOneAndUpdate = (_filter, update) => {
      resultWrites += 1;
      firstFingerprintCapture.push(update.$set.inputFingerprint);
      return leanQuery({ _id: ATS_RESULT_ID, ...update.$set });
    };
    CandidateHistory.create = async (payload) => {
      historyWrites += 1;
      return payload;
    };
    AuditLog.create = async (payload) => payload;

    await matchingService.processATSMatch({
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      jobId: JOB_ID,
      resumeId: RESUME_ID,
      parseResultId: PARSE_RESULT_ID,
    });
    const repeated = await matchingService.processATSMatch({
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      jobId: JOB_ID,
      resumeId: RESUME_ID,
      parseResultId: PARSE_RESULT_ID,
    });

    assert.equal(resultWrites, 1);
    assert.equal(historyWrites, 1);
    assert.equal(stageWrites, 1);
    assert.equal(pipelineWrites, 1);
    assert.equal(repeated.skipped, true);
    assert.equal(repeated.reason, 'UNCHANGED_INPUTS');
  } finally {
    restore();
  }
});

test('cross-tenant ATS lookup is hidden and unique storage is tenant-scoped', async () => {
  const restore = restorable([Candidate, 'findOne']);
  let capturedFilter;

  try {
    Candidate.findOne = (filter) => {
      capturedFilter = filter;
      return leanQuery(null);
    };

    await assert.rejects(
      matchingService.getCandidateATSResult({
        companyId: OTHER_COMPANY_ID,
        candidateRef: 'CAN-000203',
      }),
      (error) => error.statusCode === 404
    );

    assert.equal(String(capturedFilter.companyId), OTHER_COMPANY_ID);
    assert.equal(capturedFilter.candidateCode, 'CAN-000203');
    const uniqueIndex = ATSResult.schema.indexes().find(
      ([fields]) => fields.companyId === 1 && fields.candidateId === 1
    );
    assert.ok(uniqueIndex);
    assert.equal(uniqueIndex[1].unique, true);
    assert.equal(ATSResult.schema.path('inputFingerprint').options.select, false);
  } finally {
    restore();
  }
});

test('ATS read returns descriptive unsupported and pending parser states without exposing parser data', async () => {
  const restore = restorable(
    [Candidate, 'findOne'],
    [CandidateResume, 'findOne']
  );

  try {
    Candidate.findOne = () => leanQuery({
      _id: CANDIDATE_ID,
      candidateCode: 'CAN-000203',
      job: JOB_ID,
    });
    CandidateResume.findOne = () => leanQuery({
      _id: RESUME_ID,
      parsingStatus: 'UNSUPPORTED',
    });

    const unsupported = await matchingService.getCandidateATSResult({
      companyId: COMPANY_ID,
      candidateRef: 'CAN-000203',
    });
    assert.equal(unsupported.status, 'PARSING_UNSUPPORTED');
    assert.match(unsupported.message, /could not be parsed safely/i);
    assert.equal(JSON.stringify(unsupported).includes('rawText'), false);

    CandidateResume.findOne = () => leanQuery({
      _id: RESUME_ID,
      parsingStatus: 'PROCESSING',
    });
    const pending = await matchingService.getCandidateATSResult({
      companyId: COMPANY_ID,
      candidateRef: 'CAN-000203',
    });
    assert.equal(pending.status, 'PARSING_PENDING');
    assert.equal(pending.parserStatus, 'PROCESSING');
  } finally {
    restore();
  }
});

test('manual reprocess validates tenant-owned inputs and persists queue recovery state', async () => {
  const restore = restorable(
    [Candidate, 'findOne'],
    [CandidateResume, 'findOne'],
    [ResumeParseResult, 'findOne'],
    [JobPosting, 'findOne'],
    [ATSResult, 'updateOne']
  );
  const companyFilters = [];
  let pendingUpdate;

  try {
    Candidate.findOne = (filter) => {
      companyFilters.push(filter.companyId);
      return leanQuery({
        _id: CANDIDATE_ID,
        candidateCode: 'CAN-000203',
        job: JOB_ID,
      });
    };
    CandidateResume.findOne = (filter) => {
      companyFilters.push(filter.companyId);
      return leanQuery({ _id: RESUME_ID, parsingStatus: 'COMPLETED' });
    };
    ResumeParseResult.findOne = (filter) => {
      companyFilters.push(filter.companyId);
      return leanQuery({ _id: PARSE_RESULT_ID });
    };
    JobPosting.findOne = (filter) => {
      companyFilters.push(filter.companyId);
      return leanQuery({ _id: JOB_ID });
    };
    ATSResult.updateOne = async (filter, update) => {
      companyFilters.push(filter.companyId);
      pendingUpdate = { filter, update };
      return { modifiedCount: 1 };
    };

    const prepared = await matchingService.prepareATSReprocess({
      companyId: COMPANY_ID,
      candidateRef: 'CAN-000203',
      actorId: USER_ID,
    });

    assert.equal(companyFilters.every((value) => String(value) === COMPANY_ID), true);
    assert.equal(String(pendingUpdate.filter.candidateId), CANDIDATE_ID);
    assert.equal(String(pendingUpdate.filter.jobId), JOB_ID);
    assert.equal(pendingUpdate.update.$set.recalculationPending, true);
    assert.equal(
      String(pendingUpdate.update.$set.recalculationRequestedBy),
      USER_ID
    );
    assert.ok(prepared.requestedAt instanceof Date);
  } finally {
    restore();
  }
});

test('dispatcher deduplicates persisted identities and rejects forged jobs', () => {
  const before = dispatcher.atsDispatcherState().queued;
  const first = dispatcher.dispatchATSMatching({
    companyId: COMPANY_ID,
    candidateId: CANDIDATE_ID,
    jobId: JOB_ID,
    resumeId: RESUME_ID,
    parseResultId: PARSE_RESULT_ID,
  });
  const second = dispatcher.dispatchATSMatching({
    companyId: COMPANY_ID,
    candidateId: CANDIDATE_ID,
    jobId: JOB_ID,
    resumeId: RESUME_ID,
    parseResultId: PARSE_RESULT_ID,
  });
  const invalid = dispatcher.dispatchATSMatching({
    companyId: 'not-an-id',
    candidateId: CANDIDATE_ID,
    jobId: JOB_ID,
    resumeId: RESUME_ID,
    parseResultId: PARSE_RESULT_ID,
  });

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(invalid.accepted, false);
  assert.equal(dispatcher.atsDispatcherState().queued - before, 1);
});

test('ATS routes enforce exact candidate permissions and Employee has no ATS access', async () => {
  const [routes, publicRoutes] = await Promise.all([
    readFile(
      new URL('../src/routes/recruitmentRoutes.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../src/routes/publicCareerRoutes.js', import.meta.url),
      'utf8'
    ),
  ]);
  const readRoute = routes.indexOf("'/candidates/:candidateId/ats-result'");
  const reprocessRoute = routes.indexOf("'/candidates/:candidateId/ats-reprocess'");
  const readPermission = routes.indexOf(
    "requirePermission('CANDIDATE_READ')",
    readRoute
  );
  const updatePermission = routes.indexOf(
    "requirePermission('CANDIDATE_UPDATE')",
    reprocessRoute
  );
  const limiter = routes.indexOf('atsReprocessRateLimit', reprocessRoute);

  assert.notEqual(readRoute, -1);
  assert.notEqual(reprocessRoute, -1);
  assert.equal(readPermission - readRoute < 180, true);
  assert.equal(updatePermission - reprocessRoute < 220, true);
  assert.equal(limiter - reprocessRoute < 300, true);
  assert.equal(publicRoutes.includes('ats-result'), false);
  assert.equal(publicRoutes.includes('ats-reprocess'), false);

  for (const role of ['COMPANY_ADMIN', 'HR_MANAGER']) {
    assert.equal(
      permissionRegistry.DEFAULT_ROLE_MATRIX[role].includes('CANDIDATE_READ'),
      true
    );
    assert.equal(
      permissionRegistry.DEFAULT_ROLE_MATRIX[role].includes('CANDIDATE_UPDATE'),
      true
    );
  }

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

test('parser completion dispatch and hostile-text-safe ATS UI remain wired', async () => {
  const [processingSource, panelSource, detailSource] = await Promise.all([
    readFile(
      new URL('../src/services/resumeProcessingService.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../../Frontend/src/components/recruitment/ATSAnalysisPanel.jsx', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../../Frontend/src/pages/recruitment/CandidateDetailPage.jsx', import.meta.url),
      'utf8'
    ),
  ]);

  const completedGuard = processingSource.indexOf("resultStatus === 'COMPLETED'");
  const dispatchCall = processingSource.indexOf('dispatchATSMatching({', completedGuard);
  assert.notEqual(completedGuard, -1);
  assert.notEqual(dispatchCall, -1);
  assert.equal(dispatchCall - completedGuard < 150, true);
  assert.match(panelSource, /Matched required skills/);
  assert.match(panelSource, /Missing preferred skills/);
  assert.match(panelSource, /Assistive analysis only/);
  assert.match(panelSource, /Recalculate ATS/);
  assert.equal(panelSource.includes('dangerouslySetInnerHTML'), false);
  assert.match(detailSource, /ATSAnalysisPanel/);
  assert.equal(detailSource.includes('ATS analysis has not been processed yet'), false);
});
