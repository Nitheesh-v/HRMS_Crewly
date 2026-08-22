import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  { default: AuditLog },
  { default: Candidate },
  { default: CandidateHistory },
  { default: CandidatePipelineHistory, PIPELINE_STAGES },
  { default: CandidateResume },
  { default: User },
  pipelineService,
  inboxService,
] = await Promise.all([
  import('../src/models/AuditLog.js'),
  import('../src/models/Candidate.js'),
  import('../src/models/CandidateHistory.js'),
  import('../src/models/CandidatePipelineHistory.js'),
  import('../src/models/CandidateResume.js'),
  import('../src/models/User.js'),
  import('../src/services/candidatePipelineService.js'),
  import('../src/services/candidateInboxService.js'),
]);

const COMPANY_ID = '64b000000000000000000301';
const OTHER_COMPANY_ID = '64b000000000000000000302';
const CANDIDATE_ONE = '64b000000000000000000303';
const CANDIDATE_TWO = '64b000000000000000000304';
const JOB_ID = '64b000000000000000000305';
const ACTOR_ID = '64b000000000000000000306';
const USER_ID = '64b000000000000000000307';
const HISTORY_ID = '64b000000000000000000308';

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

const query = (value) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  sort() {
    return this;
  },
  skip() {
    return this;
  },
  limit() {
    return this;
  },
  lean() {
    return Promise.resolve(value);
  },
});

const candidateRecord = ({
  id = CANDIDATE_ONE,
  stage = 'APPLIED',
  code = 'CAN-000301',
} = {}) => ({
  _id: id,
  companyId: COMPANY_ID,
  candidateCode: code,
  name: `Candidate ${code}`,
  email: `${code.toLowerCase()}@example.com`,
  job: JOB_ID,
  currentStage: stage,
  stage,
});

test('pipeline stages, immutable ledger fields and required tenant indexes match the contract', () => {
  assert.deepEqual(PIPELINE_STAGES, [
    'APPLIED',
    'ATS_SCREENING',
    'HR_SCREENING',
    'SHORTLISTED',
    'INTERVIEW_1',
    'INTERVIEW_2',
    'INTERVIEW_3',
    'MANAGER_ROUND',
    'HR_FINAL',
    'FINAL_REVIEW',
    'SELECTED',
    'OFFER',
    'OFFER_ACCEPTED',
    'PRE_ONBOARDING',
    'JOINED',
    'REJECTED',
    'HOLD',
    'WITHDRAWN',
  ]);

  const schema = CandidatePipelineHistory.schema;
  for (const path of [
    'companyId',
    'candidateId',
    'jobPostingId',
    'fromStage',
    'toStage',
    'actor',
    'reason',
    'metadata',
    'createdAt',
  ]) {
    assert.equal(schema.path(path).options.immutable, true, `${path} must be immutable`);
  }
  assert.equal(schema.path('actor').options.required, true);
  assert.equal(schema.path('reason').options.maxlength, 1000);

  const indexes = schema.indexes().map(([fields]) => fields);
  assert.ok(indexes.some((fields) =>
    fields.companyId === 1 && fields.candidateId === 1 && fields.createdAt === -1
  ));
  assert.ok(indexes.some((fields) =>
    fields.companyId === 1 && fields.jobPostingId === 1 && fields.toStage === 1
  ));

  assert.ok(Candidate.schema.path('currentStage'));
  assert.ok(Candidate.schema.path('assignedRecruiter'));
  assert.ok(Candidate.schema.path('hiringManager'));
});

