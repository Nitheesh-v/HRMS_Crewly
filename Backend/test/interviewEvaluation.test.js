import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  { default: InterviewScorecardTemplate },
  { default: InterviewFeedback, INTERVIEW_FEEDBACK_STATUSES },
  { default: CandidateDecision },
  feedbackService,
  { interviewFeedbackSaveRules },
  { finalDecisionRules },
  { DEFAULT_ROLE_MATRIX, DEFAULT_PERMISSIONS },
  { default: CandidateHistory, CANDIDATE_HISTORY_ACTIONS },
  { default: Interview },
  { default: AuditLog },
  { default: Candidate },
  { default: CandidatePipelineHistory },
  { default: User },
  candidateDecisionService,
] = await Promise.all([
  import('../src/models/InterviewScorecardTemplate.js'),
  import('../src/models/InterviewFeedback.js'),
  import('../src/models/CandidateDecision.js'),
  import('../src/services/interviewFeedbackService.js'),
  import('../src/validators/interviewFeedbackValidator.js'),
  import('../src/validators/candidateDecisionValidator.js'),
  import('../src/utils/permissionRegistry.js'),
  import('../src/models/CandidateHistory.js'),
  import('../src/models/Interview.js'),
  import('../src/models/AuditLog.js'),
  import('../src/models/Candidate.js'),
  import('../src/models/CandidatePipelineHistory.js'),
  import('../src/models/User.js'),
  import('../src/services/candidateDecisionService.js'),
]);

const runRules = async (rules, { body = {}, params = {}, query = {} } = {}) => {
  const req = { body, params, query };
  for (const rule of rules) {
    await new Promise((resolve, reject) => {
      const next = (error) => (error ? reject(error) : resolve());
      try {
        const result = rule(req, {}, next);
        if (result?.catch) result.catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  }
  return req;
};

const templateSnapshot = {
  key: 'TECHNICAL_DEFAULT',
  name: 'Technical interview scorecard',
  roundCategory: 'TECHNICAL',
  version: 1,
  criteria: [
    {
      key: 'PROBLEM_SOLVING',
      label: 'Problem solving',
      description: 'Reasoning and solution quality.',
      maxScore: 10,
      weight: 2,
      required: true,
      commentRequiredBelowScore: 4,
    },
    {
      key: 'COMMUNICATION',
      label: 'Communication',
      description: 'Clarity and listening.',
      maxScore: 10,
      weight: 1,
      required: true,
      commentRequiredBelowScore: 4,
    },
  ],
};

const completeFeedback = () => ({
  ratings: [
    { criterionKey: 'PROBLEM_SOLVING', score: 8, comment: 'Structured reasoning.' },
    { criterionKey: 'COMMUNICATION', score: 5, comment: '' },
  ],
  strengths: 'Explained trade-offs clearly.',
  concerns: '',
  privateNotes: 'Internal note.',
  recommendation: 'HIRE',
});

test('scorecard, feedback and candidate decision models preserve separate tenant-scoped records', () => {
  for (const path of ['companyId', 'roundCategory', 'job', 'criteria', 'version', 'active']) {
    assert.ok(InterviewScorecardTemplate.schema.path(path), `template ${path} must exist`);
  }
  for (const path of [
    'companyId',
    'candidate',
    'job',
    'interview',
    'interviewer',
    'templateSnapshot',
    'ratings',
    'overallScore',
    'recommendation',
    'status',
    'submittedAt',
  ]) {
    assert.ok(InterviewFeedback.schema.path(path), `feedback ${path} must exist`);
  }
  assert.deepEqual(INTERVIEW_FEEDBACK_STATUSES, ['DRAFT', 'SUBMITTED', 'LOCKED']);
  assert.equal(InterviewFeedback.schema.path('companyId').options.immutable, true);
  assert.equal(InterviewFeedback.schema.path('interviewer').options.immutable, true);
  const feedbackIndex = InterviewFeedback.schema.indexes().find(
    ([fields]) => fields.companyId === 1 && fields.interview === 1 && fields.interviewer === 1
  );
  assert.equal(feedbackIndex?.[1]?.unique, true);

  for (const path of [
    'companyId',
    'candidate',
    'job',
    'decision',
    'sourceStage',
    'reasonCategory',
    'decidedBy',
    'decidedAt',
    'pipelineHistory',
    'candidateHistory',
  ]) {
    assert.ok(CandidateDecision.schema.path(path), `decision ${path} must exist`);
  }
  const operationIndex = CandidateDecision.schema.indexes().find(
    ([fields]) => fields.companyId === 1 && fields.candidate === 1 && fields.activeOperationKey === 1
  );
  assert.equal(operationIndex?.[1]?.unique, true);
  assert.deepEqual(operationIndex?.[1]?.partialFilterExpression, {
    activeOperationKey: { $type: 'string' },
  });
});

test('backend-authoritative calculation validates criteria, ranges, completion and low-score comments', () => {
  const normalized = feedbackService.normalizeFeedbackPayload({
    input: completeFeedback(),
    templateSnapshot,
    submit: true,
  });
  assert.equal(normalized.overallScore, 7);
  assert.equal(normalized.maxOverallScore, 10);
  assert.equal(normalized.ratings[0].maxScore, 10);
  assert.equal(normalized.ratings[0].weight, 2);
  assert.equal(normalized.ratings[0].criterionLabel, 'Problem solving');

  const partialDraft = feedbackService.normalizeFeedbackPayload({
    input: {
      ratings: [{ criterionKey: 'COMMUNICATION', score: 6 }],
      recommendation: '',
    },
    templateSnapshot,
    submit: false,
  });
  assert.equal(partialDraft.ratings.length, 1);
  assert.equal(partialDraft.overallScore, 6);

  assert.throws(
    () => feedbackService.normalizeFeedbackPayload({
      input: {
        ...completeFeedback(),
        ratings: [{ criterionKey: 'UNTRUSTED_CLIENT_CRITERION', score: 10 }],
      },
      templateSnapshot,
      submit: true,
    }),
    (error) => error.statusCode === 400 && /not in this scorecard/i.test(error.message)
  );
  assert.throws(
    () => feedbackService.normalizeFeedbackPayload({
      input: {
        ...completeFeedback(),
        ratings: [
          { criterionKey: 'PROBLEM_SOLVING', score: 11 },
          { criterionKey: 'COMMUNICATION', score: 5 },
        ],
      },
      templateSnapshot,
      submit: true,
    }),
    (error) => error.statusCode === 400 && /between 1 and 10/i.test(error.message)
  );
  assert.throws(
    () => feedbackService.normalizeFeedbackPayload({
      input: {
        ...completeFeedback(),
        ratings: [{ criterionKey: 'PROBLEM_SOLVING', score: 8 }],
      },
      templateSnapshot,
      submit: true,
    }),
    (error) => error.statusCode === 400 && /complete all required/i.test(error.message)
  );
  assert.throws(
    () => feedbackService.normalizeFeedbackPayload({
      input: {
        ...completeFeedback(),
        ratings: [
          { criterionKey: 'PROBLEM_SOLVING', score: 3, comment: '' },
          { criterionKey: 'COMMUNICATION', score: 5, comment: '' },
        ],
      },
      templateSnapshot,
      submit: true,
    }),
    (error) => error.statusCode === 400 && /add a comment/i.test(error.message)
  );
});

test('validators reject frontend ownership, aggregate and decision actor injection', async () => {
  await runRules(interviewFeedbackSaveRules, {
    params: { id: '64b000000000000000000120' },
    body: { ...completeFeedback(), action: 'SUBMIT' },
  });

  for (const injected of [
    { companyId: '64b000000000000000000199' },
    { interviewerId: '64b000000000000000000198' },
    { overallScore: 10 },
    { status: 'SUBMITTED' },
  ]) {
    await assert.rejects(
      runRules(interviewFeedbackSaveRules, {
        params: { id: '64b000000000000000000120' },
        body: { ...completeFeedback(), action: 'SUBMIT', ...injected },
      }),
      (error) => error.statusCode === 400 && /controlled by the server/i.test(error.message)
    );
  }

  const forgedRating = completeFeedback();
  forgedRating.ratings[0].maxScore = 100;
  await assert.rejects(
    runRules(interviewFeedbackSaveRules, {
      params: { id: '64b000000000000000000120' },
      body: { ...forgedRating, action: 'SUBMIT' },
    }),
    (error) => error.statusCode === 400 && /not accepted/i.test(error.message)
  );

  await runRules(finalDecisionRules, {
    params: { candidateId: '64b000000000000000000121' },
    body: {
      decision: 'REJECTED',
      reasonCategory: 'SKILLS_MISMATCH',
      comment: 'Required role skills were not demonstrated.',
    },
  });
  await assert.rejects(
    runRules(finalDecisionRules, {
      params: { candidateId: '64b000000000000000000121' },
      body: {
        decision: 'SELECTED',
        reasonCategory: 'BEST_FIT',
        decidedBy: '64b000000000000000000198',
      },
    }),
    (error) => error.statusCode === 400 && /controlled by the server/i.test(error.message)
  );
});

test('RBAC grants broad HR visibility and narrow assignment-only interviewer feedback', () => {
  for (const role of ['COMPANY_ADMIN', 'HR_MANAGER']) {
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('INTERVIEW_FEEDBACK_READ'), true);
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('CANDIDATE_FINAL_DECISION'), true);
  }
  for (const role of ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE']) {
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('INTERVIEW_FEEDBACK_READ'), false);
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('CANDIDATE_FINAL_DECISION'), false);
  }
  for (const role of ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD', 'EMPLOYEE']) {
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('INTERVIEW_FEEDBACK_READ_SELF'), true);
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('INTERVIEW_FEEDBACK_SUBMIT_SELF'), true);
  }
  const names = new Set(DEFAULT_PERMISSIONS.map((permission) => permission.name));
  for (const permission of [
    'INTERVIEW_FEEDBACK_READ',
    'INTERVIEW_FEEDBACK_READ_SELF',
    'INTERVIEW_FEEDBACK_SUBMIT_SELF',
    'CANDIDATE_FINAL_DECISION',
  ]) {
    assert.equal(names.has(permission), true);
  }
});