test('single transition compares and sets both stage fields, then writes immutable history and audit evidence', async () => {
  const restore = restorable(
    [Candidate, 'findOne'],
    [Candidate, 'findOneAndUpdate'],
    [CandidatePipelineHistory, 'create'],
    [AuditLog, 'create']
  );
  const updates = [];
  const histories = [];
  const audits = [];

  try {
    Candidate.findOne = (filter) => {
      assert.equal(String(filter.companyId), COMPANY_ID);
      return query(candidateRecord());
    };
    Candidate.findOneAndUpdate = (filter, update) => {
      updates.push({ filter, update });
      return query(candidateRecord({ stage: 'HR_SCREENING' }));
    };
    CandidatePipelineHistory.create = async (payload) => {
      const history = { _id: HISTORY_ID, createdAt: new Date(), ...payload };
      histories.push(history);
      return history;
    };
    AuditLog.create = async (payload) => {
      audits.push(payload);
      return payload;
    };

    const result = await pipelineService.transitionCandidateStage({
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ONE,
      targetStage: 'HR_SCREENING',
      actorId: ACTOR_ID,
      metadata: { source: 'MANUAL' },
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.$set.currentStage, 'HR_SCREENING');
    assert.equal(updates[0].update.$set.stage, 'HR_SCREENING');
    assert.equal(histories.length, 1);
    assert.equal(histories[0].fromStage, 'APPLIED');
    assert.equal(histories[0].toStage, 'HR_SCREENING');
    assert.equal(String(histories[0].actor), ACTOR_ID);
    assert.equal(audits[0].action, 'CANDIDATE_STAGE_CHANGED');
    assert.equal(String(audits[0].companyId), COMPANY_ID);
    assert.equal(result.toStage, 'HR_SCREENING');
  } finally {
    restore();
  }
});

test('disposition and sent-back transitions require a bounded reason before mutation', async () => {
  const restore = restorable(
    [Candidate, 'findOne'],
    [Candidate, 'findOneAndUpdate']
  );
  let writes = 0;

  try {
    Candidate.findOne = () => query(candidateRecord({ stage: 'INTERVIEW_2' }));
    Candidate.findOneAndUpdate = () => {
      writes += 1;
      return query(null);
    };

    await assert.rejects(
      pipelineService.transitionCandidateStage({
        companyId: COMPANY_ID,
        candidateId: CANDIDATE_ONE,
        targetStage: 'HOLD',
        actorId: ACTOR_ID,
      }),
      (error) => error.statusCode === 400
    );
    await assert.rejects(
      pipelineService.transitionCandidateStage({
        companyId: COMPANY_ID,
        candidateId: CANDIDATE_ONE,
        targetStage: 'INTERVIEW_1',
        actorId: ACTOR_ID,
      }),
      (error) => error.statusCode === 400
    );
    assert.equal(writes, 0);
  } finally {
    restore();
  }
});

test('history failure triggers compensating stage rollback and never reports success', async () => {
  const restore = restorable(
    [Candidate, 'findOne'],
    [Candidate, 'findOneAndUpdate'],
    [Candidate, 'updateOne'],
    [CandidatePipelineHistory, 'create']
  );
  const rollbacks = [];

  try {
    Candidate.findOne = () => query(candidateRecord());
    Candidate.findOneAndUpdate = () => query(candidateRecord({ stage: 'SHORTLISTED' }));
    CandidatePipelineHistory.create = async () => {
      throw new Error('ledger unavailable');
    };
    Candidate.updateOne = async (filter, update) => {
      rollbacks.push({ filter, update });
      return { modifiedCount: 1 };
    };

    await assert.rejects(
      pipelineService.transitionCandidateStage({
        companyId: COMPANY_ID,
        candidateId: CANDIDATE_ONE,
        targetStage: 'SHORTLISTED',
        actorId: ACTOR_ID,
      }),
      (error) => error.statusCode === 500
    );
    assert.equal(rollbacks.length, 1);
    assert.equal(rollbacks[0].filter.companyId, COMPANY_ID);
    assert.equal(rollbacks[0].update.$set.currentStage, 'APPLIED');
    assert.equal(rollbacks[0].update.$set.stage, 'APPLIED');
  } finally {
    restore();
  }
});

test('bulk preflight rejects an unknown or cross-tenant selection before every side effect', async () => {
  const restore = restorable(
    [Candidate, 'find'],
    [Candidate, 'findOneAndUpdate'],
    [CandidatePipelineHistory, 'create']
  );
  let mutations = 0;

  try {
    Candidate.find = (filter) => {
      assert.equal(filter.companyId, COMPANY_ID);
      assert.deepEqual(filter._id.$in, [CANDIDATE_ONE, CANDIDATE_TWO]);
      return query([candidateRecord()]);
    };
    Candidate.findOneAndUpdate = () => {
      mutations += 1;
      return query(null);
    };
    CandidatePipelineHistory.create = async () => {
      mutations += 1;
      return null;
    };

    await assert.rejects(
      pipelineService.bulkCandidateAction({
        companyId: COMPANY_ID,
        candidateIds: [CANDIDATE_ONE, CANDIDATE_TWO],
        action: 'SHORTLIST',
        actorId: ACTOR_ID,
      }),
      (error) => error.statusCode === 403
    );
    assert.equal(mutations, 0);
  } finally {
    restore();
  }
});

test('bulk processing isolates per-candidate conflicts and writes one history for each success', async () => {
  const restore = restorable(
    [Candidate, 'find'],
    [Candidate, 'findOne'],
    [Candidate, 'findOneAndUpdate'],
    [CandidatePipelineHistory, 'create'],
    [AuditLog, 'create']
  );
  const records = new Map([
    [CANDIDATE_ONE, candidateRecord()],
    [CANDIDATE_TWO, candidateRecord({
      id: CANDIDATE_TWO,
      stage: 'SHORTLISTED',
      code: 'CAN-000302',
    })],
  ]);
  const histories = [];

  try {
    Candidate.find = (filter) => {
      assert.equal(filter.companyId, COMPANY_ID);
      return query([...records.values()]);
    };
    Candidate.findOne = (filter) => query(records.get(String(filter._id)) || null);
    Candidate.findOneAndUpdate = (filter, update) => {
      const record = records.get(String(filter._id));
      if (!record) return query(null);
      const updated = { ...record, ...update.$set };
      records.set(String(filter._id), updated);
      return query(updated);
    };
    CandidatePipelineHistory.create = async (payload) => {
      const event = { _id: HISTORY_ID, createdAt: new Date(), ...payload };
      histories.push(event);
      return event;
    };
    AuditLog.create = async (payload) => payload;

    const result = await pipelineService.bulkCandidateAction({
      companyId: COMPANY_ID,
      candidateIds: [CANDIDATE_ONE, CANDIDATE_TWO],
      action: 'SHORTLIST',
      actorId: ACTOR_ID,
    });

    assert.equal(result.summary.requested, 2);
    assert.equal(result.summary.succeeded, 1);
    assert.equal(result.summary.failed, 1);
    assert.equal(String(result.succeeded[0].candidateId), CANDIDATE_ONE);
    assert.equal(String(result.failed[0].candidateId), CANDIDATE_TWO);
    assert.equal(histories.length, 1);
    assert.equal(String(histories[0].candidateId), CANDIDATE_ONE);
  } finally {
    restore();
  }
});

test('assignment verifies tenant ownership and eligibility before candidate mutation', async () => {
  const restore = restorable(
    [Candidate, 'find'],
    [Candidate, 'findOneAndUpdate'],
    [CandidateHistory, 'create'],
    [User, 'findOne']
  );
  let candidateWrites = 0;

  try {
    Candidate.find = () => query([candidateRecord()]);
    User.findOne = (filter) => {
      assert.equal(filter.companyId, COMPANY_ID);
      assert.equal(filter.status, 'ACTIVE');
      assert.ok(filter.role.$in.includes('HR_MANAGER'));
      return query(null);
    };
    Candidate.findOneAndUpdate = () => {
      candidateWrites += 1;
      return query(null);
    };
    CandidateHistory.create = async () => {
      candidateWrites += 1;
      return null;
    };

    await assert.rejects(
      pipelineService.bulkCandidateAction({
        companyId: COMPANY_ID,
        candidateIds: [CANDIDATE_ONE],
        action: 'ASSIGN_RECRUITER',
        userId: USER_ID,
        actorId: ACTOR_ID,
      }),
      (error) => error.statusCode === 400
    );
    assert.equal(candidateWrites, 0);
  } finally {
    restore();
  }
});

test('candidate detail merges operational and immutable pipeline history chronologically', async () => {
  const restore = restorable(
    [Candidate, 'findOne'],
    [CandidateResume, 'findOne'],
    [CandidateHistory, 'find'],
    [CandidatePipelineHistory, 'find']
  );
  const earlier = new Date('2026-08-22T10:00:00.000Z');
  const later = new Date('2026-08-22T11:00:00.000Z');

  try {
    Candidate.findOne = (filter) => {
      assert.equal(filter.companyId, COMPANY_ID);
      return query({
        ...candidateRecord(),
        applicationDate: earlier,
        status: 'ACTIVE',
        source: 'INTERNAL',
        applicationStatus: 'APPLIED',
        job: {
          _id: JOB_ID,
          jobCode: 'JOB-000301',
          title: 'Engineer',
        },
        skills: [],
        links: {},
      });
    };
    CandidateResume.findOne = () => query(null);
    CandidateHistory.find = (filter) => {
      assert.equal(filter.companyId, COMPANY_ID);
      return query([{
        action: 'CANDIDATE_APPLIED',
        actorType: 'SYSTEM',
        eventAt: earlier,
        metadata: {},
      }]);
    };
    CandidatePipelineHistory.find = (filter) => {
      assert.equal(filter.companyId, COMPANY_ID);
      return query([{
        fromStage: 'APPLIED',
        toStage: 'HR_SCREENING',
        actor: { _id: ACTOR_ID, name: '<Recruiter>' },
        reason: '<script>not html</script>',
        metadata: { source: 'MANUAL' },
        createdAt: later,
      }]);
    };

    const detail = await inboxService.getCandidateInboxDetail({
      companyId: COMPANY_ID,
      candidateRef: 'CAN-000301',
    });

    assert.equal(detail.timeline.length, 2);
    assert.equal(detail.timeline[0].action, 'CANDIDATE_APPLIED');
    assert.equal(detail.timeline[1].type, 'STAGE_TRANSITION');
    assert.equal(detail.timeline[1].reason, '<script>not html</script>');
    assert.equal(detail.timeline[1].actor.name, '<Recruiter>');
  } finally {
    restore();
  }
});

test('routes, startup migration and hostile-text-safe React controls stay wired', async () => {
  const [routes, server, inboxPage, detailPage, boardPage] = await Promise.all([
    readFile(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/pages/recruitment/CandidateInboxPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/pages/recruitment/CandidateDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/pages/recruitment/RecruitmentPage.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(routes, /'\/candidates\/pipeline-options'[\s\S]*requirePermission\('CANDIDATE_READ'\)/);
  assert.match(routes, /'\/candidates\/bulk-actions'[\s\S]*requirePermission\('CANDIDATE_UPDATE'\)/);
  assert.match(routes, /'\/candidates\/:id\/stage'[\s\S]*pipelineStageRules[\s\S]*candidatePipelineStageUpdate/);
  assert.match(server, /await ensureCandidatePipelineStages\(\)/);

  for (const source of [inboxPage, detailPage, boardPage]) {
    assert.equal(source.includes('dangerouslySetInnerHTML'), false);
  }
  assert.match(inboxPage, /bulkAction/);
  assert.match(inboxPage, /ASSIGN_HIRING_MANAGER/);
  assert.match(detailPage, /candidate\.timeline/);
  assert.match(detailPage, /stageReasonRequired/);
  assert.match(boardPage, /PIPELINE_STAGES\.map/);
  assert.equal(routes.includes('companyId = req.body'), false);
  assert.equal(routes.includes('companyId = req.query'), false);
  assert.equal(OTHER_COMPANY_ID === COMPANY_ID, false);
});