test('evaluation and human-decision timeline actions are registered', () => {
  for (const action of [
    'INTERVIEW_FEEDBACK_SUBMITTED',
    'FINAL_REVIEW_STARTED',
    'CANDIDATE_SELECTED',
    'CANDIDATE_REJECTED',
    'CANDIDATE_HOLD',
  ]) {
    assert.equal(CANDIDATE_HISTORY_ACTIONS.includes(action), true);
  }
});

test('scorecard access safely hides cross-tenant interviews and denies unassigned users', async () => {
  const originalFindOne = Interview.findOne;
  const companyId = '64b000000000000000000111';
  const actorId = '64b000000000000000000112';
  let requestedFilter = null;
  const chain = (value) => ({
    populate() {
      return this;
    },
    async lean() {
      return value;
    },
  });

  try {
    Interview.findOne = (filter) => {
      requestedFilter = filter;
      return chain(null);
    };
    await assert.rejects(
      feedbackService.getOwnInterviewScorecard({
        companyId,
        interviewId: '64b000000000000000000120',
        actorId,
      }),
      (error) => error.statusCode === 404 && error.message === 'Interview not found'
    );
    assert.equal(String(requestedFilter.companyId), companyId);

    Interview.findOne = () =>
      chain({
        _id: '64b000000000000000000120',
        companyId,
        candidate: { _id: '64b000000000000000000121' },
        job: { _id: '64b000000000000000000122' },
        interviewers: [{ _id: '64b000000000000000000199' }],
        round: { category: 'TECHNICAL' },
        status: 'COMPLETED',
      });
    await assert.rejects(
      feedbackService.getOwnInterviewScorecard({
        companyId,
        interviewId: '64b000000000000000000120',
        actorId,
      }),
      (error) => error.statusCode === 403 && /not assigned/i.test(error.message)
    );
  } finally {
    Interview.findOne = originalFindOne;
  }
});

test('concurrent matching feedback submissions have one CAS winner and one idempotent response', async () => {
  const originalInterviewFindOne = Interview.findOne;
  const originalFeedbackFindOne = InterviewFeedback.findOne;
  const originalFeedbackFindOneAndUpdate = InterviewFeedback.findOneAndUpdate;
  const originalFeedbackFind = InterviewFeedback.find;
  const originalHistoryCreate = CandidateHistory.create;
  const originalAuditCreate = AuditLog.create;
  const actorId = '64b000000000000000000102';
  const otherInterviewerId = '64b000000000000000000103';
  const companyId = '64b000000000000000000111';
  const updatedAt = new Date('2026-08-24T08:00:00.000Z');
  const interview = {
    _id: '64b000000000000000000120',
    companyId,
    interviewCode: 'INT-000120',
    candidate: {
      _id: '64b000000000000000000121',
      candidateCode: 'CAN-000121',
      name: 'Candidate One',
    },
    job: {
      _id: '64b000000000000000000122',
      jobCode: 'JOB-000122',
      title: 'Engineer',
    },
    interviewers: [
      { _id: actorId, name: 'Interviewer One', role: 'EMPLOYEE' },
      { _id: otherInterviewerId, name: 'Interviewer Two', role: 'MANAGER' },
    ],
    round: { key: 'TECHNICAL_1', name: 'Technical Round 1', category: 'TECHNICAL' },
    status: 'COMPLETED',
  };
  let current = {
    _id: '64b000000000000000000130',
    companyId,
    interview: interview._id,
    candidate: interview.candidate._id,
    job: interview.job._id,
    interviewer: actorId,
    scorecardTemplate: '64b000000000000000000140',
    templateSnapshot,
    ratings: [],
    overallScore: null,
    maxOverallScore: 10,
    strengths: '',
    concerns: '',
    privateNotes: '',
    recommendation: '',
    status: 'DRAFT',
    submittedAt: null,
    updatedAt,
    lastEditedAt: updatedAt,
  };
  let draftWriters = 0;
  let releaseDraftWriters;
  const bothDraftsReady = new Promise((resolve) => {
    releaseDraftWriters = resolve;
  });
  let historyCreates = 0;
  let auditCreates = 0;
  let tenantFilterSeen = false;

  const chain = (value, wait = null) => ({
    populate() {
      return this;
    },
    select() {
      return this;
    },
    async lean() {
      if (wait) await wait;
      return value;
    },
  });

  try {
    Interview.findOne = (filter) => {
      tenantFilterSeen ||= String(filter.companyId) === companyId;
      return chain(interview);
    };
    InterviewFeedback.findOne = () => chain({ ...current });
    InterviewFeedback.findOneAndUpdate = (filter, update) => {
      if (!filter._id) {
        current = { ...current, ...update.$set, updatedAt };
        draftWriters += 1;
        if (draftWriters === 2) releaseDraftWriters();
        return chain({ ...current }, bothDraftsReady);
      }
      if (current.status !== 'DRAFT') return chain(null);
      current = { ...current, ...update.$set, updatedAt: new Date(updatedAt.getTime() + 1) };
      return chain({ ...current });
    };
    InterviewFeedback.find = () => ({
      distinct: async () => [actorId],
    });
    CandidateHistory.create = async () => {
      historyCreates += 1;
      return { _id: '64b000000000000000000150' };
    };
    AuditLog.create = async () => {
      auditCreates += 1;
      return { _id: '64b000000000000000000151' };
    };

    const input = { ...completeFeedback(), action: 'SUBMIT' };
    const [left, right] = await Promise.all([
      feedbackService.saveOwnInterviewFeedback({
        companyId,
        interviewId: interview._id,
        actor: { _id: actorId, name: 'Interviewer One', role: 'EMPLOYEE' },
        input,
        requestContext: null,
      }),
      feedbackService.saveOwnInterviewFeedback({
        companyId,
        interviewId: interview._id,
        actor: { _id: actorId, name: 'Interviewer One', role: 'EMPLOYEE' },
        input,
        requestContext: null,
      }),
    ]);

    assert.equal(left.status, 'SUBMITTED');
    assert.equal(right.status, 'SUBMITTED');
    assert.equal([left.idempotent, right.idempotent].filter(Boolean).length, 1);
    assert.equal(historyCreates, 1);
    assert.equal(auditCreates, 1);
    assert.equal(tenantFilterSeen, true);

    const retry = await feedbackService.saveOwnInterviewFeedback({
      companyId,
      interviewId: interview._id,
      actor: { _id: actorId, name: 'Interviewer One', role: 'EMPLOYEE' },
      input,
      requestContext: null,
    });
    assert.equal(retry.idempotent, true);
    assert.equal(historyCreates, 1);
  } finally {
    Interview.findOne = originalInterviewFindOne;
    InterviewFeedback.findOne = originalFeedbackFindOne;
    InterviewFeedback.findOneAndUpdate = originalFeedbackFindOneAndUpdate;
    InterviewFeedback.find = originalFeedbackFind;
    CandidateHistory.create = originalHistoryCreate;
    AuditLog.create = originalAuditCreate;
  }
});

test('a repeated matching final decision is idempotent and creates one pipeline and timeline history', async () => {
  const originals = {
    candidateFindOne: Candidate.findOne,
    candidateFindOneAndUpdate: Candidate.findOneAndUpdate,
    decisionFindOne: CandidateDecision.findOne,
    decisionCreate: CandidateDecision.create,
    decisionFindOneAndUpdate: CandidateDecision.findOneAndUpdate,
    decisionUpdateOne: CandidateDecision.updateOne,
    pipelineCreate: CandidatePipelineHistory.create,
    historyFindOne: CandidateHistory.findOne,
    historyCreate: CandidateHistory.create,
    auditCreate: AuditLog.create,
    userFind: User.find,
  };
  const companyId = '64b000000000000000000211';
  const candidateId = '64b000000000000000000212';
  const actorId = '64b000000000000000000213';
  let candidate = {
    _id: candidateId,
    candidateCode: 'CAN-000212',
    name: 'Candidate Decision',
    job: '64b000000000000000000214',
    currentStage: 'FINAL_REVIEW',
    stage: 'FINAL_REVIEW',
  };
  let operation = null;
  let pipelineCreates = 0;
  let timelineCreates = 0;
  let auditCreates = 0;

  const chain = (value) => ({
    select() {
      return this;
    },
    sort() {
      return this;
    },
    async lean() {
      return value;
    },
  });

  try {
    Candidate.findOne = (filter) => {
      assert.equal(String(filter.companyId), companyId);
      return chain({ ...candidate });
    };
    Candidate.findOneAndUpdate = (_filter, update) => {
      candidate = { ...candidate, ...update.$set };
      return chain({ ...candidate });
    };
    CandidateDecision.findOne = (filter) => {
      if (filter.status === 'COMPLETED') {
        return chain(operation?.status === 'COMPLETED' ? { ...operation } : null);
      }
      if (filter.activeOperationKey === 'FINAL_DECISION') {
        return chain(operation?.activeOperationKey === 'FINAL_DECISION' ? { ...operation } : null);
      }
      return chain(null);
    };
    CandidateDecision.create = async (value) => {
      operation = {
        _id: '64b000000000000000000215',
        ...value,
        pipelineHistory: null,
        candidateHistory: null,
        decidedAt: null,
      };
      return { toObject: () => ({ ...operation }) };
    };
    CandidateDecision.findOneAndUpdate = (_filter, update) => {
      if (!operation || operation.status === 'COMPLETED') return chain(null);
      operation = { ...operation, ...update.$set };
      if (update.$unset) {
        Object.keys(update.$unset).forEach((key) => delete operation[key]);
      }
      return chain({ ...operation });
    };
    CandidateDecision.updateOne = async (_filter, update) => {
      operation = { ...operation, ...update.$set };
      if (update.$unset) {
        Object.keys(update.$unset).forEach((key) => delete operation[key]);
      }
      return { modifiedCount: 1 };
    };
    CandidatePipelineHistory.create = async (value) => {
      pipelineCreates += 1;
      return {
        _id: '64b000000000000000000216',
        ...value,
        createdAt: new Date('2026-08-24T09:00:00.000Z'),
      };
    };
    CandidateHistory.findOne = () => chain(null);
    CandidateHistory.create = async (value) => {
      timelineCreates += 1;
      return { _id: '64b000000000000000000217', ...value };
    };
    AuditLog.create = async () => {
      auditCreates += 1;
      return { _id: '64b000000000000000000218' };
    };
    User.find = () => ({ select: async () => [] });

    const request = {
      companyId,
      candidateId,
      actor: { _id: actorId, name: 'HR Actor', role: 'HR_MANAGER' },
      input: {
        decision: 'SELECTED',
        reasonCategory: 'BEST_FIT',
        comment: 'Role evidence supports selection.',
      },
      requestContext: null,
    };
    const first = await candidateDecisionService.recordCandidateFinalDecision(request);
    const retry = await candidateDecisionService.recordCandidateFinalDecision(request);

    assert.equal(first.decision, 'SELECTED');
    assert.equal(first.idempotent, false);
    assert.equal(retry.idempotent, true);
    assert.equal(candidate.currentStage, 'SELECTED');
    assert.equal(pipelineCreates, 1);
    assert.equal(timelineCreates, 1);
    assert.equal(auditCreates, 2);
  } finally {
    Candidate.findOne = originals.candidateFindOne;
    Candidate.findOneAndUpdate = originals.candidateFindOneAndUpdate;
    CandidateDecision.findOne = originals.decisionFindOne;
    CandidateDecision.create = originals.decisionCreate;
    CandidateDecision.findOneAndUpdate = originals.decisionFindOneAndUpdate;
    CandidateDecision.updateOne = originals.decisionUpdateOne;
    CandidatePipelineHistory.create = originals.pipelineCreate;
    CandidateHistory.findOne = originals.historyFindOne;
    CandidateHistory.create = originals.historyCreate;
    AuditLog.create = originals.auditCreate;
    User.find = originals.userFind;
  }
});

test('routes and services enforce assignment, tenant, CAS locking and idempotent human decisions', async () => {
  const [
    routes,
    feedback,
    scorecards,
    decisions,
    pipeline,
    feedbackController,
    decisionController,
    candidateTimeline,
    permissionMiddleware,
  ] = await Promise.all([
    readFile(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/interviewFeedbackService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/interviewScorecardService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/candidateDecisionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/candidatePipelineService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/interviewFeedbackController.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/candidateDecisionController.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/candidateInboxService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/middlewares/permissionMiddleware.js', import.meta.url), 'utf8'),
  ]);

  const contracts = [
    ['/interviews/:id/scorecard', 'INTERVIEW_FEEDBACK_READ_SELF'],
    ['/interviews/:id/my-feedback', 'INTERVIEW_FEEDBACK_SUBMIT_SELF'],
    ['/interviews/:id/feedback', 'INTERVIEW_FEEDBACK_READ'],
    ['/candidates/:candidateId/final-review', 'CANDIDATE_FINAL_DECISION'],
    ['/candidates/:candidateId/final-decision', 'CANDIDATE_FINAL_DECISION'],
  ];
  for (const [path, permission] of contracts) {
    const routeIndex = routes.indexOf(`'${path}'`);
    const permissionIndex = routes.indexOf(`'${permission}'`, routeIndex);
    assert.notEqual(routeIndex, -1, `${path} must exist`);
    assert.equal(permissionIndex > routeIndex && permissionIndex - routeIndex < 420, true);
  }

  assert.match(feedback, /companyId,[\s\S]*interview: interview\._id,[\s\S]*interviewer: actor\._id/);
  assert.match(feedback, /isAssigned\(interview, actorId\)/);
  assert.match(feedback, /status: 'DRAFT',[\s\S]*updatedAt: draft\.updatedAt/);
  assert.match(feedback, /action: 'INTERVIEW_FEEDBACK_SUBMITTED'/);
  assert.equal(feedback.includes('deleteOne('), false);
  assert.equal(feedback.includes('findOneAndDelete'), false);
  assert.match(scorecards, /bulkWrite/);
  assert.match(scorecards, /TECHNICAL_DEFAULT/);
  assert.match(scorecards, /MANAGER_DEFAULT/);
  assert.match(scorecards, /HR_DEFAULT/);

  assert.match(decisions, /currentStage !== 'HR_FINAL'/);
  assert.match(decisions, /currentStage !== 'FINAL_REVIEW'/);
  assert.match(decisions, /claimToken/);
  assert.match(decisions, /activeOperationKey: 'FINAL_DECISION'/);
  assert.match(decisions, /idempotent: true/);
  assert.match(decisions, /Submit all assigned scorecards before Final Review/);
  assert.equal(decisions.includes('Offer'), false);
  assert.match(pipeline, /Use the authorized Final Review workflow/);
  assert.match(pipeline, /Use the authorized human-decision workflow to select/);
  assert.match(candidateTimeline, /recommendation/);
  assert.match(candidateTimeline, /reasonCategory/);
  assert.match(permissionMiddleware, /Platform roles cannot use customer-company permissions/);

  for (const controller of [feedbackController, decisionController]) {
    assert.match(controller, /Data from frontend - requests from frontend/);
    assert.match(controller, /DB Logic - DB logics/);
    assert.match(controller, /Data to frontend - response to frontend/);
  }
});

test('frontend exposes accessible scorecards, HR summaries and human Final Review without automatic offers', async () => {
  const [workspace, detail, candidate, scorecard, summary, finalReview, decisionModal, api] =
    await Promise.all([
      readFile(new URL('../../Frontend/src/pages/recruitment/InterviewsPage.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../../Frontend/src/components/recruitment/InterviewDetailModal.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../../Frontend/src/pages/recruitment/CandidateDetailPage.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../../Frontend/src/components/recruitment/InterviewFeedbackModal.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../../Frontend/src/components/recruitment/InterviewFeedbackSummary.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../../Frontend/src/components/recruitment/CandidateFinalReview.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../../Frontend/src/components/recruitment/FinalDecisionModal.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../../Frontend/src/services/recruitmentEvaluationService.js', import.meta.url), 'utf8'),
    ]);

  for (const source of [workspace, detail, candidate, scorecard, summary, finalReview, decisionModal]) {
    assert.equal(source.includes('dangerouslySetInnerHTML'), false);
  }
  assert.match(scorecard, /type="number"/);
  assert.match(scorecard, /Save draft/);
  assert.match(scorecard, /Confirm submission/);
  assert.match(scorecard, /Submitted and locked/);
  assert.match(summary, /roundAverage/);
  assert.match(summary, /individualFeedback/);
  assert.match(finalReview, /No composite hiring score/);
  assert.match(finalReview, /Begin Final Review/);
  assert.match(decisionModal, /protected-class information/);
  assert.match(api, /\/my-feedback/);
  assert.match(api, /\/final-decision/);
  assert.equal(finalReview.includes('createOffer'), false);
  assert.equal(api.includes('/offer'), false);
});
